"use client";

import { Fragment, use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { GripVertical } from "lucide-react";
import { getFlag, getPlayerByKey, prettifyMatchLabel, getTeamName } from "@/lib/players";
import { getUserLabel } from "@/lib/users";

/**
 * AMEND LINEUP — the post-lock, approval-gated correction screen for a LIVE or
 * COMPLETED match.
 *
 * It exists for the case the draft board structurally can't cover: a player added to a
 * squad after the pool was built. You can't draft someone the app has never heard of, so
 * the workaround was to draft a dummy stand-in and remember he "was" the real player —
 * which scores nothing, because points join on identity. Here the full match roster
 * (including that late addition, straight off ESPN with their registry pid) is listed,
 * and you swap the stand-in for the real person. Points then resolve normally.
 *
 * Everything on this screen changes a locked team, so nothing takes effect on one
 * person's say-so: it goes out as a single reviewable request — the diff, the reason,
 * and the exact points swing — and applies only once every other stakeholder approves.
 */

type Settles = "ok" | "pending" | "broken";

type PlayerView = {
  key: string;
  name: string;
  role: string;
  team: string;
  pid: string | null;
  points: number | null;
  settles: Settles;
};

type RosterPlayer = {
  key: string;
  pid: string | null;
  name: string;
  role: string;
  team: string;
  inXI: boolean;
  batOrder: number;
  source: "seed" | "espn" | "sheet";
  identity: "pid" | "name";
  photo: string | null;
  offSeed: boolean;
  points: number | null;
  draftedBy: string | null;
  settles: Settles;
};

type Ref = { key: string; name: string; team: string; role: string };

type Pending = {
  id: number;
  user: string;
  requestedBy: string;
  reason: string;
  createdAt: number;
  approvals: string[];
  approvers: string[];
  waitingOn: string[];
  pointsDelta: number | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
  diff: {
    replacements: { out: Ref; in: Ref; identity: "pid" | "name" }[];
    moves: { key: string; name: string; from: number; to: number }[];
    captain: { from: Ref | null; to: Ref | null } | null;
    vice: { from: Ref | null; to: Ref | null } | null;
    intoXI: Ref[];
    outOfXI: Ref[];
  };
  warnings: string[];
  canApprove: boolean;
  canCancel: boolean;
};

type AmendData = {
  username: string;
  contest: {
    code: string;
    matchKey: string;
    matchLabel: string;
    picksPerUser: number;
    mode: "live" | "manual";
  };
  match: { team1: string; team2: string };
  open: boolean;
  completed: boolean;
  pointsSource: "live-espn" | "sheet";
  roster: { espnAvailable: boolean; byTeam: { team: string; players: RosterPlayer[] }[] };
  squads: {
    user: string;
    ranking: PlayerView[];
    points: number | null;
    editable: boolean;
    warnings: string[];
  }[];
  taken: string[];
  pending: Pending[];
};

const ROLE_TONE: Record<string, string> = {
  WK: "text-rwk",
  BAT: "text-rbat",
  AR: "text-rar",
  BOWL: "text-rbowl",
};

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toFixed(1);
}

