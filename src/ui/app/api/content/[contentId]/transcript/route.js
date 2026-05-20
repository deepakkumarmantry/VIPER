import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";

import prisma from "@/lib/prisma";
import { buildContentAccessWhere } from "@/lib/access";
import { getBlobServiceClient, parseBlobUrl } from "@/lib/azure-storage";
import { collectBlobUrls } from "@/lib/content-cleanup";

function nodeStreamToWeb(stream) {
  if (!stream) {
    return null;
  }

  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
    },
    cancel() {
      stream.destroy();
    },
  });
}

function normalizeProcessingMetadata(metadata) {
  if (!metadata) {
    return null;
  }

  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch (error) {
      return null;
    }
  }

  if (typeof metadata === "object") {
    return metadata;
  }

  return null;
}

function collectTranscriptStrings(value, results = new Set(), visited = new Set(), underTranscriptKey = false) {
  if (value == null) {
    return results;
  }

  if (typeof value === "string") {
    if (underTranscriptKey) {
      const trimmed = value.trim();
      if (trimmed.length) {
        results.add(trimmed);
      }
    }
    return results;
  }

  if (typeof value !== "object") {
    return results;
  }

  if (visited.has(value)) {
    return results;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectTranscriptStrings(item, results, visited, underTranscriptKey));
    return results;
  }

  Object.entries(value).forEach(([key, entry]) => {
    const isTranscriptKey =
      typeof key === "string" &&
      (key.toLowerCase().includes("transcript") || key.toLowerCase().includes("transcription"));

    collectTranscriptStrings(entry, results, visited, underTranscriptKey || isTranscriptKey);
  });

  return results;
}

function findTranscriptBlobReference(processingMetadata) {
  const normalized = normalizeProcessingMetadata(processingMetadata);
  const cobraMeta = normalized && typeof normalized === "object" ? normalized.cobra ?? normalized : null;

  const candidateStrings = collectTranscriptStrings(cobraMeta);
  for (const candidate of candidateStrings) {
    const parsed = parseBlobUrl(candidate);
    if (parsed) {
      return { ...parsed, url: candidate };
    }
  }

  const blobUrls = collectBlobUrls(normalized ?? {});
  for (const url of blobUrls) {
    const lower = url.toLowerCase();
    if (!lower.includes("transcript") && !lower.includes("transcription")) {
      continue;
    }
    const parsed = parseBlobUrl(url);
    if (parsed) {
      return { ...parsed, url };
    }
  }

  return null;
}

function parseHttpDate(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp);
}

function normalizeETag(tag) {
  if (!tag) {
    return null;
  }
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed;
}

function etagMatches(etag, headerValue) {
  if (!etag || !headerValue) {
    return false;
  }

  const normalizedEtag = normalizeETag(etag);
  if (!normalizedEtag) {
    return false;
  }

  const tags = headerValue
    .split(",")
    .map((item) => normalizeETag(item))
    .filter(Boolean);

  if (!tags.length) {
    return false;
  }

  if (tags.includes("*")) {
    return true;
  }

  const strip = (value) => {
    const withoutWeak = value.replace(/^W\//i, "");
    if (withoutWeak.length >= 2 && withoutWeak.startsWith('"') && withoutWeak.endsWith('"')) {
      return withoutWeak.slice(1, -1);
    }
    return withoutWeak;
  };

  const target = strip(normalizedEtag);
  return tags.some((candidate) => {
    const strippedCandidate = strip(candidate);
    return strippedCandidate === target;
  });
}

export async function GET(request, { params }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentId = params?.contentId;
  if (!contentId || typeof contentId !== "string") {
    return NextResponse.json({ error: "Content id is required" }, { status: 400 });
  }

  const accessibleContent = await prisma.content.findFirst({
    where: buildContentAccessWhere(session.user, contentId),
    select: {
      id: true,
      processingMetadata: true,
    },
  });

  if (!accessibleContent) {
    const existingContent = await prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true },
    });

    if (existingContent) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ error: "Content not found" }, { status: 404 });
  }

  const transcriptReference = findTranscriptBlobReference(accessibleContent.processingMetadata);
  if (!transcriptReference) {
    return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
  }

  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(transcriptReference.container);
  const blobClient = containerClient.getBlobClient(transcriptReference.blobName);

  let properties;
  try {
    properties = await blobClient.getProperties();
  } catch (error) {
    if (error?.statusCode === 404) {
      return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
    }

    console.error("[content:transcript] Failed to read blob properties", {
      error,
      contentId,
      blob: transcriptReference,
    });
    return NextResponse.json({ error: "Failed to load transcript" }, { status: 500 });
  }

  const headers = new Headers();
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  headers.set("Vary", "Authorization");

  const etag = properties?.etag ?? null;
  if (etag) {
    headers.set("ETag", etag);
  }

  const lastModified = properties?.lastModified instanceof Date ? properties.lastModified : null;
  if (lastModified) {
    headers.set("Last-Modified", lastModified.toUTCString());
  }

  const ifMatch = request.headers.get("if-match");
  if (ifMatch) {
    if (!etagMatches(etag, ifMatch)) {
      return new NextResponse(null, { status: 412, headers });
    }
  }

  const ifUnmodifiedSince = request.headers.get("if-unmodified-since");
  if (ifUnmodifiedSince && lastModified) {
    const ifUnmodifiedDate = parseHttpDate(ifUnmodifiedSince);
    if (ifUnmodifiedDate && lastModified > ifUnmodifiedDate) {
      return new NextResponse(null, { status: 412, headers });
    }
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && etagMatches(etag, ifNoneMatch)) {
    return new NextResponse(null, { status: 304, headers });
  }

  const ifModifiedSince = request.headers.get("if-modified-since");
  if (!ifNoneMatch && ifModifiedSince && lastModified) {
    const ifModifiedDate = parseHttpDate(ifModifiedSince);
    if (ifModifiedDate && lastModified <= ifModifiedDate) {
      return new NextResponse(null, { status: 304, headers });
    }
  }

  let downloadResponse;
  try {
    downloadResponse = await blobClient.download(0);
  } catch (error) {
    if (error?.statusCode === 404) {
      return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
    }

    console.error("[content:transcript] Failed to download blob", {
      error,
      contentId,
      blob: transcriptReference,
    });
    return NextResponse.json({ error: "Failed to load transcript" }, { status: 500 });
  }

  const stream = nodeStreamToWeb(downloadResponse?.readableStreamBody);
  if (!stream) {
    return NextResponse.json({ error: "Transcript not available" }, { status: 404 });
  }

  const contentLength = Number.parseInt(properties?.contentLength ?? downloadResponse?.contentLength ?? 0, 10);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    headers.set("Content-Length", String(contentLength));
  }

  const contentType = properties?.contentType;
  if (contentType && typeof contentType === "string" && contentType.trim().length) {
    headers.set("Content-Type", contentType);
  } else {
    headers.set("Content-Type", "application/json");
  }

  return new NextResponse(stream, { status: 200, headers });
}
