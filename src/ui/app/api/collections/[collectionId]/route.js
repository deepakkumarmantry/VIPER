import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  buildCollectionAccessWhere,
  userCanManageCollection,
} from "@/lib/access";
import { canManageCollections, canViewAllContent } from "@/lib/rbac";
import {
  collectBlobUrls,
  collectSearchDocumentIds,
  deleteBlobUrls,
  deleteSearchDocuments,
} from "@/lib/content-cleanup";

export async function DELETE(_request, { params }) {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const collectionId = params?.collectionId;
  if (!collectionId) {
    return NextResponse.json({ error: "Collection id is required" }, { status: 400 });
  }

  const collection = await prisma.collection.findFirst({
    where: buildCollectionAccessWhere(session.user, collectionId),
    include: {
      contents: {
        select: {
          id: true,
          videoUrl: true,
          processingMetadata: true,
        },
      },
    },
  });

  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  if (!canViewAllContent(session.user.role)) {
    if (!canManageCollections(session.user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const canManage = await userCanManageCollection(session.user, collection.id);
    if (!canManage) {
      return NextResponse.json(
        { error: "You do not have permission to delete this collection." },
        { status: 403 },
      );
    }
  }

  const blobUrlSet = collectBlobUrls();
  const searchIdSet = new Set();
  const contentIdSet = new Set();

  collection.contents.forEach((content) => {
    if (typeof content.id === "string" && content.id.trim().length) {
      contentIdSet.add(content.id.trim());
    }
    collectBlobUrls(content.videoUrl, blobUrlSet);
    if (content.processingMetadata && typeof content.processingMetadata === "object") {
      collectBlobUrls(content.processingMetadata, blobUrlSet);
      const cobraMeta = content.processingMetadata?.cobra;
      collectSearchDocumentIds(cobraMeta).forEach((id) => searchIdSet.add(id));
    }
  });

  await deleteBlobUrls(Array.from(blobUrlSet));
  await deleteSearchDocuments(Array.from(searchIdSet), {
    contentIds: Array.from(contentIdSet),
  });

  await prisma.$transaction([
    prisma.collectionMembership.deleteMany({ where: { collectionId: collection.id } }),
    prisma.content.deleteMany({ where: { collectionId: collection.id } }),
    prisma.collection.delete({ where: { id: collection.id } }),
  ]);

  return NextResponse.json({ success: true }, { status: 200 });
}