export default function AmendPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);

  const [data, setData] = useState<AmendData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Draft state for the amendment being composed (never touches the server until sent).
  const [editUser, setEditUser] = useState<string | null>(null);
  const [ranking, setRanking] = useState<string[]>([]);
  const [replacements, setReplacements] = useState<{ outKey: string; inKey: string }[]>([]);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  // Drag-to-reorder, identical to the team page: PointerSensor covers mouse + touch,
  // and only the grip handle carries the listeners so the ⇄ / ↺ buttons stay tappable
  // and the page still scrolls normally on a phone.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRanking((r) => {
      const from = r.indexOf(String(active.id));
      const to = r.indexOf(String(over.id));
      return from < 0 || to < 0 ? r : arrayMove(r, from, to);
    });
  }

  const load = useCallback(
    async (keepDraft = false) => {
      const res = await fetch(`/api/draft/${code}/amend`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Could not load");
        return;
      }
      const d: AmendData = await res.json();
      setData(d);
      const mine = d.squads.find((s) => s.editable) ?? d.squads[0];
      if (!keepDraft) {
        setEditUser(mine?.user ?? null);
        setRanking(mine?.ranking.map((p) => p.key) ?? []);
        setReplacements([]);
        setPickingFor(null);
        setReason("");
      }
    },
    [code]
  );

  useEffect(() => {
    async function init() {
      await load();
    }
    init();
  }, [load]);

  const squad = useMemo(
    () => data?.squads.find((s) => s.user === editUser) ?? null,
    [data, editUser]
  );

  // Points for everyone we might show: the squad's own rows plus the whole match roster.
  const pointsByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of data?.squads ?? []) for (const p of s.ranking) m.set(p.key, p.points);
    for (const t of data?.roster.byTeam ?? []) for (const p of t.players) m.set(p.key, p.points);
    return m;
  }, [data]);

  const settlesByKey = useMemo(() => {
    const m = new Map<string, Settles>();
    for (const s of data?.squads ?? []) for (const p of s.ranking) m.set(p.key, p.settles);
    for (const t of data?.roster.byTeam ?? []) for (const p of t.players) m.set(p.key, p.settles);
    return m;
  }, [data]);

  const rosterByKey = useMemo(() => {
    const m = new Map<string, RosterPlayer>();
    for (const t of data?.roster.byTeam ?? []) for (const p of t.players) m.set(p.key, p);
    return m;
  }, [data]);

  const original = useMemo(() => squad?.ranking.map((p) => p.key) ?? [], [squad]);
  const substituted = useMemo(() => {
    const sub = new Map(replacements.map((r) => [r.outKey, r.inKey]));
    return original.map((k) => sub.get(k) ?? k);
  }, [original, replacements]);

  const dirty = useMemo(
    () =>
      replacements.length > 0 ||
      ranking.length !== substituted.length ||
      ranking.some((k, i) => k !== substituted[i]),
    [ranking, substituted, replacements]
  );

  const ppu = data?.contest.picksPerUser ?? 11;

  // Live preview of what the change is worth, computed the same way the server will:
  // sum the top-`ppu` with C ×2 and VC ×1.5. This is a preview of the *intended* XI —
  // the server re-runs it through the substitution engine before anyone approves.
  const previewDelta = useMemo(() => {
    const total = (order: string[]) =>
      order.slice(0, ppu).reduce((sum, k, i) => {
        const p = pointsByKey.get(k);
        return sum + (p ?? 0) * (i === 0 ? 2 : i === 1 ? 1.5 : 1);
      }, 0);
    return total(ranking) - total(substituted);
  }, [ranking, substituted, pointsByKey, ppu]);

  function nameOf(key: string): string {
    return rosterByKey.get(key)?.name ?? getPlayerByKey(key)?.displayName ?? key;
  }
  function roleOf(key: string): string {
    return rosterByKey.get(key)?.role ?? getPlayerByKey(key)?.role ?? "BAT";
  }
  function teamOf(key: string): string {
    return rosterByKey.get(key)?.team ?? getPlayerByKey(key)?.teamCode ?? "";
  }

  function moveTo(key: string, target: number) {
    const rest = ranking.filter((k) => k !== key);
    setRanking([...rest.slice(0, target), key, ...rest.slice(target)]);
  }
  function chooseReplacement(inKey: string) {
    const outKey = pickingFor;
    if (!outKey) return;
    setReplacements((prev) => [...prev.filter((r) => r.outKey !== outKey), { outKey, inKey }]);
    setRanking((prev) => prev.map((k) => (k === outKey ? inKey : k)));
    setPickingFor(null);
  }
  function undoReplacement(inKey: string) {
    const r = replacements.find((x) => x.inKey === inKey);
    if (!r) return;
    setReplacements((prev) => prev.filter((x) => x.inKey !== inKey));
    setRanking((prev) => prev.map((k) => (k === inKey ? r.outKey : k)));
  }
  function reset() {
    setRanking(original);
    setReplacements([]);
    setPickingFor(null);
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/draft/${code}/amend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Something went wrong");
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <main className="min-h-screen bg-ink p-4">
        <p className="text-live text-sm">{error}</p>
        <Link href={`/draft/${code}/results`} className="text-gold text-sm">← Back to results</Link>
      </main>
    );
  }
  if (!data) {
    return <main className="min-h-screen bg-ink p-4 text-mist text-sm">Loading…</main>;
  }

  const takenElsewhere = new Set(
    data.taken.filter((k) => !original.includes(k) && !replacements.some((r) => r.inKey === k))
  );

  return (
    <main className="min-h-screen bg-ink pb-24">
      <div className="max-w-xl mx-auto p-4 space-y-4">
        {/* ── header ── */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gold font-bold">Amend lineup</p>
            <h1 className="font-bold text-cloud leading-tight">
              {prettifyMatchLabel(data.contest.matchLabel)}
            </h1>
            <p className="text-xs text-mist">
              {data.completed ? (
                <span className="text-emerald-400">✅ Final</span>
              ) : (
                <span className="text-live">🔴 Live</span>
              )}
              {data.pointsSource === "live-espn" ? " · provisional points" : ""}
            </p>
          </div>
          <Link href={`/draft/${code}/results`} className="text-xs text-gold font-mono shrink-0 pt-1">
            Results →
          </Link>
        </div>

        {error && (
          <p className="rounded-xl bg-red-950 border border-live/50 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        )}

        {!data.open && (
          <p className="rounded-xl bg-navy border border-hair px-3 py-2 text-xs text-mist">
            This match hasn&apos;t started. Teams are still editable —{" "}
            <Link href={`/draft/${code}/team`} className="text-gold">edit your team</Link> instead.
          </p>
        )}

        {/* ── pending amendments (approve / reject / cancel) ── */}
        {data.pending.map((p) => (
          <PendingCard key={p.id} p={p} busy={busy} onAct={(action) => post({ action, id: p.id })} />
        ))}

        {/* ── my squad ── */}
        {data.open && squad && (
          <section className="space-y-2">
            {data.squads.filter((s) => s.editable).length > 1 && (
              <div className="flex items-center gap-1.5 rounded-xl bg-ink2 border border-hair p-1">
                {data.squads
                  .filter((s) => s.editable)
                  .map((s) => (
                    <button
                      key={s.user}
                      type="button"
                      onClick={() => {
                        setEditUser(s.user);
                        setRanking(s.ranking.map((p) => p.key));
                        setReplacements([]);
                        setPickingFor(null);
                      }}
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                        s.user === editUser ? "bg-gold text-ink" : "text-cloud hover:bg-navy"
                      }`}
                    >
                      {getUserLabel(s.user)}
                    </button>
                  ))}
              </div>
            )}

            <div className="flex items-baseline justify-between px-1">
              <p className="text-xs font-semibold text-mist uppercase tracking-wider">
                {getUserLabel(squad.user)}&apos;s squad — priority order
              </p>
              <p className="text-xs font-mono text-mist">
                {fmt(squad.points)} pts
                {dirty && (
                  <span className={previewDelta >= 0 ? " text-emerald-400" : " text-live"}>
                    {" "}
                    {previewDelta >= 0 ? "+" : ""}
                    {previewDelta.toFixed(1)}
                  </span>
                )}
              </p>
            </div>

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={ranking} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {ranking.map((key, i) => (
                    <Fragment key={key}>
                      <SortableSquadRow
                        id={key}
                        index={i}
                        ppu={ppu}
                        name={nameOf(key)}
                        role={roleOf(key)}
                        team={teamOf(key)}
                        points={pointsByKey.get(key) ?? null}
                        inXI={rosterByKey.get(key)?.inXI ?? null}
                        settles={settlesByKey.get(key)}
                        replacedName={
                          (() => {
                            const r = replacements.find((x) => x.inKey === key);
                            return r ? nameOf(r.outKey) : null;
                          })()
                        }
                        picking={pickingFor === key}
                        onReplace={() => setPickingFor(pickingFor === key ? null : key)}
                        onUndoReplace={() => undoReplacement(key)}
                        onCaptain={() => moveTo(key, 0)}
                        onVice={() => moveTo(key, 1)}
                      />
                      {i === ppu - 1 && ranking.length > ppu && (
                        <div className="flex items-center gap-2 py-1.5 px-1">
                          <div className="flex-1 h-px bg-navy2" />
                          <p className="text-[10px] text-mist2 uppercase tracking-widest whitespace-nowrap">
                            ↑ top {ppu} = the XI
                          </p>
                          <div className="flex-1 h-px bg-navy2" />
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {ranking.length > 2 && (
              <p className="text-[10px] text-mist2 px-1">
                Drag the ⠿ handle to re-rank. Rank 1 is Captain (×2), rank 2 is Vice (×1.5) — or tap{" "}
                <span className="text-yellow-400 font-bold">C</span> /{" "}
                <span className="text-blue-400 font-bold">VC</span> to promote anyone straight to the
                top. ⇄ swaps a stand-in for the real player.
              </p>
            )}

            {squad.warnings.length > 0 && (
              <div className="rounded-xl bg-amber-950/40 border border-amber-500/50 px-3 py-2 space-y-1">
                {squad.warnings.map((w) => (
                  <p key={w} className="text-[10.5px] text-amber-200 leading-snug">⚠ {w}</p>
                ))}
              </div>
            )}

            {/* ── submit ── */}
            {dirty && (
              <div className="rounded-xl bg-ink2 border border-gold/40 p-3 space-y-2">
                <p className="text-xs text-cloud font-semibold">
                  {(() => {
                    const others = data.squads.filter((s) => s.user !== squad.user).length;
                    return others > 0
                      ? "This needs the other players' approval before anything moves."
                      : "Nobody else has a stake here — this applies immediately.";
                  })()}
                </p>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Why? e.g. “Kamindu was a late addition — I drafted Perera as a stand-in for him.”"
                  className="w-full rounded-lg bg-navy border border-hair px-2.5 py-2 text-xs text-cloud placeholder:text-mist2 outline-none focus:border-gold/60"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || reason.trim().length < 5}
                    onClick={async () => {
                      const ok = await post({
                        action: "request",
                        user: squad.user,
                        ranking,
                        replacements,
                        reason,
                      });
                      if (ok) reset();
                    }}
                    className="flex-1 rounded-lg bg-gold text-ink font-bold text-sm py-2.5 disabled:opacity-40"
                  >
                    {busy ? "Sending…" : "Send for approval"}
                  </button>
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-lg border border-hair text-mist text-sm px-4"
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── everyone playing this match ── */}
        <section className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <p className="text-xs font-semibold text-mist uppercase tracking-wider">Playing this match</p>
            {pickingFor && (
              <button
                type="button"
                onClick={() => setPickingFor(null)}
                className="text-[11px] text-gold"
              >
                cancel swap
              </button>
            )}
          </div>

          {pickingFor && (
            <p className="rounded-xl bg-gold/10 border border-gold/40 px-3 py-2 text-xs text-gold">
              Choose the real player to replace <strong>{nameOf(pickingFor)}</strong>.
            </p>
          )}
          {!data.roster.espnAvailable && (
            <p className="rounded-xl bg-navy border border-hair px-3 py-2 text-[11px] text-mist">
              ESPN hasn&apos;t posted a roster for this match, so this list is the squad seed plus
              anyone the points sheet already knows. A same-day addition may be missing.
            </p>
          )}

          {data.roster.byTeam.map((t) => (
            <div key={t.team} className="space-y-1">
              <p className="text-[11px] font-bold text-cloud px-1 pt-1">
                {getFlag(t.team)} {getTeamName(t.team)}
              </p>
              {t.players.map((p) => {
                const mine = ranking.includes(p.key);
                const blocked = takenElsewhere.has(p.key);
                const selectable = !!pickingFor && !mine && !blocked;
                return (
                  <button
                    key={p.key}
                    type="button"
                    disabled={!selectable}
                    onClick={() => chooseReplacement(p.key)}
                    className={`w-full text-left rounded-xl border px-2.5 py-2 flex items-center gap-2 transition-colors ${
                      selectable
                        ? "bg-navy border-gold/50 hover:bg-navy2"
                        : "bg-ink2 border-hair opacity-80"
                    }`}
                  >
                    <span
                      className={`w-8 text-center text-[10px] font-mono shrink-0 ${
                        p.inXI ? "text-emerald-400" : "text-mist2"
                      }`}
                    >
                      {p.inXI ? (p.batOrder > 0 ? p.batOrder : "XI") : "—"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-cloud truncate">
                        {p.name}
                        {p.offSeed && (
                          <span
                            className="ml-1.5 text-[9px] font-bold uppercase tracking-wide text-gold"
                            title={`Not in the drafted pool — found on the ${p.source === "espn" ? "live ESPN match roster" : "points sheet"}`}
                          >
                            new
                          </span>
                        )}
                        {p.identity === "name" && (
                          <span
                            className="ml-1 text-[9px] text-amber-400"
                            title="No registry ID — points join by name. Add them in wwc-points-bot to make it identity-safe."
                          >
                            ⚠
                          </span>
                        )}
                        {p.settles === "broken" && (
                          <span
                            className="ml-1 text-[9px] font-bold uppercase tracking-wide text-amber-400"
                            title="This player does not resolve in the settled points sheet — picking them scores 0 once the match completes. Fix the registry in wwc-points-bot first."
                          >
                            won&apos;t settle
                          </span>
                        )}
                      </p>
                      <p className="text-[10px] text-mist2">
                        <span className={ROLE_TONE[p.role] ?? "text-mist2"}>{p.role}</span>
                        {p.draftedBy && <span> · drafted by {getUserLabel(p.draftedBy)}</span>}
                      </p>
                    </div>
                    <span className="text-xs font-mono w-14 text-right shrink-0">
                      {p.points === null && p.inXI && data.open ? (
                        <span
                          className="text-[9px] text-amber-400"
                          title="Featured, but the points sheet has no row for them yet."
                        >
                          not scored
                        </span>
                      ) : (
                        <span className="text-cloud">{data.open ? fmt(p.points) : ""}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

// One draggable row of the squad. Module scope (not nested in AmendPage) so its
// useSortable hook keeps a stable identity across re-renders. Only the grip carries the
// drag listeners — the C/VC/⇄ buttons stay tappable and the page still scrolls on touch.
function SortableSquadRow({
  id,
  index,
  ppu,
  name,
  role,
  team,
  points,
  inXI,
  settles,
  replacedName,
  picking,
  onReplace,
  onUndoReplace,
  onCaptain,
  onVice,
}: {
  id: string;
  index: number;
  ppu: number;
  name: string;
  role: string;
  team: string;
  points: number | null;
  inXI: boolean | null;
  settles?: Settles;
  replacedName: string | null;
  picking: boolean;
  onReplace: () => void;
  onUndoReplace: () => void;
  onCaptain: () => void;
  onVice: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border px-2 py-2 flex items-center gap-2 ${
        isDragging ? "relative opacity-90 border-gold" : ""
      } ${
        replacedName
          ? "bg-emerald-950/60 border-emerald-500/50"
          : index < ppu
            ? "bg-navy border-hair"
            : "bg-ink2 border-hair"
      }`}
    >
      <span
        className={`w-6 text-center text-xs font-mono font-bold shrink-0 ${
          index === 0 ? "text-yellow-400" : index === 1 ? "text-blue-400" : "text-mist2"
        }`}
      >
        {index === 0 ? "C" : index === 1 ? "VC" : index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-cloud truncate">
          {name}
          {inXI === false && <span className="ml-1.5 text-[10px] text-live">✗ not in XI</span>}
          {/* Played, but the points sheet has no row for them — the bot hasn't scored
              them. Say that, rather than showing a bare dash that reads as "zero". */}
          {inXI === true && points === null && (
            <span className="ml-1.5 text-[10px] text-amber-400" title="This player featured but the points sheet has no row for them yet — the bot hasn't scored them.">
              not scored yet
            </span>
          )}
          {settles === "broken" && inXI !== true && (
            <span className="ml-1.5 text-[10px] text-amber-400">⚠ won&apos;t settle</span>
          )}
        </p>
        <p className="text-[10px] text-mist2 truncate">
          <span className={ROLE_TONE[role] ?? "text-mist2"}>{role}</span>
          {" · "}
          {getFlag(team)} {team}
          {replacedName && <span className="text-emerald-400"> · replaces {replacedName}</span>}
        </p>
      </div>

      <span className="text-xs font-mono text-cloud w-11 text-right shrink-0">{fmt(points)}</span>

      <div className="flex items-center gap-0.5 shrink-0">
        {index !== 0 && (
          <IconBtn label={`Make ${name} captain`} onClick={onCaptain}>
            <span className="text-[10px] font-bold text-yellow-400">C</span>
          </IconBtn>
        )}
        {index !== 1 && (
          <IconBtn label={`Make ${name} vice-captain`} onClick={onVice}>
            <span className="text-[9px] font-bold text-blue-400">VC</span>
          </IconBtn>
        )}
        {replacedName ? (
          <IconBtn label="Undo replacement" onClick={onUndoReplace}>↺</IconBtn>
        ) : (
          <IconBtn
            label="Replace with a player from the match roster"
            onClick={onReplace}
            active={picking}
          >
            ⇄
          </IconBtn>
        )}
        <button
          {...attributes}
          {...listeners}
          aria-label={`Drag ${name} to re-rank`}
          className="shrink-0 h-8 w-7 grid place-items-center rounded-lg bg-navy hover:bg-navy2 text-mist cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`w-7 h-7 rounded-lg text-sm leading-none border transition-colors ${
        active
          ? "bg-gold text-ink border-gold"
          : "border-hair text-mist hover:text-cloud hover:bg-navy2 disabled:opacity-25"
      }`}
    >
      {children}
    </button>
  );
}

function PendingCard({
  p,
  busy,
  onAct,
}: {
  p: Pending;
  busy: boolean;
  onAct: (action: "approve" | "reject" | "cancel") => void;
}) {
  const delta = p.pointsDelta;
  return (
    <div className="rounded-xl bg-ink2 border border-gold/50 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold text-gold uppercase tracking-wider">
          Amendment · {getUserLabel(p.user)}&apos;s team
        </p>
        {delta !== null && (
          <span
            className={`text-xs font-mono font-bold ${delta > 0 ? "text-emerald-400" : delta < 0 ? "text-live" : "text-mist"}`}
          >
            {delta > 0 ? "+" : ""}
            {delta} pts
          </span>
        )}
      </div>

      <p className="text-xs text-cloud italic">“{p.reason}”</p>

      <ul className="space-y-1 text-[11px] text-mist">
        {p.diff.replacements.map((r) => (
          <li key={r.in.key}>
            <span className="text-live">{r.out.name}</span> →{" "}
            <span className="text-emerald-400 font-semibold">{r.in.name}</span>
            {r.identity === "name" && <span className="text-amber-400"> ⚠ name-matched</span>}
          </li>
        ))}
        {p.diff.captain && (
          <li>
            <span className="text-yellow-400 font-bold">C</span> {p.diff.captain.from?.name ?? "—"} →{" "}
            <span className="text-cloud font-semibold">{p.diff.captain.to?.name ?? "—"}</span>
          </li>
        )}
        {p.diff.vice && (
          <li>
            <span className="text-blue-400 font-bold">VC</span> {p.diff.vice.from?.name ?? "—"} →{" "}
            <span className="text-cloud font-semibold">{p.diff.vice.to?.name ?? "—"}</span>
          </li>
        )}
        {p.diff.intoXI.length > 0 && (
          <li>
            Into XI: <span className="text-emerald-400">{p.diff.intoXI.map((r) => r.name).join(", ")}</span>
          </li>
        )}
        {p.diff.outOfXI.length > 0 && (
          <li>
            Out of XI: <span className="text-live">{p.diff.outOfXI.map((r) => r.name).join(", ")}</span>
          </li>
        )}
        {p.diff.moves.length > 0 && (
          <li className="text-mist2">
            {p.diff.moves.map((m) => `${m.name} ${m.from}→${m.to}`).join(" · ")}
          </li>
        )}
      </ul>

      {p.warnings.map((w) => (
        <p key={w} className="text-[10px] text-amber-400/90 leading-snug">⚠ {w}</p>
      ))}

      <p className="text-[10px] text-mist2">
        {p.waitingOn.length > 0
          ? `Waiting on ${p.waitingOn.map(getUserLabel).join(", ")}`
          : "Ready to apply"}
        {p.approvals.length > 0 && ` · approved by ${p.approvals.map(getUserLabel).join(", ")}`}
      </p>

      <div className="flex gap-2">
        {p.canApprove && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct("approve")}
              className="flex-1 rounded-lg bg-emerald-500 text-ink font-bold text-sm py-2 disabled:opacity-40"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct("reject")}
              className="flex-1 rounded-lg border border-live/60 text-live font-semibold text-sm py-2 disabled:opacity-40"
            >
              Reject
            </button>
          </>
        )}
        {p.canCancel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct("cancel")}
            className="flex-1 rounded-lg border border-hair text-mist text-sm py-2 disabled:opacity-40"
          >
            Cancel my request
          </button>
        )}
      </div>
    </div>
  );
}
