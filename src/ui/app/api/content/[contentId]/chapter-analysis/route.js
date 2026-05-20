import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildContentAccessWhere } from "@/lib/access";
import { buildBackendUrl } from "@/lib/backend";
import { postToAnalysisService } from "@/lib/analysis-service";

function getChapterAnalysisEndpoint() {
  const configured = process.env.CHAPTER_ANALYSIS_ENDPOINT;
  if (configured && typeof configured === "string" && configured.trim().length) {
    return configured.trim();
  }
  return buildBackendUrl("/analysis/chapter-analysis");
}

function cloneProcessingMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  return JSON.parse(JSON.stringify(metadata));
}

function getCobraMetadata(metadata) {
  const clone = cloneProcessingMetadata(metadata);
  const cobra = typeof clone.cobra === "object" && clone.cobra !== null ? clone.cobra : {};
  clone.cobra = cobra;
  return { clone, cobra };
}

function buildDisplayName(session, content) {
  return (
    session.user.name ||
    session.user.email ||
    content.uploadedBy?.name ||
    content.uploadedBy?.email ||
    "Unknown user"
  );
}

function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function resolveVideoSource(cobraMeta, content) {
  const candidates = [
    cobraMeta?.videoUrl,
    cobraMeta?.storageUrl,
    content?.videoUrl,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate.trim();
    }
  }

  return null;
}

function resolveManifestReference(cobraMeta) {
  if (!cobraMeta || typeof cobraMeta !== "object") {
    return null;
  }

  const candidates = [
    cobraMeta.manifestUrl,
    cobraMeta.manifestPath,
    cobraMeta?.actionSummary?.storageArtifacts?.manifest,
    cobraMeta?.chapterAnalysis?.storageArtifacts?.manifest,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate.trim();
    }
  }

  return null;
}

function buildRequestPayload({ content, session, cobraMeta }) {
  const videoSource = resolveVideoSource(cobraMeta, content);
  const manifestReference = resolveManifestReference(cobraMeta);

  const payload = {
    video_path: videoSource,
    manifest_path: manifestReference ?? null,
    organization: content.organizationId,
    organization_name: content.organization?.name ?? undefined,
    collection: content.collectionId,
    collection_name: content.collection?.name ?? undefined,
    user: session.user.id,
    user_name: buildDisplayName(session, content),
    video_id: content.id,
    video_url: videoSource,
  };

  if (manifestReference && !isHttpUrl(manifestReference)) {
    payload.skip_preprocess = true;
  }

  return payload;
}

export async function POST(_request, { params }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentId = params?.contentId;
  if (!contentId) {
    return NextResponse.json({ error: "Content id is required" }, { status: 400 });
  }

  const content = await prisma.content.findFirst({
    where: buildContentAccessWhere(session.user, contentId),
    include: {
      organization: true,
      collection: true,
      uploadedBy: true,
    },
  });

  if (!content) {
    return NextResponse.json({ error: "Content not found" }, { status: 404 });
  }

  const { clone: processingMetadata, cobra: cobraMeta } = getCobraMetadata(
    content.processingMetadata,
  );

  const videoSource = resolveVideoSource(cobraMeta, content);
  if (!videoSource) {
    return NextResponse.json(
      {
        error:
          "The uploaded video is missing from the processing service. Re-upload the video before running analyses.",
      },
      { status: 400 },
    );
  }

  const now = new Date();
  cobraMeta.lastChapterAnalysisRequestedAt = now.toISOString();
  processingMetadata.cobra = cobraMeta;

  await prisma.content.update({
    where: { id: content.id },
    data: {
      chapterAnalysisStatus: "PROCESSING",
      analysisRequestedAt: now,
      processingMetadata,
    },
  });

  let requestResult;
  try {
    requestResult = await postToAnalysisService(
      getChapterAnalysisEndpoint(),
      buildRequestPayload({ content, session, cobraMeta }),
    );
  } catch (error) {
    cobraMeta.chapterAnalysis = {
      lastRunAt: new Date().toISOString(),
      status: "FAILED",
      error: error.message,
    };
    processingMetadata.cobra = cobraMeta;

    await prisma.content.update({
      where: { id: content.id },
      data: {
        chapterAnalysisStatus: "FAILED",
        processingMetadata,
      },
    });

    return NextResponse.json({ error: "Failed to contact the analysis service." }, { status: 502 });
  }

  const { ok, status, data } = requestResult;

  if (!ok) {
    const errorMessage =
      data?.detail ||
      data?.error ||
      data?.message ||
      "Chapter analysis request failed";

    cobraMeta.chapterAnalysis = {
      lastRunAt: new Date().toISOString(),
      status: "FAILED",
      error: errorMessage,
    };
    processingMetadata.cobra = cobraMeta;

    await prisma.content.update({
      where: { id: content.id },
      data: {
        chapterAnalysisStatus: "FAILED",
        processingMetadata,
      },
    });

    return NextResponse.json({ error: errorMessage }, { status: status || 500 });
  }

  const manifestUrlFromResponse =
    (data?.storage_artifacts && data.storage_artifacts.manifest) ||
    (typeof data?.manifest_path === "string" && isHttpUrl(data.manifest_path)
      ? data.manifest_path
      : null);

  if (manifestUrlFromResponse) {
    cobraMeta.manifestUrl = manifestUrlFromResponse;
    cobraMeta.manifestPath = manifestUrlFromResponse;
  } else if (cobraMeta.manifestUrl) {
    cobraMeta.manifestPath = cobraMeta.manifestUrl;
  } else if (cobraMeta.manifestPath && isHttpUrl(cobraMeta.manifestPath)) {
    cobraMeta.manifestUrl = cobraMeta.manifestPath;
  } else {
    cobraMeta.manifestUrl = null;
    cobraMeta.manifestPath = null;
  }
  const analysisResult =
    data?.result !== undefined && data?.result !== null
      ? data.result
      : data?.analysis ?? null;

  cobraMeta.chapterAnalysis = {
    lastRunAt: new Date().toISOString(),
    status: "COMPLETED",
    analysis: analysisResult,
    analysisOutputPath: data?.analysis_output_path ?? null,
    storageArtifacts: data?.storage_artifacts ?? null,
    filters: {
      organizationId: content.organizationId,
      collectionId: content.collectionId,
      contentId: content.id,
    },
  };
  processingMetadata.cobra = cobraMeta;

  await prisma.content.update({
    where: { id: content.id },
    data: {
      chapterAnalysisStatus: "COMPLETED",
      processingMetadata,
    },
  });

  return NextResponse.json(
    {
      analysis: analysisResult,
      manifestPath: manifestUrlFromResponse ?? cobraMeta.manifestUrl ?? null,
      analysisOutputPath: data?.analysis_output_path ?? null,
      storageArtifacts: data?.storage_artifacts ?? null,
      filters: {
        organizationId: content.organizationId,
        collectionId: content.collectionId,
        contentId: content.id,
      },
    },
    { status: 200 },
  );
}
