import { redirect } from "next/navigation";
import { getCurrentSession, getLoginUrl } from "@/lib/auth";
import prisma from "@/lib/prisma";
import DashboardView from "@/components/dashboard/dashboard-view";
import {
  canCreateCollections,
  canDeleteContent,
  canManageCollections,
  canViewAllContent,
} from "@/lib/rbac";
import { serializeCollections } from "@/lib/serialization";

export default async function DashboardPage({ searchParams }) {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(getLoginUrl("/dashboard"));
  }

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

  const collections = await prisma.collection.findMany({
    where: collectionWhere,
    include: {
      organization: true,
      contents: {
        orderBy: {
          createdAt: "desc",
        },
        include: {
          uploadedBy: true,
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
    include: {
      collections: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const safeManagementOrganizations = managementOrganizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    description: organization.description ?? null,
    collections: organization.collections,
  }));

  const safeCollections = await serializeCollections(collections);
  const allContents = safeCollections.flatMap((collection) =>
    collection.contents.map((content) => ({
      ...content,
      organization: collection.organization,
      collection: {
        id: collection.id,
        name: collection.name,
      },
    })),
  );

  const contentId = searchParams?.contentId;
  const selectedContent =
    allContents.find((content) => content.id === contentId) ?? allContents[0] ?? null;

  const initialSearchStart = searchParams?.start ?? searchParams?.t ?? null;

  return (
    <DashboardView
      collections={safeCollections}
      selectedContent={selectedContent}
      managementOrganizations={safeManagementOrganizations}
      canManageCollections={canManageCollections(session.user.role)}
      canCreateCollections={canCreateCollections(session.user.role)}
      canDeleteContent={canDeleteContent(session.user.role)}
      initialSearchStart={initialSearchStart}
    />
  );
}
