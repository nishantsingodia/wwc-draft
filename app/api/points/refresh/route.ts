import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  COOLDOWN_SEC,
  MIN_HITS,
  isConfigured,
  latestRun,
  readQuota,
  dispatchRefresh,
} from "@/lib/github-refresh";

// GET — current refresh state + cricapi quota gauge. The client polls this to render the
// gauge, disable the button while a run is in flight, and detect when a run finishes.
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [run, quota] = await Promise.all([latestRun(), readQuota()]);
  const now = Math.floor(Date.now() / 1000);
  const cooldownRemaining = run.lastRunAt ? Math.max(0, COOLDOWN_SEC - (now - run.lastRunAt)) : 0;
  return NextResponse.json({
    configured: isConfigured(),
    running: run.running,
    lastRunAt: run.lastRunAt,
    lastRunUrl: run.lastRunUrl,
    conclusion: run.conclusion,
    cooldownRemaining,
    quota,
  });
}

// POST — a human tapped "Refresh live points". Guarded three ways before dispatch:
// already-running, cooldown, and near-exhausted cricapi budget.
export async function POST() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { error: "Live refresh isn't set up yet (missing GITHUB_DISPATCH_PAT)." },
      { status: 503 }
    );
  }

  const [run, quota] = await Promise.all([latestRun(), readQuota()]);

  if (run.running) {
    return NextResponse.json(
      { error: "A refresh is already running — points will update in ~1–2 min.", running: true },
      { status: 409 }
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (run.lastRunAt) {
    const remaining = COOLDOWN_SEC - (now - run.lastRunAt);
    if (remaining > 0) {
      return NextResponse.json(
        { error: `Just refreshed — try again in ${remaining}s.`, cooldownRemaining: remaining },
        { status: 429 }
      );
    }
  }

  if (quota?.hitsLeft != null && quota.hitsLeft < MIN_HITS) {
    return NextResponse.json(
      {
        error: `cricapi budget nearly out (${quota.hitsLeft} left today) — refresh paused to avoid overuse.`,
        quota,
      },
      { status: 409 }
    );
  }

  const d = await dispatchRefresh();
  if (!d.ok) {
    return NextResponse.json(
      { error: `Couldn't trigger the refresh (${d.status}). Try again shortly.`, detail: d.error },
      { status: 502 }
    );
  }

  return NextResponse.json({ status: "dispatched", quota });
}
