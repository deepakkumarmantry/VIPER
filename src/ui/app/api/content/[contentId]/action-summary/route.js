import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildContentAccessWhere } from "@/lib/access";
import { buildBackendUrl } from "@/lib/backend";
import { postToAnalysisService } from "@/lib/analysis-service";
import {
  collectBlobUrls,
  collectSearchDocumentIds,
  deleteBlobUrls,
  deleteSearchDocuments,
} from "@/lib/content-cleanup";

function getActionSummaryEndpoint() {
  const configured = process.env.ACTION_SUMMARY_ENDPOINT;
  if (configured && typeof configured === "string" && configured.trim().length) {
    return configured.trim();
  }
  return buildBackendUrl("/analysis/action-summary");
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

function createActionSummaryRunId() {
  try {
    return randomUUID();
  } catch (error) {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function normalizeActionSummaryRun(run) {
  if (!run || typeof run !== "object") {
    return null;
  }

  let wasMigrated = false;

  let id = null;
  if (typeof run.id === "string" && run.id.trim().length) {
    id = run.id.trim();
  } else if (typeof run.runId === "string" && run.runId.trim().length) {
    id = run.runId.trim();
    wasMigrated = true;
  } else {
    id = createActionSummaryRunId();
    wasMigrated = true;
  }

  const name =
    typeof run.name === "string" && run.name.trim().length
      ? run.name.trim()
      : typeof run.label === "string" && run.label.trim().length
        ? run.label.trim()
        : null;

  const analysisOutputPath =
    run.analysisOutputPath ?? run.analysis_output_path ?? null;

  const storageArtifacts =
    run.storageArtifacts ?? run.storage_artifacts ?? null;

  const searchUploads = Array.isArray(run.searchUploads)
    ? run.searchUploads
    : Array.isArray(run.search_uploads)
      ? run.search_uploads
      : [];

  const analysisTemplate =
    run.analysisTemplate ?? run.analysis_template ?? null;

  const manifestPath = run.manifestPath ?? run.manifest_path ?? null;
  const manifestUrl =
    run.manifestUrl ?? run.manifest_url ?? manifestPath ?? null;

  const createdAt =
    run.createdAt ?? run.requestedAt ?? run.lastRunAt ?? run.completedAt ?? null;
  const requestedAt = run.requestedAt ?? run.createdAt ?? null;
  const completedAt = run.completedAt ?? run.lastRunAt ?? createdAt ?? null;

  const analysisPayload =
    run.result !== undefined && run.result !== null
      ? run.result
      : run.analysis ?? null;

  const normalized = {
    id,
    name,
    analysis: analysisPayload,
    analysisOutputPath,
    storageArtifacts,
    searchUploads,
    filters: run.filters ?? null,
    config:
      run.config && typeof run.config === "object"
        ? run.config
        : run.config ?? null,
    analysisTemplate,
    manifestPath,
    manifestUrl,
    createdAt,
    requestedAt,
    completedAt,
    result:
      run.result !== undefined && run.result !== null
        ? run.result
        : analysisPayload,
  };

  Object.entries(run).forEach(([key, value]) => {
    if (
      key in normalized ||
      [
        "analysis_output_path",
        "storage_artifacts",
        "search_uploads",
        "manifest_path",
        "manifest_url",
        "runId",
      ].includes(key)
    ) {
      return;
    }
    normalized[key] = value;
  });

  if (
    run.analysis_output_path !== undefined ||
    run.storage_artifacts !== undefined ||
    run.search_uploads !== undefined ||
    run.manifest_path !== undefined ||
    run.manifest_url !== undefined
  ) {
    wasMigrated = true;
  }

  normalized._wasMigrated = wasMigrated;
  return normalized;
}

function buildLegacyRunFromMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== "object") {
    return null;
  }

  const hasLegacyData =
    rawMeta.result != null ||
    rawMeta.analysis != null ||
    rawMeta.analysisOutputPath != null ||
    rawMeta.analysis_output_path != null ||
    rawMeta.storageArtifacts != null ||
    rawMeta.storage_artifacts != null ||
    (Array.isArray(rawMeta.searchUploads) && rawMeta.searchUploads.length) ||
    (Array.isArray(rawMeta.search_uploads) && rawMeta.search_uploads.length);

  if (!hasLegacyData) {
    return null;
  }

  const legacyRun = normalizeActionSummaryRun({
    id: rawMeta.id,
    name: rawMeta.name,
    analysis: rawMeta.result ?? rawMeta.analysis ?? null,
    analysisOutputPath:
      rawMeta.analysisOutputPath ?? rawMeta.analysis_output_path ?? null,
    storageArtifacts:
      rawMeta.storageArtifacts ?? rawMeta.storage_artifacts ?? null,
    searchUploads: rawMeta.searchUploads ?? rawMeta.search_uploads ?? [],
    filters: rawMeta.filters ?? null,
    config: rawMeta.config ?? null,
    analysisTemplate:
      rawMeta.analysisTemplate ?? rawMeta.analysis_template ?? null,
    manifestPath: rawMeta.manifestPath ?? rawMeta.manifest_path ?? null,
    manifestUrl: rawMeta.manifestUrl ?? rawMeta.manifest_url ?? null,
    createdAt: rawMeta.createdAt ?? null,
    requestedAt: rawMeta.requestedAt ?? null,
    completedAt: rawMeta.lastRunAt ?? rawMeta.completedAt ?? null,
    lastRunAt: rawMeta.lastRunAt ?? null,
    result: rawMeta.result ?? rawMeta.analysis ?? null,
  });

  if (!legacyRun) {
    return null;
  }

  legacyRun._wasMigrated = true;
  return legacyRun;
}

function normalizeActionSummaryMeta(rawMeta) {
  const meta = {
    config: null,
    analysisTemplate: null,
    runs: [],
    activeRunId: null,
    lastRunAt: null,
    manifestPath: null,
    manifestUrl: null,
    filters: null,
  };

  let changed = false;

  if (rawMeta && typeof rawMeta === "object") {
    if (rawMeta.config != null) {
      meta.config = rawMeta.config;
    }

    if (rawMeta.analysisTemplate != null) {
      meta.analysisTemplate = rawMeta.analysisTemplate;
    } else if (rawMeta.analysis_template != null) {
      meta.analysisTemplate = rawMeta.analysis_template;
      changed = true;
    }

    if (rawMeta.filters != null) {
      meta.filters = rawMeta.filters;
    }

    if (rawMeta.manifestPath != null) {
      meta.manifestPath = rawMeta.manifestPath;
    } else if (rawMeta.manifest_path != null) {
      meta.manifestPath = rawMeta.manifest_path;
      changed = true;
    }

    if (rawMeta.manifestUrl != null) {
      meta.manifestUrl = rawMeta.manifestUrl;
    } else if (rawMeta.manifest_url != null) {
      meta.manifestUrl = rawMeta.manifest_url;
      changed = true;
    }

    if (rawMeta.lastRunAt != null) {
      meta.lastRunAt = rawMeta.lastRunAt;
    } else if (rawMeta.last_run_at != null) {
      meta.lastRunAt = rawMeta.last_run_at;
      changed = true;
    }

    if (typeof rawMeta.activeRunId === "string" && rawMeta.activeRunId.trim().length) {
      meta.activeRunId = rawMeta.activeRunId.trim();
    }
  }

  const normalizedRuns = [];
  if (Array.isArray(rawMeta?.runs)) {
    rawMeta.runs.forEach((run) => {
      const normalized = normalizeActionSummaryRun(run);
      if (!normalized) {
        return;
      }
      normalizedRuns.push(normalized);
      if (normalized._wasMigrated) {
        changed = true;
      }
    });
  }

  if (!normalizedRuns.length) {
    const legacyRun = buildLegacyRunFromMeta(rawMeta);
    if (legacyRun) {
      normalizedRuns.push(legacyRun);
      changed = true;
    }
  }

  if (!meta.analysisTemplate) {
    const templateRun = normalizedRuns.find((run) => run.analysisTemplate);
    if (templateRun?.analysisTemplate) {
      meta.analysisTemplate = templateRun.analysisTemplate;
    }
  }

  if (!meta.config) {
    const configRun = normalizedRuns.find(
      (run) => run.config && typeof run.config === "object",
    );
    if (configRun) {
      meta.config = configRun.config;
    }
  }

  if (!meta.filters) {
    const filterRun = normalizedRuns.find((run) => run.filters);
    if (filterRun?.filters) {
      meta.filters = filterRun.filters;
    }
  }

  if (normalizedRuns.length) {
    const seen = new Set();
    const deduped = [];
    normalizedRuns.forEach((run) => {
      if (seen.has(run.id)) {
        changed = true;
        return;
      }
      seen.add(run.id);
      deduped.push(run);
    });

    meta.runs = deduped.map((run) => {
      const { _wasMigrated, ...rest } = run;
      return rest;
    });

    if (!meta.activeRunId || !deduped.some((run) => run.id === meta.activeRunId)) {
      const fallback = deduped[deduped.length - 1];
      meta.activeRunId = fallback?.id ?? null;
      changed = true;
    }

    if (!meta.lastRunAt) {
      const active =
        deduped.find((run) => run.id === meta.activeRunId) ??
        deduped[deduped.length - 1];
      meta.lastRunAt = active?.completedAt ?? active?.createdAt ?? null;
    }

    if (!meta.manifestPath) {
      const active =
        deduped.find((run) => run.id === meta.activeRunId) ??
        deduped[deduped.length - 1];
      meta.manifestPath = active?.manifestPath ?? null;
    }

    if (!meta.manifestUrl) {
      const active =
        deduped.find((run) => run.id === meta.activeRunId) ??
        deduped[deduped.length - 1];
      meta.manifestUrl = active?.manifestUrl ?? meta.manifestPath ?? null;
    }
  } else {
    meta.runs = [];
    meta.activeRunId = null;
    meta.lastRunAt = null;
  }

  return { meta, changed };
}

function ensureActionSummaryMeta(cobraMeta) {
  if (!cobraMeta || typeof cobraMeta !== "object") {
    return { meta: normalizeActionSummaryMeta(null).meta, changed: false };
  }

  const { meta, changed } = normalizeActionSummaryMeta(cobraMeta.actionSummary);
  cobraMeta.actionSummary = meta;
  return { meta, changed };
}

function getActionSummaryRun(meta, runId) {
  if (!meta || !Array.isArray(meta.runs) || !runId) {
    return null;
  }

  return meta.runs.find((run) => run.id === runId) ?? null;
}

function getActiveActionSummaryRun(meta) {
  if (!meta || !Array.isArray(meta.runs) || !meta.runs.length) {
    return null;
  }

  if (meta.activeRunId) {
    return meta.runs.find((run) => run.id === meta.activeRunId) ?? meta.runs.at(-1);
  }

  return meta.runs.at(-1);
}

function removeActionSummaryRun(meta, runId) {
  if (!meta || !Array.isArray(meta.runs)) {
    return { removed: null, runs: [] };
  }

  const runs = meta.runs.slice();
  const index = runs.findIndex((run) => run.id === runId);
  if (index === -1) {
    return { removed: null, runs };
  }

  const [removed] = runs.splice(index, 1);
  return { removed, runs };
}

function coercePositiveInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const intValue = Math.floor(value);
    return intValue > 0 ? intValue : null;
  }

  if (typeof value === "string" && value.trim().length) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
  }

  return null;
}

function coercePositiveNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? value : null;
  }

  if (typeof value === "string" && value.trim().length) {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
  }

  return null;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function normalizeAnalysisTemplate(template) {
  if (!Array.isArray(template)) {
    return null;
  }

  const normalized = template
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const normalizedEntry = {};
      Object.entries(entry).forEach(([rawKey, rawValue]) => {
        if (typeof rawKey !== "string") {
          return;
        }

        const key = rawKey.trim();
        if (!key) {
          return;
        }

        if (typeof rawValue === "string") {
          normalizedEntry[key] = rawValue;
        } else if (rawValue == null) {
          normalizedEntry[key] = "";
        } else {
          try {
            normalizedEntry[key] = JSON.stringify(rawValue);
          } catch (error) {
            normalizedEntry[key] = String(rawValue);
          }
        }
      });

      return Object.keys(normalizedEntry).length ? normalizedEntry : null;
    })
    .filter(Boolean);

  return normalized.length ? normalized : null;
}

const DEFAULT_ACTION_SUMMARY_CONFIG = {
  segment_length: 10,
  fps: 1,
  max_workers: null,
  run_async: true,

  overwrite_output: true,

  reprocess_segments: false,
  generate_transcripts: true,
  trim_to_nearest_second: false,
  allow_partial_segments: true,
  upload_to_azure: true,
  skip_preprocess: false,
  output_directory: null,
  lens_prompt: null,
};

