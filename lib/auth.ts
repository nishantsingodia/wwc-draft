import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { USERS } from "./users";

const COOKIE_NAME = "wwc_user";
const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "wwc-draft-secret-change-in-prod"
);

export function validateCode(code: string): string | null {
  return USERS[code.toUpperCase()] ?? null;
}

export async function createSession(username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(SECRET);
}

export async function getSession(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, SECRET);
    return (payload.username as string) ?? null;
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<string> {
  const user = await getSession();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

export { COOKIE_NAME };
