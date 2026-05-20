import { notFound, redirect } from "next/navigation";

import { getCurrentSession, getLoginUrl } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildCollectionAccessWhere } from "@/lib/access";
import { canDeleteCollection } from "@/lib/rbac";
import { serializeCollection } from "@/lib/serialization";
import CollectionOverview from "@/components/dashboard/collection-overview";

export default async function CollectionPage({ params }) {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(getLoginUrl(`/dashboard/collections/${params?.collectionId || ""}`));
  }

  const collectionId = params?.collectionId;
  if (!collectionId) {
    notFound();
  }

  const collectionRecord = await prisma.collection.findFirst({
    where: buildCollectionAccessWhere(session.user, collectionId),
    include: {
      organization: true,
      contents: {
        orderBy: { createdAt: "desc" },
        include: {
          uploadedBy: true,
        },
      },
    },
  });

  if (!collectionRecord) {
    notFound();
  }

  const collection = await serializeCollection(collectionRecord);

  return (
    <CollectionOverview
      collection={collection}
      canDeleteCollection={canDeleteCollection(session.user.role)}
    />
  );
}
