import { redirect } from "next/navigation";
import { getCurrentSession, getLoginUrl } from "@/lib/auth";
import prisma from "@/lib/prisma";
import AdminPanel from "@/components/admin/admin-panel";
import {
  canAccessAdmin,
  canCreateCollections,
  canManageApprovals,
  canManageCollections,
  canManageOrganizations,
  canManageUsers,
  canViewAllContent,
  getRoleOptions,
} from "@/lib/rbac";
import { getManageableOrganizationIds } from "@/lib/access";

function serializeOrganization(organization) {
  return {
    id: organization.id,
    name: organization.name,
    description: organization.description ?? "",
    collections: organization.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description ?? "",
      visibility: collection.visibility,
    })),
  };
}

function serializeApproval(approval) {
  return {
    id: approval.id,
    email: approval.email,
    organization: approval.organization
      ? {
          id: approval.organization.id,
          name: approval.organization.name,
        }
      : null,
    createdAt: approval.createdAt.toISOString(),
    role: approval.role,
  };
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    organizations: user.organizations.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      role: membership.role,
    })),
    collections: user.collections.map((membership) => ({
      id: membership.collection.id,
      name: membership.collection.name,
      role: membership.role,
      organization: {
        id: membership.collection.organization.id,
        name: membership.collection.organization.name,
      },
    })),
  };
}

export default async function AdminPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(getLoginUrl("/admin"));
  }

  if (!canAccessAdmin(session.user.role)) {
    redirect("/dashboard");
  }

  const canSeeAll = canViewAllContent(session.user.role);
  let manageableOrganizationIds = [];

  if (canSeeAll) {
    const organizations = await prisma.organization.findMany({ select: { id: true } });
    manageableOrganizationIds = organizations.map((organization) => organization.id);
  } else {
    manageableOrganizationIds = await getManageableOrganizationIds(session.user);
  }

  const organizationWhere = canSeeAll
    ? {}
    : manageableOrganizationIds.length
        ? { id: { in: manageableOrganizationIds } }
        : { id: { in: [] } };

  const organizations = await prisma.organization.findMany({
    where: organizationWhere,
    include: {
      collections: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          visibility: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const approvalsWhere = canSeeAll
    ? {}
    : manageableOrganizationIds.length
        ? { organizationId: { in: manageableOrganizationIds } }
        : { organizationId: { in: [] } };

  const approvals = await prisma.approvedEmail.findMany({
    where: approvalsWhere,
    include: { organization: true },
    orderBy: { createdAt: "desc" },
  });

  const usersWhere = canSeeAll
    ? {}
    : manageableOrganizationIds.length
        ? {
            OR: [
              {
                organizations: {
                  some: {
                    organizationId: { in: manageableOrganizationIds },
                  },
                },
              },
              {
                collections: {
                  some: {
                    collection: {
                      organizationId: { in: manageableOrganizationIds },
                    },
                  },
                },
              },
            ],
          }
        : { id: { in: [] } };

  const users = await prisma.user.findMany({
    where: usersWhere,
    include: {
      organizations: {
        include: { organization: true },
      },
      collections: {
        include: {
          collection: {
            include: { organization: true },
          },
        },
      },
    },
    orderBy: { email: "asc" },
  });

  const safeOrganizations = organizations.map(serializeOrganization);
  const safeApprovals = approvals.map(serializeApproval);
  const safeUsers = users.map(serializeUser);

  const permissions = {
    canManageOrganizations: canManageOrganizations(session.user.role),
    canManageCollections: canManageCollections(session.user.role),
    canCreateCollections: canCreateCollections(session.user.role),
    canManageUsers: canManageUsers(session.user.role),
    canManageApprovals: canManageApprovals(session.user.role),
  };

  const roleOptions = getRoleOptions(session.user.role);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <AdminPanel
        approvals={safeApprovals}
        organizations={safeOrganizations}
        permissions={permissions}
        roleOptions={roleOptions}
        users={safeUsers}
      />
    </div>
  );
}
