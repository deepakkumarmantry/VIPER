import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  canCreateCollections,
  canManageCollections,
  canViewAllContent,
} from "@/lib/rbac";
import { userCanManageOrganization } from "@/lib/access";

const visibilitySchema = z.enum(["PRIVATE", "PUBLIC"]);

const createCollectionSchema = z.object({
  name: z.string().trim().min(2, "Collection name is required"),
  description: z
    .string()
    .trim()
    .max(2000, "Description must be 2000 characters or fewer")
    .optional()
    .nullable(),
  organizationId: z.string().uuid("Organization is required"),
  visibility: visibilitySchema.default("PRIVATE"),
});

export async function POST(request) {
  const session = await getCurrentSession();

  if (
    !session?.user?.id ||
    !canManageCollections(session.user.role) ||
    !canCreateCollections(session.user.role)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = createCollectionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const { name, description, organizationId, visibility } = parsed.data;

  if (!canViewAllContent(session.user.role)) {
    const allowed = await userCanManageOrganization(session.user, organizationId);
    if (!allowed) {
      return NextResponse.json(
        { error: "You do not have permission to manage this organization." },
        { status: 403 },
      );
    }
  }

  const collection = await prisma.collection.create({
    data: {
      name: name.trim(),
      description: description?.trim() || null,
      organizationId,
      visibility,
    },
    include: {
      organization: true,
    },
  });

  if (!canViewAllContent(session.user.role)) {
    await prisma.collectionMembership.upsert({
      where: {
        collectionId_userId: {
          collectionId: collection.id,
          userId: session.user.id,
        },
      },
      create: {
        collectionId: collection.id,
        userId: session.user.id,
        role: "ADMIN",
      },
      update: {
        role: "ADMIN",
      },
    });
  }

  return NextResponse.json({ collection }, { status: 201 });
}
