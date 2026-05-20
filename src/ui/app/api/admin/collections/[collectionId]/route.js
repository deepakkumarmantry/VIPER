import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { canManageCollections, canViewAllContent } from "@/lib/rbac";
import { userCanManageCollection } from "@/lib/access";

const visibilitySchema = z.enum(["PRIVATE", "PUBLIC"]);

const updateCollectionSchema = z
  .object({
    name: z.string().trim().min(2, "Collection name is required").optional(),
    description: z
      .string()
      .trim()
      .max(2000, "Description must be 2000 characters or fewer")
      .optional(),
    visibility: visibilitySchema.optional(),
  })
  .refine((data) => data.name != null || data.description != null || data.visibility != null, {
    message: "Provide a name, description, or visibility to update.",
  });

export async function PATCH(request, { params }) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageCollections(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const collectionId = params?.collectionId;

  if (!collectionId) {
    return NextResponse.json({ error: "Collection id is required" }, { status: 400 });
  }

  if (!canViewAllContent(session.user.role)) {
    const allowed = await userCanManageCollection(session.user, collectionId);
    if (!allowed) {
      return NextResponse.json(
        { error: "You do not have permission to manage this collection." },
        { status: 403 },
      );
    }
  }

  const body = await request.json().catch(() => ({}));
  const parsed = updateCollectionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const updates = {};

  if (parsed.data.name != null) {
    updates.name = parsed.data.name.trim();
  }

  if (parsed.data.description != null) {
    const trimmed = parsed.data.description.trim();
    updates.description = trimmed.length ? trimmed : null;
  }

  if (parsed.data.visibility != null) {
    updates.visibility = parsed.data.visibility;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "Provide a name, description, or visibility to update." },
      { status: 400 },
    );
  }

  const collection = await prisma.collection.update({
    where: { id: collectionId },
    data: updates,
    include: { organization: true },
  });

  return NextResponse.json({ collection }, { status: 200 });
}
