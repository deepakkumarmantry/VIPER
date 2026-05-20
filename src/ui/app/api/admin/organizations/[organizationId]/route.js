import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { canManageOrganizations, canViewAllContent } from "@/lib/rbac";
import { userCanManageOrganization } from "@/lib/access";

const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2, "Organization name is required").optional(),
    description: z
      .string()
      .trim()
      .max(2000, "Description must be 2000 characters or fewer")
      .optional(),
  })
  .refine((data) => data.name != null || data.description != null, {
    message: "Provide a name or description to update.",
  });

export async function PATCH(request, { params }) {
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

  const body = await request.json().catch(() => ({}));
  const parsed = updateOrganizationSchema.safeParse(body);

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

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "Provide a name or description to update." },
      { status: 400 },
    );
  }

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: updates,
  });

  return NextResponse.json({ organization }, { status: 200 });
}