function sanitizeActionSummaryConfigOverride(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const sanitized = {};

  const segmentLength = coercePositiveInteger(
    config.segment_length ?? config.segmentLength,
  );
  if (segmentLength != null) {
    sanitized.segment_length = segmentLength;
  }

  const fps = coercePositiveNumber(config.fps);
  if (fps != null) {
    sanitized.fps = fps;

  }

  if (
    Object.prototype.hasOwnProperty.call(config, "max_workers") ||
    Object.prototype.hasOwnProperty.call(config, "maxWorkers")
  ) {
    const maxWorkersValue = config.max_workers ?? config.maxWorkers;
    const maxWorkers = coercePositiveInteger(maxWorkersValue);
    sanitized.max_workers = maxWorkers != null ? maxWorkers : null;
  }

  if (
    Object.prototype.hasOwnProperty.call(config, "output_directory") ||
    Object.prototype.hasOwnProperty.call(config, "outputDirectory")
  ) {
    const outputDirectory = config.output_directory ?? config.outputDirectory;
    if (typeof outputDirectory === "string" && outputDirectory.trim().length) {
      sanitized.output_directory = outputDirectory.trim();
    } else {
      sanitized.output_directory = null;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(config, "lens_prompt") ||
    Object.prototype.hasOwnProperty.call(config, "lensPrompt")
  ) {
    const lensValue = config.lens_prompt ?? config.lensPrompt;
    if (typeof lensValue === "string") {
      const trimmedLens = lensValue.trim();
      sanitized.lens_prompt = trimmedLens.length ? trimmedLens : null;
    } else if (lensValue == null) {
      sanitized.lens_prompt = null;
    }
  }

  const booleanFields = [
    ["run_async", config.run_async ?? config.runAsync],
    ["overwrite_output", config.overwrite_output ?? config.overwriteOutput],
    ["reprocess_segments", config.reprocess_segments ?? config.reprocessSegments],
    [
      "generate_transcripts",
      config.generate_transcripts ?? config.generateTranscripts,
    ],
    [
      "trim_to_nearest_second",
      config.trim_to_nearest_second ?? config.trimToNearestSecond,
    ],
    [
      "allow_partial_segments",
      config.allow_partial_segments ?? config.allowPartialSegments,
    ],
    ["upload_to_azure", config.upload_to_azure ?? config.uploadToAzure],
    ["skip_preprocess", config.skip_preprocess ?? config.skipPreprocess],
  ];

  booleanFields.forEach(([key, value]) => {
    const coerced = coerceBoolean(value);
    if (coerced != null) {
      sanitized[key] = coerced;
    }
  });

  return Object.keys(sanitized).length ? sanitized : null;
}

function buildNormalizedActionSummaryConfig({ cobraMeta, configOverride }) {
  const manifestReference = resolveManifestReference(cobraMeta);
  const base = {
    ...DEFAULT_ACTION_SUMMARY_CONFIG,
    skip_preprocess:
      manifestReference && !isHttpUrl(manifestReference)
        ? true
        : DEFAULT_ACTION_SUMMARY_CONFIG.skip_preprocess,
  };

  const sources = [
    { data: cobraMeta?.uploadMetadata, allowFps: false },
    { data: cobraMeta?.actionSummary?.config, allowFps: true },
    { data: configOverride, allowFps: true },
  ];

  sources.forEach(({ data, allowFps }) => {
    if (!data || typeof data !== "object") {

      return;
    }

    const segmentLength = coercePositiveInteger(

      data.segment_length ?? data.segmentLength,

    );
    if (segmentLength != null) {
      base.segment_length = segmentLength;
    }


    const fps = coercePositiveNumber(data.fps);
    if (allowFps && fps != null) {

      base.fps = fps;
    }

    if (

      Object.prototype.hasOwnProperty.call(data, "max_workers") ||
      Object.prototype.hasOwnProperty.call(data, "maxWorkers")
    ) {
      const maxWorkers = coercePositiveInteger(
        data.max_workers ?? data.maxWorkers,

      );
      base.max_workers = maxWorkers != null ? maxWorkers : null;
    }

    if (
      Object.prototype.hasOwnProperty.call(data, "output_directory") ||
      Object.prototype.hasOwnProperty.call(data, "outputDirectory")
    ) {
      const outputDirectory =
        data.output_directory ?? data.outputDirectory ?? null;

      if (typeof outputDirectory === "string" && outputDirectory.trim().length) {
        base.output_directory = outputDirectory.trim();
      } else {
        base.output_directory = null;
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(data, "lens_prompt") ||
      Object.prototype.hasOwnProperty.call(data, "lensPrompt")
    ) {
      const lensValue = data.lens_prompt ?? data.lensPrompt;

      if (typeof lensValue === "string" && lensValue.trim().length) {
        base.lens_prompt = lensValue.trim();
      } else if (lensValue == null) {
        base.lens_prompt = null;
      }
    }

    const booleanFields = [

      ["run_async", data.run_async ?? data.runAsync],
      ["overwrite_output", data.overwrite_output ?? data.overwriteOutput],
      [
        "reprocess_segments",
        data.reprocess_segments ?? data.reprocessSegments,
      ],
      [
        "generate_transcripts",
        data.generate_transcripts ?? data.generateTranscripts,
      ],
      [
        "trim_to_nearest_second",
        data.trim_to_nearest_second ?? data.trimToNearestSecond,
      ],
      [
        "allow_partial_segments",
        data.allow_partial_segments ?? data.allowPartialSegments,
      ],
      ["upload_to_azure", data.upload_to_azure ?? data.uploadToAzure],
      ["skip_preprocess", data.skip_preprocess ?? data.skipPreprocess],

    ];

    booleanFields.forEach(([key, value]) => {
      const coerced = coerceBoolean(value);
      if (coerced != null) {
        base[key] = coerced;
      }
    });
  });

  if (typeof base.output_directory !== "string") {
    base.output_directory = null;
  }

  if (typeof base.lens_prompt === "string") {
    const trimmedLens = base.lens_prompt.trim();
    base.lens_prompt = trimmedLens.length ? trimmedLens : null;
  } else {
    base.lens_prompt = null;
  }

  return base;
}

function buildRequestPayload({
  content,
  session,
  cobraMeta,
  analysisTemplate,
  configOverride,
}) {
  const normalizedConfig = buildNormalizedActionSummaryConfig({
    cobraMeta,
    configOverride,
  });

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
    segment_length: normalizedConfig.segment_length,
    fps: normalizedConfig.fps,
    run_async: normalizedConfig.run_async,
    overwrite_output: normalizedConfig.overwrite_output,
    reprocess_segments: normalizedConfig.reprocess_segments,
    generate_transcripts: normalizedConfig.generate_transcripts,
    trim_to_nearest_second: normalizedConfig.trim_to_nearest_second,
    allow_partial_segments: normalizedConfig.allow_partial_segments,
    upload_to_azure: normalizedConfig.upload_to_azure,
    skip_preprocess: normalizedConfig.skip_preprocess,
  };

  if (normalizedConfig.max_workers != null) {
    payload.max_workers = normalizedConfig.max_workers;
  }

  if (typeof normalizedConfig.output_directory === "string") {
    payload.output_directory = normalizedConfig.output_directory;
  }

  if (manifestReference && !isHttpUrl(manifestReference)) {
    payload.skip_preprocess = true;
  }

  if (
    typeof normalizedConfig.lens_prompt === "string" &&
    normalizedConfig.lens_prompt.trim().length
  ) {
    payload.analysis_lens = normalizedConfig.lens_prompt.trim();
  }

  if (Array.isArray(analysisTemplate) && analysisTemplate.length > 0) {
    payload.analysis_template = analysisTemplate;
  }

  return { payload, config: normalizedConfig };
}

async function loadActionSummaryContext(params) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const contentId = params?.contentId;
  if (!contentId) {
    return {
      response: NextResponse.json({ error: "Content id is required" }, { status: 400 }),
    };
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
    return {
      response: NextResponse.json({ error: "Content not found" }, { status: 404 }),
    };
  }

  const { clone: processingMetadata, cobra: cobraMeta } = getCobraMetadata(
    content.processingMetadata,
  );

  const { meta: actionSummaryMeta } = ensureActionSummaryMeta(cobraMeta);

  return { session, content, processingMetadata, cobraMeta, actionSummaryMeta };
}

