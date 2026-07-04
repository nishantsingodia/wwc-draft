// Triggers the wwc-points-bot's "On-Demand Live Refresh" workflow (a human tapping
// "Refresh live points"), reports its run state, and reads the cricapi quota gauge the
// bot writes to the sheet's STATUS tab. The cricapi key never leaves the bot — this app
// only holds a GitHub PAT scoped to dispatch that one workflow.

const GH_API = "https://api.github.com";
const OWNER = process.env.GH_OWNER ?? "nishantsingodia";
const REPO = process.env.GH_REPO ?? "wwc-points-bot";
const WORKFLOW = process.env.GH_WORKFLOW ?? "on-demand-refresh.yml";
const REF = process.env.GH_REF ?? "main";
const PAT = process.env.GITHUB_DISPATCH_PAT;

// Minimum gap between taps, and the cricapi budget below which we stop refreshing.
export const COOLDOWN_SEC = Number(process.env.REFRESH_COOLDOWN_SEC ?? 90);
export const MIN_HITS = Number(process.env.REFRESH_MIN_HITS ?? 5);

export function isConfigured(): boolean {
  return !!PAT;
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export type RunState = {
  running: boolean;
  lastRunAt: number | null; // epoch seconds of the most recent run's creation
  lastRunUrl: string | null;
  conclusion: string | null; // "success" | "failure" | null (while running)
};

const IDLE_RUN: RunState = { running: false, lastRunAt: null, lastRunUrl: null, conclusion: null };

// Newest run of the on-demand workflow — powers both the "already running" guard and the
// cooldown (its created_at). Failures degrade to idle so a GitHub blip never blocks a tap.
export async function latestRun(): Promise<RunState> {
  if (!PAT) return IDLE_RUN;
  try {
    const res = await fetch(
      `${GH_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers: ghHeaders(), cache: "no-store" }
    );
    if (!res.ok) return IDLE_RUN;
    const data = (await res.json()) as {
      workflow_runs?: { status: string; created_at: string; html_url?: string; conclusion?: string | null }[];
    };
    const run = data.workflow_runs?.[0];
    if (!run) return IDLE_RUN;
    const ms = Date.parse(run.created_at);
    return {
      // GitHub run statuses that mean "not finished yet".
      running: ["queued", "in_progress", "requested", "waiting", "pending"].includes(run.status),
      lastRunAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
      lastRunUrl: run.html_url ?? null,
      conclusion: run.conclusion ?? null,
    };
  } catch {
    return IDLE_RUN;
  }
}

export async function dispatchRefresh(): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!PAT) return { ok: false, status: 503, error: "not_configured" };
  try {
    const res = await fetch(
      `${GH_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: REF }),
        cache: "no-store",
      }
    );
    if (res.status === 204) return { ok: true, status: 204 }; // dispatch accepted (no body)
    const body = await res.text();
    return { ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 502, error: String(e) };
  }
}

export type Quota = {
  hitsLeft: number | null;
  hitsLimit: number | null;
  hitsUsed: number | null;
  updatedUtc: string | null;
};

// The STATUS tab lives in the same spreadsheet as the points tabs, so derive its gviz URL
// from the first POINTS_CSV_URLS entry (spreadsheet id) unless STATUS_CSV_URL is set. Returns
// null before the bot has ever written the tab (feature just degrades to "quota unknown").
function statusUrl(): string | null {
  if (process.env.STATUS_CSV_URL) return process.env.STATUS_CSV_URL;
  const first = (process.env.POINTS_CSV_URLS ?? process.env.POINTS_CSV_URL ?? "").split(",")[0]?.trim();
  const id = first?.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) return null;
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=STATUS&headers=1`;
}

export async function readQuota(): Promise<Quota | null> {
  const url = statusUrl();
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    // STATUS is a 2-col Metric|Value table. gviz quotes cells; values here have no commas.
    const map = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const cells = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      if (cells.length >= 2 && cells[0]) map.set(cells[0].toLowerCase(), cells[1]);
    }
    const num = (k: string): number | null => {
      const v = map.get(k);
      const n = v == null || v === "" ? NaN : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      hitsLeft: num("hits_left"),
      hitsLimit: num("hits_limit"),
      hitsUsed: num("hits_used"),
      updatedUtc: map.get("updated_utc") ?? null,
    };
  } catch {
    return null;
  }
}
