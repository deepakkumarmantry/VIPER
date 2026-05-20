import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    { error: "NextAuth credentials are disabled. Use Entra ID EasyAuth." },
    { status: 410 },
  );
}

export const POST = GET;
