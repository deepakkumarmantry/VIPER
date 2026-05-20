import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canManageOrganizations, canViewAllContent } from "@/lib/rbac";

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Organization name is required"),
  description: z
    .string()
    .trim()
    .max(2000, "Description must be 2000 characters or fewer")
    .optional()
    .nullable(),
});

function generateOrganizationSlug(name) {
  const base = (name || "organization")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const fallback = base || "organization";
  const suffix = randomUUID().slice(0, 8);
  return `${fallback}-${suffix}`.slice(0, 64);
}

export async function POST(request) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageOrganizations(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!canViewAllContent(session.user.role)) {
    return NextResponse.json(
      { error: "Only platform administrators can create new organizations." },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = createOrganizationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const name = parsed.data.name.trim();
  const description = parsed.data.description?.trim() || null;

  let attempts = 0;
  let slug = generateOrganizationSlug(name);

  while (attempts < 5) {
    try {
      const organization = await prisma.organization.create({
        data: {
          name,
          slug,
          description,
        },
      });

      return NextResponse.json({ organization }, { status: 201 });
    } catch (error) {
      if (error?.code === "P2002") {
        attempts += 1;
        slug = generateOrganizationSlug(`${name}-${attempts}`);
        continue;
      }

      return NextResponse.json(
        { error: "Unable to create organization" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json(
    { error: "Unable to generate a unique slug for the organization." },
    { status: 500 },
  );
}
