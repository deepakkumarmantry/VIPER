import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canUploadContent } from "@/lib/rbac";
import { buildCollectionAccessWhere } from "@/lib/access";
import { randomUUID } from "crypto";
import { extname } from "path";
import { buildBackendUrl } from "@/lib/backend";
import { getBlobServiceClient, getVideoContainerName } from "@/lib/azure-storage";


const NETWORK_RETRY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

function sanitizeUploadMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }

    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      sanitized[key] = value;
      continue;
    }

    if (value instanceof Date) {
      sanitized[key] = value.toISOString();
      continue;
    }

    try {
      const normalized = JSON.parse(JSON.stringify(value));
      if (normalized !== undefined) {
        sanitized[key] = normalized;
      }
    } catch (error) {
      // Ignore non-serializable metadata entries.
    }
  }

  return Object.keys(sanitized).length ? sanitized : null;
}

function buildUploaderDisplayName(session) {
  if (session?.user?.name && session.user.name.trim().length) {
    return session.user.name.trim();
  }

  if (session?.user?.email && session.user.email.trim().length) {
    return session.user.email.trim();
  }

  return null;
}

function buildCobraUploadMetadata({
  session,
  collection,
  title,
  description,
  fileName,
}) {
  const uploadMetadata = {
    metadata_version: 1,
    organization: collection?.organizationId ?? null,
    organization_name: collection?.organization?.name ?? null,
    collection: collection?.id ?? null,
    collection_name: collection?.name ?? null,
    user: session?.user?.id ?? null,
    user_name: buildUploaderDisplayName(session),
    video_title: title && title.trim().length ? title.trim() : fileName ?? null,
    video_description:
      description && description.trim().length ? description.trim() : null,
    video_url: null,
    output_directory: null,
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
  };

  return sanitizeUploadMetadata(uploadMetadata);
}

class CobraUploadError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CobraUploadError";
    this.endpoint = options.endpoint ?? null;
    this.status = options.status ?? null;
    this.statusText = options.statusText ?? null;
    this.responseBody = options.responseBody ?? null;
    this.details = options.details ?? null;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function resolveCobraUploadEndpoint() {
  const override = process.env.COBRAPY_UPLOAD_ENDPOINT;
  if (override && typeof override === "string" && override.trim().length) {
    return override.trim();
  }

  return buildBackendUrl("/videos/upload");
}


function getUploadEndpointCandidates() {
  const primary = resolveCobraUploadEndpoint();
  const candidates = [primary];


  try {

    const url = new URL(primary);
    const fallbackHosts = new Set();

    if (url.hostname === "localhost") {
      fallbackHosts.add("127.0.0.1");
    }

    const configuredFallbacks = process.env.COBRAPY_UPLOAD_FALLBACK_HOSTS;
    if (configuredFallbacks && typeof configuredFallbacks === "string") {
      configuredFallbacks
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => fallbackHosts.add(entry));
    }

    for (const host of fallbackHosts) {
      if (!host) {
        continue;
      }

      if (host.includes("://")) {
        candidates.push(host);
        continue;
      }

      const fallbackUrl = new URL(url.toString());
      fallbackUrl.host = host;
      candidates.push(fallbackUrl.toString());
    }

  } catch (error) {
    // Ignore invalid URL formatting and fall back to the primary endpoint only.
  }

  return Array.from(new Set(candidates));
}

function extractNetworkErrorDetails(error) {
  const details = {};
  if (!error || typeof error !== "object") {
    return details;
  }

  const stack = [error];
  if (error.cause && typeof error.cause === "object") {
    stack.push(error.cause);
    if (error.cause.cause && typeof error.cause.cause === "object") {
      stack.push(error.cause.cause);
    }
  }

  for (const current of stack) {
    if (!current || typeof current !== "object") {
      continue;
    }

    if (typeof current.code === "string" && !details.code) {
      details.code = current.code;
    }

    if (typeof current.errno === "string" && !details.errno) {
      details.errno = current.errno;
    }

    if (typeof current.address === "string" && !details.address) {
      details.address = current.address;
    }

    if (typeof current.port === "number" && !details.port) {
      details.port = current.port;
    }

    if (typeof current.message === "string" && !details.message) {
      details.message = current.message;
    }
  }

  return details;
}

function isRetriableNetworkError(details) {
  const code = typeof details.code === "string" ? details.code.toUpperCase() : null;
  if (code && NETWORK_RETRY_ERROR_CODES.has(code)) {
    return true;
  }

  if (typeof details.message === "string") {
    const normalized = details.message.toLowerCase();
    if (normalized.includes("connect") && normalized.includes("refused")) {
      return true;
    }
    if (normalized.includes("timed") && normalized.includes("out")) {
      return true;
    }
    if (normalized.includes("not found")) {
      return true;
    }
  }

  return false;
}