export async function POST(request, { params }) {
  const context = await loadActionSummaryContext(params);
  if (context?.response) {
    return context.response;
  }

  const {
    session,
    content,
    processingMetadata,
    cobraMeta,
    actionSummaryMeta,
  } = context;

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

  const normalizedExistingTemplate = normalizeAnalysisTemplate(
    actionSummaryMeta?.analysisTemplate,
  );
  const existingTemplate =
    normalizedExistingTemplate ??
    (Array.isArray(actionSummaryMeta?.analysisTemplate)
      ? actionSummaryMeta.analysisTemplate
      : null);

  let requestBody = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      requestBody = await request.json();
    } catch (error) {
      requestBody = null;
    }
  }

  let analysisTemplate = existingTemplate;
  if (
    requestBody &&
    Object.prototype.hasOwnProperty.call(requestBody, "analysisTemplate")
  ) {
    if (requestBody.analysisTemplate === null) {
      analysisTemplate = null;
    } else {
      const normalizedRequestedTemplate = normalizeAnalysisTemplate(
        requestBody.analysisTemplate,
      );
      if (normalizedRequestedTemplate) {
        analysisTemplate = normalizedRequestedTemplate;
      }
    }
  }

  let requestedConfig = null;
  if (
    requestBody &&
    Object.prototype.hasOwnProperty.call(requestBody, "config")
  ) {
    requestedConfig = sanitizeActionSummaryConfigOverride(requestBody.config);
  }

  const { payload: requestPayload, config: normalizedConfig } =
    buildRequestPayload({
      content,
      session,
      cobraMeta,
      analysisTemplate,
      configOverride: requestedConfig,
    });

  const now = new Date();
  const nowIso = now.toISOString();

  const updatedMeta = {
    ...actionSummaryMeta,
    config: normalizedConfig,
    runs: Array.isArray(actionSummaryMeta?.runs)
      ? [...actionSummaryMeta.runs]
      : [],
    status: "PROCESSING",
    error: null,
  };

  cobraMeta.lastActionSummaryRequestedAt = nowIso;
  cobraMeta.actionSummary = updatedMeta;
  processingMetadata.cobra = cobraMeta;

  await prisma.content.update({
    where: { id: content.id },
    data: {
      actionSummaryStatus: "PROCESSING",
      analysisRequestedAt: now,
      processingMetadata,
    },
  });

  let requestResult;
  try {
    requestResult = await postToAnalysisService(
      getActionSummaryEndpoint(),
      requestPayload,
    );
  } catch (error) {
    updatedMeta.lastRunAt = nowIso;
    updatedMeta.status = "FAILED";
    updatedMeta.error =
      error.message ?? "Failed to contact the analysis service.";
    cobraMeta.actionSummary = updatedMeta;
    processingMetadata.cobra = cobraMeta;

    await prisma.content.update({
      where: { id: content.id },
      data: {
        actionSummaryStatus: "FAILED",
        processingMetadata,
      },
    });

    return NextResponse.json(
      { error: "Failed to contact the analysis service." },
      { status: 502 },
    );
  }

  const { ok, status, data } = requestResult;

  if (!ok) {
    const errorMessage =
      data?.detail ||
      data?.error ||
      data?.message ||
      "Action summary request failed";

    updatedMeta.lastRunAt = nowIso;
    updatedMeta.status = "FAILED";
    updatedMeta.error = errorMessage;
    cobraMeta.actionSummary = updatedMeta;
    processingMetadata.cobra = cobraMeta;

    await prisma.content.update({
      where: { id: content.id },
      data: {
        actionSummaryStatus: "FAILED",
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

  const responseTemplate =
    normalizeAnalysisTemplate(data?.analysis_template) ??
    analysisTemplate ??
    null;
  analysisTemplate = responseTemplate;

  const filters = {
    organizationId: content.organizationId,
    collectionId: content.collectionId,
    contentId: content.id,
  };

  const resolvedManifestPath = cobraMeta.manifestPath ?? null;
  const resolvedManifestUrl =
    cobraMeta.manifestUrl ?? resolvedManifestPath ?? null;

  const completedAt = new Date().toISOString();
  const runId = createActionSummaryRunId();

  const analysisResult =
    data?.result !== undefined && data?.result !== null
      ? data.result
      : data?.analysis ?? null;

  const runRecord = {
    id: runId,
    name:
      typeof requestBody?.name === "string" && requestBody.name.trim().length
        ? requestBody.name.trim()
        : null,
    analysis: analysisResult,
    analysisOutputPath: data?.analysis_output_path ?? null,
    storageArtifacts: data?.storage_artifacts ?? null,
    searchUploads: data?.search_uploads ?? [],
    analysisTemplate,
    config: normalizedConfig,
    filters,
    manifestPath: resolvedManifestPath,
    manifestUrl: resolvedManifestUrl,
    createdAt: nowIso,
    requestedAt: nowIso,
    completedAt,
    result: analysisResult,
  };

  updatedMeta.runs = updatedMeta.runs.filter((run) => run?.id !== runId);
  updatedMeta.runs.push(runRecord);
  updatedMeta.lastRunAt = completedAt;
  updatedMeta.analysisTemplate = analysisTemplate;
  updatedMeta.config = normalizedConfig;
  updatedMeta.filters = filters;
  updatedMeta.manifestPath = resolvedManifestPath;
  updatedMeta.manifestUrl = resolvedManifestUrl;
  updatedMeta.activeRunId = runId;
  updatedMeta.status = "COMPLETED";
  updatedMeta.error = null;

  cobraMeta.actionSummary = updatedMeta;
  processingMetadata.cobra = cobraMeta;

  await prisma.content.update({
    where: { id: content.id },
    data: {
      actionSummaryStatus: "COMPLETED",
      processingMetadata,
    },
  });

  return NextResponse.json(
    {
      actionSummary: updatedMeta,
      run: runRecord,
    },
    { status: 200 },
  );
}

export async function PATCH(request, { params }) {
  const context = await loadActionSummaryContext(params);
  if (context?.response) {
    return context.response;
  }

  const { content, processingMetadata, cobraMeta, actionSummaryMeta } = context;

  let requestBody = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      requestBody = await request.json();
    } catch (error) {
      requestBody = null;
    }
  }

  if (!requestBody || !Object.prototype.hasOwnProperty.call(requestBody, "config")) {
    return NextResponse.json({ error: "Config payload is required" }, { status: 400 });
  }

  let requestedConfig = null;
  if (requestBody.config != null) {
    requestedConfig = sanitizeActionSummaryConfigOverride(requestBody.config);
  }

  if (!requestedConfig) {
    return NextResponse.json(
      { error: "Provide at least one valid processing setting to update." },
      { status: 400 },
    );
  }

  const normalizedConfig = buildNormalizedActionSummaryConfig({
    cobraMeta,
    configOverride: requestedConfig,
  });

  const updatedMeta = {
    ...actionSummaryMeta,
    config: normalizedConfig,
    runs: Array.isArray(actionSummaryMeta?.runs)
      ? [...actionSummaryMeta.runs]
      : [],
  };

  cobraMeta.actionSummary = updatedMeta;
  processingMetadata.cobra = cobraMeta;

  await prisma.content.update({
    where: { id: content.id },
    data: {
      processingMetadata,
    },
  });

  return NextResponse.json({ actionSummary: updatedMeta }, { status: 200 });
}

export async function DELETE(request, { params }) {
  const context = await loadActionSummaryContext(params);
  if (context?.response) {
    return context.response;
  }

  const { content, processingMetadata, cobraMeta, actionSummaryMeta } = context;

  const url = new URL(request.url);
  let runId = url.searchParams.get("runId") ?? url.searchParams.get("id");
  if (typeof runId === "string" && runId.trim().length) {
    runId = runId.trim();
  } else {
    runId = null;
  }

  let requestBody = null;
  if (!runId && request.headers.get("content-type")?.includes("application/json")) {
    try {
      requestBody = await request.json();
    } catch (error) {
      requestBody = null;
    }
  }

  if (!runId && requestBody && typeof requestBody === "object") {
    const candidateId =
      requestBody.runId ?? requestBody.id ?? requestBody.actionSummaryId;
    if (typeof candidateId === "string" && candidateId.trim().length) {
      runId = candidateId.trim();
    }
  }

  if (!runId && actionSummaryMeta?.activeRunId) {
    runId = actionSummaryMeta.activeRunId;
  }

  if (!runId) {
    return NextResponse.json(
      { error: "Provide the action summary id to delete." },
      { status: 400 },
    );
  }

  const { removed: removedRun, runs } = removeActionSummaryRun(
    actionSummaryMeta,
    runId,
  );

  if (!removedRun) {
    return NextResponse.json(
      { error: "Action summary run not found." },
      { status: 404 },
    );
  }

  const blobUrls = Array.from(collectBlobUrls(removedRun));
  const searchDocumentIds = collectSearchDocumentIds({
    actionSummary: { runs: [removedRun] },
  });

  await deleteBlobUrls(blobUrls);
  await deleteSearchDocuments(searchDocumentIds, { contentId: content.id });

  const updatedMeta = {
    ...actionSummaryMeta,
    runs,
  };

  if (runs.length) {
    if (!runs.some((run) => run.id === updatedMeta.activeRunId)) {
      updatedMeta.activeRunId = runs[runs.length - 1].id;
    }

    const activeRun =
      runs.find((run) => run.id === updatedMeta.activeRunId) ?? runs.at(-1);

    updatedMeta.lastRunAt = activeRun?.completedAt ?? activeRun?.createdAt ?? null;
    updatedMeta.manifestPath = activeRun?.manifestPath ?? updatedMeta.manifestPath ?? null;
    updatedMeta.manifestUrl = activeRun?.manifestUrl ?? updatedMeta.manifestUrl ?? null;
    updatedMeta.storageArtifacts = activeRun?.storageArtifacts ?? null;
    updatedMeta.searchUploads = Array.isArray(activeRun?.searchUploads)
      ? activeRun.searchUploads
      : [];
    if (activeRun?.analysisTemplate && !updatedMeta.analysisTemplate) {
      updatedMeta.analysisTemplate = activeRun.analysisTemplate;
    }
    if (activeRun?.filters) {
      updatedMeta.filters = activeRun.filters;
    }
    updatedMeta.status = "COMPLETED";
    updatedMeta.error = null;
  } else {
    updatedMeta.activeRunId = null;
    updatedMeta.lastRunAt = null;
    updatedMeta.manifestPath = null;
    updatedMeta.manifestUrl = null;
    updatedMeta.filters = null;
    updatedMeta.storageArtifacts = null;
    updatedMeta.searchUploads = [];
    updatedMeta.status = "QUEUED";
    updatedMeta.error = null;
  }

  cobraMeta.manifestUrl = updatedMeta.manifestUrl ?? cobraMeta.manifestUrl ?? null;
  cobraMeta.manifestPath = updatedMeta.manifestPath ?? cobraMeta.manifestPath ?? null;
  cobraMeta.actionSummary = updatedMeta;
  processingMetadata.cobra = cobraMeta;

  const actionSummaryStatus = runs.length ? "COMPLETED" : "QUEUED";

  await prisma.content.update({
    where: { id: content.id },
    data: {
      actionSummaryStatus,
      processingMetadata,
    },
  });

  return NextResponse.json(
    {
      actionSummary: updatedMeta,
      deletedRunId: removedRun.id,
    },
    { status: 200 },
  );
}
