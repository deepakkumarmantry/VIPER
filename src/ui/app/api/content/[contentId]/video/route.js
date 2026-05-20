import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";

import prisma from "@/lib/prisma";
import { buildContentAccessWhere } from "@/lib/access";
import { getBlobServiceClient, parseBlobUrl } from "@/lib/azure-storage";

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

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || typeof rangeHeader !== "string") {
    return null;
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) {
    return null;
  }

  const rangeValue = trimmed.slice(6).split(",")[0].trim();
  const [startPart, endPart] = rangeValue.split("-");

  if (!startPart && !endPart) {
    return null;
  }

  if (!size && size !== 0) {
    return null;
  }

  let start;
  let end;

  if (!startPart) {
    const suffixLength = Number.parseInt(endPart, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    if (suffixLength >= size) {
      start = 0;
    } else {
      start = size - suffixLength;
    }
    end = size - 1;
  } else {
    start = Number.parseInt(startPart, 10);
    if (!Number.isFinite(start) || start < 0) {
      return null;
    }

    if (!endPart) {
      end = size - 1;
    } else {
      end = Number.parseInt(endPart, 10);
      if (!Number.isFinite(end) || end < start) {
        return null;
      }
    }

    if (start >= size) {
      return { invalid: true };
    }

    if (end >= size) {
      end = size - 1;
    }
  }

  if (start > end) {
    return { invalid: true };
  }

  return { start, end };
}

export async function GET(request, { params }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentId = params?.contentId;
  if (!contentId) {
    return NextResponse.json({ error: "Content id is required" }, { status: 400 });
  }

  const accessibleContent = await prisma.content.findFirst({
    where: buildContentAccessWhere(session.user, contentId),
    select: {
      id: true,
      videoUrl: true,
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

  const videoUrl = accessibleContent.videoUrl;
  if (typeof videoUrl !== "string" || !videoUrl.trim().length) {
    return NextResponse.json({ error: "Video not available" }, { status: 404 });
  }

  const blobReference = parseBlobUrl(videoUrl.trim());
  if (!blobReference) {
    return NextResponse.json({ error: "Video not available" }, { status: 404 });
  }

  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(blobReference.container);
  const blobClient = containerClient.getBlobClient(blobReference.blobName);

  let properties;
  try {
    properties = await blobClient.getProperties();
  } catch (error) {
    if (error?.statusCode === 404) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    console.error("[content] Failed to read blob properties", {
      error,
      contentId,
      blob: blobReference,
    });
    return NextResponse.json({ error: "Failed to load video" }, { status: 500 });
  }

  const blobSize = Number(properties?.contentLength ?? 0);
  if (!Number.isFinite(blobSize) || blobSize < 0) {
    return NextResponse.json({ error: "Video not available" }, { status: 404 });
  }

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", properties?.contentType || "application/octet-stream");

  const rangeHeader = request.headers.get("range");
  const range = parseRangeHeader(rangeHeader, blobSize);

  if (range?.invalid) {
    const invalidHeaders = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${blobSize}`,
    });
    return new NextResponse(null, { status: 416, headers: invalidHeaders });
  }

  if (rangeHeader && !range) {
    const invalidHeaders = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${blobSize}`,
    });
    return new NextResponse(null, { status: 416, headers: invalidHeaders });
  }

  let downloadResponse;
  let status = 200;

  try {
    if (range) {
      const chunkSize = range.end - range.start + 1;
      downloadResponse = await blobClient.download(range.start, chunkSize);
      headers.set("Content-Length", String(chunkSize));
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${blobSize}`);
      status = 206;
    } else {
      downloadResponse = await blobClient.download(0);
      headers.set("Content-Length", String(blobSize));
    }
  } catch (error) {
    if (error?.statusCode === 404) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    console.error("[content] Failed to download blob", {
      error,
      contentId,
      blob: blobReference,
      range: rangeHeader,
    });
    return NextResponse.json({ error: "Failed to load video" }, { status: 500 });
  }

  const stream = nodeStreamToWeb(downloadResponse?.readableStreamBody ?? null);
  if (!stream) {
    return NextResponse.json({ error: "Failed to stream video" }, { status: 500 });
  }

  return new NextResponse(stream, {
    status,
    headers,
  });
}
