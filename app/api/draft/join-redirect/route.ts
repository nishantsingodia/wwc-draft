import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.toUpperCase().trim();
  if (!code) return NextResponse.redirect(new URL("/lobby", request.url));
  return NextResponse.redirect(new URL(`/draft/${code}`, request.url));
}
