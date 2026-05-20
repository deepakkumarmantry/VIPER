import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildContentAccessWhere } from "@/lib/access";
import { generateBlobReadSasUrl } from "@/lib/azure-storage";
import { buildClipchampEditorUrl } from "@/lib/clipchamp";

function sanitizeNumber(value, { fallback = null, min, max } = {}) {
  if (typeof value !== "number") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      value = parsed;
    }
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  let normalized = value;
  if (typeof min === "number") {
    normalized = Math.max(min, normalized);
  }
  if (typeof max === "number") {
    normalized = Math.min(max, normalized);
  }
  return normalized;
}

export async function POST(request) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body = null;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const contentId = body?.contentId;
  if (typeof contentId !== "string" || !contentId.trim()) {
    return NextResponse.json({ error: "contentId is required" }, { status: 400 });
  }

  const startSeconds = sanitizeNumber(body?.startSeconds, { fallback: 0, min: 0 }) ?? 0;
  const endSeconds = sanitizeNumber(body?.endSeconds, { fallback: null, min: 0 });
  const durationSeconds = sanitizeNumber(body?.durationSeconds, {
    fallback: null,
    min: 1,
    max: 60 * 10,
  });
  const summary = typeof body?.summary === "string" ? body.summary : null;

  const accessibleContent = await prisma.content.findFirst({
    where: buildContentAccessWhere(session.user, contentId),
    select: {
      id: true,
      title: true,
      videoUrl: true,
    },
  });

  if (!accessibleContent) {
    const existing = await prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ error: "Content not found" }, { status: 404 });
  }

  if (typeof accessibleContent.videoUrl !== "string" || !accessibleContent.videoUrl.trim()) {
    return NextResponse.json({ error: "Video not available for export" }, { status: 404 });
  }

  const sasUrl = await generateBlobReadSasUrl(accessibleContent.videoUrl, {
    expiresInSeconds: 60 * 30,
  });

  if (!sasUrl) {
    return NextResponse.json(
      { error: "Failed to generate a secure download link for Clipchamp" },
      { status: 500 },
    );
  }

  const safeStart = Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0);
  let safeEnd = null;
  if (Number.isFinite(endSeconds) && endSeconds > safeStart) {
    safeEnd = endSeconds;
  } else if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    safeEnd = safeStart + durationSeconds;
  } else {
    safeEnd = safeStart + 60;
  }

  const clipDuration = Math.max(1, safeEnd - safeStart);

  const clipchampUrl = buildClipchampEditorUrl({
    assetUrl: sasUrl,
    startSeconds: safeStart,
    durationSeconds: clipDuration,
    title: accessibleContent.title ?? undefined,
    summary: summary ?? undefined,
  });

  if (!clipchampUrl) {
    return NextResponse.json(
      { error: "Failed to prepare Clipchamp export link" },
      { status: 500 },
    );
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  return NextResponse.json(
    {
      export: {
        clipchampUrl,
        assetUrl: sasUrl,
        assetExpiresAt: expiresAt.toISOString(),
        contentId: accessibleContent.id,
        startSeconds: safeStart,
        endSeconds: safeEnd,
        durationSeconds: clipDuration,
        title: accessibleContent.title ?? null,
        summary: summary ?? null,
      },
    },
    { status: 200 },
  );
}
