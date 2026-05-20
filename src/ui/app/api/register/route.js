import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json(
    { error: "Password registration is disabled. Use Entra ID EasyAuth." },
    { status: 410 },
  );
}
