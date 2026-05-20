import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { buildContentAccessWhere, userCanManageCollection } from "@/lib/access";
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

  const contentId = params?.contentId;
  if (!contentId) {
    return NextResponse.json({ error: "Content id is required" }, { status: 400 });
  }

  const content = await prisma.content.findFirst({
    where: buildContentAccessWhere(session.user, contentId),
    select: {
      id: true,
      collectionId: true,
      videoUrl: true,
      processingMetadata: true,
    },
  });

  if (!content) {
    return NextResponse.json({ error: "Content not found" }, { status: 404 });
  }

  if (!canViewAllContent(session.user.role) && !canManageCollections(session.user.role)) {
    const canManage = await userCanManageCollection(session.user, content.collectionId);
    if (!canManage) {
      return NextResponse.json(
        { error: "You do not have permission to delete this content." },
        { status: 403 },
      );
    }
  }

  const blobUrls = collectBlobUrls(content.videoUrl);

  const metadata = content.processingMetadata;
  if (metadata && typeof metadata === "object") {
    collectBlobUrls(metadata, blobUrls);
  }

  const cobraMeta = metadata?.cobra;
  const searchDocumentIds = collectSearchDocumentIds(cobraMeta);

  await deleteBlobUrls(Array.from(blobUrls));
  await deleteSearchDocuments(searchDocumentIds, { contentId: content.id });

  await prisma.content.delete({ where: { id: content.id } });

  return NextResponse.json({ success: true }, { status: 200 });
}
