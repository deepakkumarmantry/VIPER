import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Roles, canManageApprovals, canViewAllContent } from "@/lib/rbac";
import { getManageableOrganizationIds, userCanManageOrganization } from "@/lib/access";

const approvalSchema = z.object({
  email: z.string().email("Valid email required"),
  organizationId: z
    .string()
    .uuid("Organization is required")
    .optional()
    .nullable(),
  collectionIds: z.array(z.string()).default([]),
  role: z
    .enum([
      Roles.USER,
      Roles.COLLECTION_ADMIN,
      Roles.ORGANIZATION_ADMIN,
      Roles.SUPER_USER,
      Roles.ADMIN,
    ])
    .default(Roles.USER),
});

export async function GET() {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageApprovals(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organizationIds = await getManageableOrganizationIds(session.user);

  const approvalsWhere = canViewAllContent(session.user.role)
    ? {}
    : {
        OR: [
          { organizationId: { in: organizationIds } },
          { organizationId: null },
        ],
      };

  const approvals = await prisma.approvedEmail.findMany({
    where: approvalsWhere,
    include: { organization: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ approvals }, { status: 200 });
}

export async function POST(request) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageApprovals(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json();
  const parsed = approvalSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const { email, collectionIds, role } = parsed.data;
  const organizationId = parsed.data.organizationId ?? null;

  const organizationIds = await getManageableOrganizationIds(session.user);

  const normalizedCollections = Array.from(new Set(collectionIds));

  const collectionRecords = normalizedCollections.length
    ? await prisma.collection.findMany({
        where: {
          id: { in: normalizedCollections },
        },
        select: { id: true, organizationId: true },
      })
    : [];

  if (collectionRecords.length !== normalizedCollections.length) {
    return NextResponse.json(
      { error: "One or more collections were not found." },
      { status: 400 },
    );
  }

  const collectionOrganizationIds = new Set(
    collectionRecords.map((collection) => collection.organizationId),
  );

  if (organizationId) {
    if (!organizationIds.includes(organizationId)) {
      return NextResponse.json(
        { error: "You do not have permission to manage this organization." },
        { status: 403 },
      );
    }

    if (!canViewAllContent(session.user.role)) {
      const canManage = await userCanManageOrganization(session.user, organizationId);
      if (!canManage) {
        return NextResponse.json(
          { error: "You do not have permission to manage this organization." },
          { status: 403 },
        );
      }
    }

    if (
      collectionOrganizationIds.size &&
      Array.from(collectionOrganizationIds).some((id) => id !== organizationId)
    ) {
      return NextResponse.json(
        { error: "One or more collections do not belong to the selected organization." },
        { status: 400 },
      );
    }
  } else if (collectionOrganizationIds.size > 1) {
    return NextResponse.json(
      { error: "Collections from multiple organizations require selecting an organization." },
      { status: 400 },
    );
  }

  if (!canViewAllContent(session.user.role)) {
    const organizationsToValidate = organizationId
      ? [organizationId]
      : Array.from(collectionOrganizationIds);

    for (const orgId of organizationsToValidate) {
      if (!organizationIds.includes(orgId)) {
        return NextResponse.json(
          { error: "You do not have permission to manage this organization." },
          { status: 403 },
        );
      }

      const canManage = await userCanManageOrganization(session.user, orgId);
      if (!canManage) {
        return NextResponse.json(
          { error: "You do not have permission to manage this organization." },
          { status: 403 },
        );
      }
    }
  }

  if (organizationId) {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
  }

  await prisma.approvedEmail.upsert({
    where: { email: email.toLowerCase() },
    create: {
      email: email.toLowerCase(),
      organizationId,
      collectionIds: normalizedCollections,
      role,
    },
    update: {
      organizationId,
      collectionIds: normalizedCollections,
      role,
    },
  });

  return NextResponse.json({ message: "Approval saved" }, { status: 201 });
}
