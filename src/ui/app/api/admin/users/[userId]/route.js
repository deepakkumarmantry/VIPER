import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  Roles,
  canManageUsers,
  canViewAllContent,
  canAssignRole,
  getAssignableRoles,
} from "@/lib/rbac";
import { getManageableOrganizationIds } from "@/lib/access";

const updateRoleSchema = z.object({
  role: z.enum([
    Roles.USER,
    Roles.COLLECTION_ADMIN,
    Roles.ORGANIZATION_ADMIN,
    Roles.SUPER_USER,
    Roles.ADMIN,
  ]),
});

export async function PATCH(request, { params }) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageUsers(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetUserId = params?.userId;

  if (!targetUserId) {
    return NextResponse.json({ error: "User id is required" }, { status: 400 });
  }

  const allowedRoles = getAssignableRoles(session.user.role);

  if (allowedRoles.length === 0) {
    return NextResponse.json({ error: "You do not have permission to manage roles." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = updateRoleSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const nextRole = parsed.data.role;

  if (!canAssignRole(session.user.role, nextRole)) {
    return NextResponse.json(
      { error: "You do not have permission to assign this role." },
      { status: 403 },
    );
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: {
      organizations: true,
      collections: {
        include: {
          collection: {
            select: {
              organizationId: true,
            },
          },
        },
      },
    },
  });

  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!canViewAllContent(session.user.role)) {
    const manageableOrganizationIds = await getManageableOrganizationIds(
      session.user,
    );

    if (!manageableOrganizationIds.length) {
      return NextResponse.json(
        { error: "You do not have permission to manage this user." },
        { status: 403 },
      );
    }

    const targetOrganizationIds = new Set(
      targetUser.organizations.map((membership) => membership.organizationId),
    );

    targetUser.collections.forEach((membership) => {
      if (membership.collection?.organizationId) {
        targetOrganizationIds.add(membership.collection.organizationId);
      }
    });

    const hasSharedOrganization = manageableOrganizationIds.some((id) =>
      targetOrganizationIds.has(id),
    );

    if (!hasSharedOrganization) {
      return NextResponse.json(
        { error: "You do not have permission to manage this user." },
        { status: 403 },
      );
    }
  }

  const updatedUser = await prisma.user.update({
    where: { id: targetUserId },
    data: { role: nextRole },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ user: updatedUser }, { status: 200 });
}