function createUploadFormDataFactory({
  blob,
  fileName,
  shouldUploadToAzure,
  metadataJson,
}) {
  return () => {
    const formData = new FormData();
    formData.append("file", blob, fileName);
    formData.append("upload_to_azure", shouldUploadToAzure ? "true" : "false");

    if (metadataJson) {
      formData.append("metadata_json", metadataJson);
    }

    return formData;
  };
}

async function uploadToCobra(buffer, fileName, mimeType, options = {}) {
  const endpoints = getUploadEndpointCandidates();
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  const shouldUploadToAzure =
    typeof options.uploadToAzure === "boolean" ? options.uploadToAzure : true;
  const metadataPayload = sanitizeUploadMetadata(options.metadata);
  const metadataJson = metadataPayload ? JSON.stringify(metadataPayload) : null;
  const createFormData = createUploadFormDataFactory({
    blob,
    fileName,
    shouldUploadToAzure,
    metadataJson,
  });

  let lastNetworkError = null;

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        body: createFormData(),
        duplex: "half",
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const networkDetails = extractNetworkErrorDetails(cause);
      const detailPayload = {};
      if (networkDetails.message) {
        detailPayload.message = networkDetails.message;
      } else {
        detailPayload.message = cause.message;
      }
      if (networkDetails.code) {
        detailPayload.code = networkDetails.code;
      }
      if (networkDetails.errno) {
        detailPayload.errno = networkDetails.errno;
      }
      if (networkDetails.address) {
        detailPayload.address = networkDetails.address;
      }
      if (typeof networkDetails.port === "number") {
        detailPayload.port = networkDetails.port;
      }

      const cobraError = new CobraUploadError(
        "Failed to reach CobraPy upload endpoint.",
        {
          endpoint,
          cause,
          details: detailPayload,
        },
      );

      lastNetworkError = { error: cobraError, details: networkDetails };

      const hasFallback = index < endpoints.length - 1;
      if (hasFallback && isRetriableNetworkError(networkDetails)) {
        const message =
          networkDetails.message ||
          cause.message ||
          "Unknown network failure contacting CobraPy.";
        console.warn(
          `[upload] Cobra upload attempt to ${endpoint} failed: ${message}. Trying fallback endpoint.`,
        );
        continue;
      }

      throw cobraError;
    }

    let rawBody = null;
    try {
      rawBody = await response.text();
    } catch (error) {
      rawBody = null;
    }

    let data = null;
    if (rawBody && rawBody.length) {
      try {
        data = JSON.parse(rawBody);
      } catch (error) {
        data = null;
      }
    }

    if (!response.ok) {
      const message =
        data?.detail ||
        data?.error ||
        data?.message ||
        (typeof rawBody === "string" && rawBody.length ? rawBody : null) ||
        "Video upload service returned an unexpected error.";
      throw new CobraUploadError(message, {
        endpoint,
        status: response.status,
        statusText: response.statusText,
        responseBody: data ?? rawBody,
      });
    }

    if (!data) {
      throw new CobraUploadError(
        "Video upload service returned an unexpected response body.",
        {
          endpoint,
          status: response.status,
          statusText: response.statusText,
          responseBody: rawBody,
        },
      );
    }

    return data;
  }

  if (lastNetworkError?.error) {
    throw lastNetworkError.error;
  }

  throw new CobraUploadError("Failed to reach CobraPy upload endpoint.");
}

