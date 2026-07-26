import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getMatchByKey } from "@/lib/matches";
import { addMatchDelay, setMatchDelay, getMatchDelay } from "@/lib/match-delay";

// Manually push a match's start/lock back (rain delay), or reset it.
// Body: { addMinutes?: number }  → add that many minutes (default 30)
//       { reset: true }          → clear the delay back to 0
// Any logged-in friend can adjust it (a rain delay is a shared, obvious call, and
// it's fully reversible via reset). Applies to the WHOLE match — every contest on it.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key } = await params;
  if (!getMatchByKey(key)) {
    return NextResponse.json({ error: "Match not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  let extraSeconds: number;
  if (body?.reset === true) {
    extraSeconds = await setMatchDelay(key, 0, username);
  } else {
    // Default the common case (a single "+30 min" tap). Bound the per-tap amount so a
    // bad value can't jump the match wildly; cumulative total is clamped in the lib.
    const mins = Number(body?.addMinutes);
    const addMinutes = Number.isFinite(mins) ? Math.max(5, Math.min(120, Math.round(mins))) : 30;
    extraSeconds = await addMatchDelay(key, addMinutes * 60, username);
  }

  return NextResponse.json({
    matchKey: key,
    extraSeconds,
    extraMinutes: Math.round(extraSeconds / 60),
    updatedBy: username,
  });
}

// Read the current delay (so a freshly-loaded control shows the right amount).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  const extraSeconds = await getMatchDelay(key);
  return NextResponse.json({ matchKey: key, extraSeconds, extraMinutes: Math.round(extraSeconds / 60) });
}
