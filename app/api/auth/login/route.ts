import { NextRequest, NextResponse } from "next/server";
import { validateCode, createSession, COOKIE_NAME } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const { code } = await request.json();

  const username = validateCode(code ?? "");
  if (!username) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  const token = await createSession(username);

  const response = NextResponse.json({ username });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });

  return response;
}