async function uploadToAzureStorage(buffer, fileName, mimeType) {
  const client = getBlobServiceClient();
  const containerName = getVideoContainerName();
  const containerClient = client.getContainerClient(containerName);
  await containerClient.createIfNotExists();

  const extension = extname(fileName) || ".mp4";
  const blobName = `${randomUUID()}${extension}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimeType || "video/mp4" },
  });

  return `${containerClient.url}/${blobName}`;
}

function buildProcessingMetadata({ storageUrl, uploadMetadata }) {
  const metadata = {
    cobra: {
      localVideoPath: null,
      storageUrl: storageUrl ?? null,
      videoUrl: storageUrl ?? null,
      uploadedAt: new Date().toISOString(),
    },
  };

  const sanitized = sanitizeUploadMetadata(uploadMetadata);
  if (sanitized) {
    metadata.cobra.uploadMetadata = sanitized;
  }

  return metadata;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized.length) {
      return null;
    }

    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }

    return null;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return null;
    }

    return value !== 0;
  }

  return null;
}

function isUploadFile(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.arrayBuffer === "function" &&
    typeof value.name === "string"
  );
}

function parseBatchMetadata(formData, files) {
  const metadataRaw = formData.get("metadata");
  let parsedMetadata = null;

  if (typeof metadataRaw === "string" && metadataRaw.trim().length) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (Array.isArray(parsed)) {
        parsedMetadata = parsed;
      }
    } catch (error) {
      console.warn("[upload] Failed to parse batch metadata payload", error);
    }
  }

  const sharedTitle = (formData.get("title") ?? "").toString().trim();
  const sharedDescription = (formData.get("description") ?? "").toString().trim();

  return files.map((file, index) => {
    const entry =
      parsedMetadata && typeof parsedMetadata[index] === "object"
        ? parsedMetadata[index]
        : null;

    const entryTitle =
      entry && typeof entry.title === "string" && entry.title.trim().length
        ? entry.title.trim()
        : sharedTitle;
    const entryDescription =
      entry && typeof entry.description === "string" && entry.description.trim().length
        ? entry.description.trim()
        : sharedDescription;
    const metadataOverrides =
      entry && typeof entry.metadata === "object" && entry.metadata
        ? entry.metadata
        : entry && typeof entry.cobraMetadata === "object" && entry.cobraMetadata
        ? entry.cobraMetadata
        : null;

    const uploadToAzureValue =
      entry && entry.upload_to_azure !== undefined
        ? entry.upload_to_azure
        : entry && entry.uploadToAzure !== undefined
        ? entry.uploadToAzure
        : null;

    const uploadToAzure = coerceBoolean(uploadToAzureValue);

    return {
      title:
        entryTitle && entryTitle.length
          ? entryTitle
          : file.name || `Upload ${index + 1}`,
      description: entryDescription || "",
      metadataOverrides: metadataOverrides ?? null,
      uploadToAzure,
    };
  });
}

async function processFileUpload({
  index,
  file,
  session,
  collection,
  metadataEntry,
}) {
  const originalFilename =
    (typeof file.name === "string" && file.name.length ? file.name : null) ||
    `video-${index + 1}.mp4`;
  const mimeType =
    (typeof file.type === "string" && file.type.length ? file.type : null) ||
    "video/mp4";

  let buffer;
  try {
    const arrayBuffer = await file.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    console.error(`[upload] Failed to read uploaded file data for ${originalFilename}`, error);
    return {
      index,
      fileName: originalFilename,
      status: "failed",
      httpStatus: 400,
      error: "Unable to read the uploaded file contents.",
      errorDetails: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const resolvedTitle =
    metadataEntry && typeof metadataEntry.title === "string" && metadataEntry.title.trim().length
      ? metadataEntry.title.trim()
      : originalFilename;
  const resolvedDescription =
    metadataEntry &&
    typeof metadataEntry.description === "string" &&
    metadataEntry.description.trim().length
      ? metadataEntry.description.trim()
      : "";

  let cobraUploadMetadata =
    buildCobraUploadMetadata({
      session,
      collection,
      title: resolvedTitle,
      description: resolvedDescription,
      fileName: originalFilename,
    }) || {};

  const metadataOverrides = sanitizeUploadMetadata(
    metadataEntry && metadataEntry.metadataOverrides
      ? metadataEntry.metadataOverrides
      : null,
  );

  if (metadataOverrides) {
    cobraUploadMetadata =
      sanitizeUploadMetadata({
        ...(cobraUploadMetadata || {}),
        ...metadataOverrides,
      }) || cobraUploadMetadata;
  } else {
    cobraUploadMetadata = sanitizeUploadMetadata(cobraUploadMetadata) || cobraUploadMetadata;
  }

  let shouldUploadToAzure = true;
  if (
    cobraUploadMetadata &&
    Object.prototype.hasOwnProperty.call(cobraUploadMetadata, "upload_to_azure")
  ) {
    const coerced = coerceBoolean(cobraUploadMetadata.upload_to_azure);
    if (coerced !== null) {
      shouldUploadToAzure = coerced;
    }
  }

  const uploadToAzureOverride = coerceBoolean(metadataEntry?.uploadToAzure);
  if (uploadToAzureOverride !== null) {
    shouldUploadToAzure = uploadToAzureOverride;
  }

  if (cobraUploadMetadata) {
    cobraUploadMetadata =
      sanitizeUploadMetadata({
        ...(cobraUploadMetadata || {}),
        upload_to_azure: shouldUploadToAzure,
      }) || cobraUploadMetadata;
  }

  let cobraUpload;
  try {
    cobraUpload = await uploadToCobra(buffer, originalFilename, mimeType, {
      metadata: cobraUploadMetadata,
      uploadToAzure: shouldUploadToAzure,
    });
  } catch (error) {
    if (error instanceof CobraUploadError) {
      console.error("[upload] Cobra upload failed", {
        endpoint: error.endpoint,
        status: error.status,
        statusText: error.statusText,
        responseBody: error.responseBody,
        details: error.details,
        cause: error.cause instanceof Error ? error.cause.stack ?? error.cause.message : error.cause,
      });

      const failureStatus = error.status && error.status >= 400 ? error.status : 502;

      return {
        index,
        fileName: originalFilename,
        status: "failed",
        httpStatus: failureStatus,
        error: error.message,
        errorDetails: {
          cobraEndpoint: error.endpoint ?? null,
          cobraStatus: error.status ?? null,
          cobraStatusText: error.statusText ?? null,
          cobraResponse: error.responseBody ?? null,
          details: error.details ?? null,
        },
      };
    }

    console.error("[upload] Unexpected error contacting Cobra", error);
    return {
      index,
      fileName: originalFilename,
      status: "failed",
      httpStatus: 502,
      error: "Failed to upload video due to an unexpected error.",
      errorDetails: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  let storageUrl = cobraUpload?.storage_url ?? null;

  if (!storageUrl && shouldUploadToAzure) {
    try {
      storageUrl = await uploadToAzureStorage(buffer, originalFilename, mimeType);
    } catch (error) {
      console.error(
        `[upload] Failed to upload video to storage for ${originalFilename}`,
        error,
      );
      return {
        index,
        fileName: originalFilename,
        status: "failed",
        httpStatus: 500,
        error:
          "Failed to upload the video to storage. Confirm Azure Storage managed identity settings are configured or enable uploads in CobraPy.",
        errorDetails: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  if (!storageUrl) {
    return {
      index,
      fileName: originalFilename,
      status: "failed",
      httpStatus: 502,
      error:
        "Video upload service did not return an Azure Storage URL. Confirm CobraPy uploads are enabled or configure managed identity access.",
      errorDetails: null,
    };
  }

  const processingMetadata = buildProcessingMetadata({
    storageUrl,
    uploadMetadata: sanitizeUploadMetadata({
      ...(cobraUploadMetadata || {}),
      upload_to_azure: shouldUploadToAzure,
      video_url: storageUrl ?? null,
    }),
  });

  try {
    const content = await prisma.content.create({
      data: {
        title: resolvedTitle || originalFilename,
        description: resolvedDescription || null,
        videoUrl: storageUrl,
        collectionId: collection.id,
        organizationId: collection.organizationId,
        uploadedById: session.user.id,
        processingMetadata,
      },
      include: {
        organization: true,
        collection: true,
        uploadedBy: true,
      },
    });

    return {
      index,
      fileName: originalFilename,
      status: "succeeded",
      httpStatus: 201,
      content,
      error: null,
      errorDetails: null,
    };
  } catch (error) {
    console.error("[upload] Failed to save uploaded content record", error);
    return {
      index,
      fileName: originalFilename,
      status: "failed",
      httpStatus: 500,
      error: "Failed to save uploaded video metadata.",
      errorDetails: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function POST(request) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canUploadContent(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const collectionId = formData.get("collectionId");
  const candidateFiles = formData.getAll("files");
  const files = [];

  for (const candidate of candidateFiles) {
    if (isUploadFile(candidate)) {
      files.push(candidate);
    }
  }

  const fallbackFile = formData.get("file");
  if (!files.length && isUploadFile(fallbackFile)) {
    files.push(fallbackFile);
  }

  if (!files.length) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  if (!collectionId || typeof collectionId !== "string") {
    return NextResponse.json({ error: "Collection is required" }, { status: 400 });
  }

  const collection = await prisma.collection.findFirst({
    where: buildCollectionAccessWhere(session.user, collectionId),
    include: {
      organization: true,
    },
  });

  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  const metadataEntries = parseBatchMetadata(formData, files);

  const results = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const metadataEntry = metadataEntries[index] || {};
    const result = await processFileUpload({
      index,
      file,
      session,
      collection,
      metadataEntry,
    });
    results.push(result);
  }

  const successes = results.filter(
    (result) => result.status === "succeeded" && result.content,
  );
  const failures = results.filter((result) => result.status === "failed");
  const contents = successes.map((result) => result.content);

  let status = 500;
  if (successes.length && failures.length) {
    status = 207;
  } else if (successes.length) {
    status = 201;
  } else {
    const firstFailureStatus = failures.find(
      (failure) => typeof failure.httpStatus === "number" && failure.httpStatus >= 400,
    );
    status = firstFailureStatus?.httpStatus ?? 500;
  }

  const response = {
    content: contents[0] ?? null,
    contents,
    results: results.map((result) => ({
      index: result.index,
      fileName: result.fileName,
      status: result.status,
      httpStatus: result.httpStatus,
      content: result.content ?? null,
      error: result.error ?? null,
      errorDetails: result.errorDetails ?? null,
    })),
  };

  if (failures.length) {
    response.errors = failures.map((failure) => ({
      index: failure.index,
      fileName: failure.fileName,
      error: failure.error,
      httpStatus: failure.httpStatus,
      errorDetails: failure.errorDetails ?? null,
    }));
  }

  return NextResponse.json(response, { status });
}
