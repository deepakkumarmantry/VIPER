import { NextResponse } from "next/server";

const PROTECTED_MATCHER = ["/dashboard", "/admin", "/collections", "/content"];

function getAuthMode() {
  return (process.env.VIPER_AUTH_MODE || "easyauth").trim().toLowerCase();
}

function isProtectedPath(pathname) {
  return PROTECTED_MATCHER.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function middleware(request) {
  if (!isProtectedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (getAuthMode() === "anonymous") {
    return NextResponse.next();
  }

  if (request.headers.get("x-ms-client-principal")) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/.auth/login/aad";
  loginUrl.search = "";
  loginUrl.searchParams.set(
    "post_login_redirect_uri",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/collections/:path*", "/content/:path*"],
};
