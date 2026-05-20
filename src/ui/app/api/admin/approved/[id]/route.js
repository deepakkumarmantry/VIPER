import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canManageApprovals, canViewAllContent } from "@/lib/rbac";
import { userCanManageOrganization } from "@/lib/access";

export async function DELETE(_request, { params }) {
  const session = await getCurrentSession();

  if (!session?.user?.id || !canManageApprovals(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const approval = await prisma.approvedEmail.findUnique({
    where: { id: params.id },
  });

  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  if (approval.organizationId && !canViewAllContent(session.user.role)) {
    const canManage = await userCanManageOrganization(
      session.user,
      approval.organizationId,
    );

    if (!canManage) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
  }

  await prisma.approvedEmail.delete({
    where: { id: params.id },
  });

  return NextResponse.json({ message: "Approval removed" }, { status: 200 });
}
