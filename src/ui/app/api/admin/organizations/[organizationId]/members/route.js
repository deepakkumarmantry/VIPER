import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { canManageOrganizations, canViewAllContent } from "@/lib/rbac";
import { userCanManageOrganization } from "@/lib/access";

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

  if (!session?.user?.id || !canManageOrganizations(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organizationId = params?.organizationId;

  if (!organizationId) {
    return NextResponse.json({ error: "Organization id is required" }, { status: 400 });
  }

  if (!canViewAllContent(session.user.role)) {
    const allowed = await userCanManageOrganization(session.user, organizationId);
    if (!allowed) {
      return NextResponse.json(
        { error: "You do not have permission to manage this organization." },
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

  const [user, organization] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } }),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const membership = await prisma.organizationMembership.upsert({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
    update: { role },
    create: {
      userId,
      organizationId,
      role,
    },
    include: {
      user: true,
      organization: true,
    },
  });

  return NextResponse.json(
    {
      membership: {
        id: membership.id,
        role: membership.role,
        organization: {
          id: membership.organization.id,
          name: membership.organization.name,
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
