import { redirect } from "next/navigation";
import { getCurrentSession, getLoginUrl } from "@/lib/auth";
import prisma from "@/lib/prisma";
import DashboardLayoutShell from "@/components/dashboard/layout-shell";
import {
  canAccessAdmin,
  canCreateCollections,
  canManageCollections,
  canViewAllContent,
} from "@/lib/rbac";

async function getSidebarData(user) {
  const canSeeAll = canViewAllContent(user.role);

  const organizationWhere = canSeeAll
    ? {}
    : {
        OR: [
          {
            memberships: {
              some: {
                userId: user.id,
              },
            },
          },
          {
            collections: {
              some: {
                memberships: {
                  some: {
                    userId: user.id,
                  },
                },
              },
            },
          },
        ],
      };

  const collectionWhere = canSeeAll
    ? {}
    : {
        OR: [
          {
            memberships: {
              some: {
                userId: user.id,
              },
            },
          },
          {
            organization: {
              memberships: {
                some: {
                  userId: user.id,
                  role: {
                    in: ["ADMIN", "OWNER"],
                  },
                },
              },
            },
          },
          {
            visibility: "PUBLIC",
            organization: {
              memberships: {
                some: {
                  userId: user.id,
                },
              },
            },
          },
        ],
      };

  const organizations = await prisma.organization.findMany({
    where: organizationWhere,
    include: {
      collections: {
        where: collectionWhere,
        orderBy: {
          name: "asc",
        },
        include: {
          contents: {
            orderBy: {
              createdAt: "desc",
            },
            take: 5,
            select: {
              id: true,
              title: true,
            },
          },
        },
      },
    },
    orderBy: {
      name: "asc",
    },
  });

  return organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    collections: organization.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      visibility: collection.visibility,
      contents: collection.contents,
    })),
  }));
}

export default async function DashboardLayout({ children }) {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(getLoginUrl("/dashboard"));
  }

  const sidebarData = await getSidebarData(session.user);
  const canSeeAllContent = canViewAllContent(session.user.role);

  const collectionWhere = canSeeAllContent
    ? {}
    : {
        OR: [
          {
            memberships: {
              some: {
                userId: session.user.id,
              },
            },
          },
          {
            organization: {
              memberships: {
                some: {
                  userId: session.user.id,
                  role: {
                    in: ["ADMIN", "OWNER"],
                  },
                },
              },
            },
          },
          {
            visibility: "PUBLIC",
            organization: {
              memberships: {
                some: {
                  userId: session.user.id,
                },
              },
            },
          },
        ],
      };

  const uploadCollections = await prisma.collection.findMany({
    where: collectionWhere,
    select: {
      id: true,
      name: true,
      description: true,
      visibility: true,
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
      _count: {
        select: {
          contents: true,
        },
      },
    },
    orderBy: {
      name: "asc",
    },
  });

  const managementOrganizationsWhere = canSeeAllContent
    ? {}
    : {
        OR: [
          {
            memberships: {
              some: {
                userId: session.user.id,
              },
            },
          },
          {
            collections: {
              some: {
                memberships: {
                  some: {
                    userId: session.user.id,
                  },
                },
              },
            },
          },
        ],
      };

  const managementOrganizations = await prisma.organization.findMany({
    where: managementOrganizationsWhere,
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: "asc",
    },
  });

  const defaultUploadCollectionId = uploadCollections[0]?.id ?? null;

  return (
    <DashboardLayoutShell
      headerProps={{
        canCreateCollections: canCreateCollections(session.user.role),
        canManageCollections: canManageCollections(session.user.role),
        defaultCollectionId: defaultUploadCollectionId,
        managementOrganizations,
        uploadCollections,
        user: session.user,
      }}
      isAdmin={canAccessAdmin(session.user.role)}
      organizations={sidebarData}
    >
      {children}
    </DashboardLayoutShell>
  );
}
