import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { canManageCollections, canViewAllContent } from "@/lib/rbac";
import { userCanManageCollection } from "@/lib/access";

const membershipSchema = z.object({
  userId: z.string().uuid("User is required"),
  role: z
    .enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"], {
      errorMap: () => ({ message: "Choose a valid membership role." }),
    })
    .default("VIEWER"),
});

export async function POST(request, { params }) {
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

  const payload = await request.json().catch(() => ({}));
  const parsed = membershipSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const { userId, role } = parsed.data;

  const [user, collection] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
    prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        id: true,
        name: true,
        organization: { select: { id: true, name: true } },
      },
    }),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  const membership = await prisma.collectionMembership.upsert({
    where: {
      collectionId_userId: {
        collectionId,
        userId,
      },
    },
    update: { role },
    create: {
      collectionId,
      userId,
      role,
    },
    include: {
      user: true,
      collection: {
        include: { organization: true },
      },
    },
  });

  return NextResponse.json(
    {
      membership: {
        id: membership.id,
        role: membership.role,
        collection: {
          id: membership.collection.id,
          name: membership.collection.name,
        },
        organization: {
          id: membership.collection.organization.id,
          name: membership.collection.organization.name,
        },
        user: {
          id: membership.user.id,
          email: membership.user.email,
          name: membership.user.name,
        },
        createdAt: membership.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
