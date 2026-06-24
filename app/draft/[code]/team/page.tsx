"use client";

import { Fragment, useEffect, useState, use, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
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
import PlayerCard from "@/components/player-card";
import ChangesBanner from "@/components/changes-banner";
import LineupRefresh from "@/components/lineup-refresh";
import { getPlayerByKey } from "@/lib/players";
import { getUserLabel } from "@/lib/users";
import type { Change } from "@/lib/effective-lineup";

type ContestInfo = {
  code: string;
  matchKey: string;
  matchLabel: string;
  matchDeadline: number;
  picksPerUser: number;
  backupsPerUser: number;
  mode: "live" | "manual";
  status: string;
};

type PickRow = {
  playerKey: string;
  playerName: string;
  playerRole: string;
  playerTeam: string;
  pickedBy: string;
  pickNumber: number;
};

type SelectionRow = {
  user: string;
  selectedPlayers: string[] | string;
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
  effectiveChanges?: string | null; // JSON Change[] — frozen post-lock by the results route
} | null;

type PageData = {
  contest: ContestInfo;
  picks: PickRow[];
  playerPool: { key: string; displayName: string; role: string; teamCode: string; efppm: number; tourPoints: number | null; isLikelyXI: boolean; takenBy: string | null }[];
  username: string;
  mySelection: SelectionRow;
  allSelections: { user: string; selectedPlayers: string[] | string; captainKey: string | null; viceCaptainKey: string | null; isLocked: boolean }[];
  participants: string[];
  lineups: { announced: boolean; toss: string | null; perTeam: Record<string, boolean> };
};

// selectedPlayers is stored as a JSON string in the DB
function parsePlayers(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function ManualPool({
  pool,
  selectedSet,
  opponentKey,
  opponentPicked,
  canAddMore,
  onAdd,
}: {
  pool: { key: string; displayName: string; role: string; teamCode: string; efppm: number; tourPoints: number | null; isLikelyXI: boolean }[];
  selectedSet: Set<string>;
  opponentKey: string | null;
  opponentPicked: Set<string>;
  canAddMore: boolean;
  onAdd: (key: string) => void;
}) {
  const available = pool.filter((p) => !selectedSet.has(p.key));
  if (available.length === 0) return null;
  const xi = available.filter((p) => p.isLikelyXI);
  const bench = available.filter((p) => !p.isLikelyXI);
  return (
    <div className="space-y-2 pt-2 border-t border-hair">
      <h2 className="text-sm font-semibold text-mist uppercase tracking-wider px-1">Player Pool</h2>
      <div className="space-y-1.5">
        {xi.map((p) => {
          const taken = opponentPicked.has(p.key);
          return (
            <PlayerCard
              key={p.key}
              playerKey={p.key}
              displayName={p.displayName}
              role={p.role}
              teamCode={p.teamCode}
              efppm={p.efppm}
              tourPoints={p.tourPoints}
              takenBy={taken ? opponentKey : null}
              isMyTurn={!taken && canAddMore}
              onClick={!taken && canAddMore ? () => onAdd(p.key) : undefined}
            />
          );
        })}
        {bench.length > 0 && xi.length > 0 && (
          <div className="flex items-center gap-2 py-1 px-1">
            <div className="flex-1 h-px bg-navy" />
            <p className="text-[10px] text-mist2 uppercase tracking-widest">Others</p>
            <div className="flex-1 h-px bg-navy" />
          </div>
        )}
        {bench.map((p) => {
          const taken = opponentPicked.has(p.key);
          return (
            <PlayerCard
              key={p.key}
              playerKey={p.key}
              displayName={p.displayName}
              role={p.role}
              teamCode={p.teamCode}
              efppm={p.efppm}
              tourPoints={p.tourPoints}
              takenBy={taken ? opponentKey : null}
              isMyTurn={!taken && canAddMore}
              onClick={!taken && canAddMore ? () => onAdd(p.key) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function useCountdown(deadlineTs: number) {
  const [remaining, setRemaining] = useState(() => deadlineTs - Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(deadlineTs - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineTs]);

  if (remaining <= 0) return "Teams locked";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (h > 0) return `${h}h ${m}m to lock`;
  if (m > 0) return `${m}m ${s}s to lock`;
  return `${s}s to lock`;
}

// One draggable row in the priority ranking. Defined at module scope (not inside
// TeamPage) so its useSortable hook keeps a stable identity across re-renders.
// Only the grip handle carries the drag listeners, so the C/VC buttons stay
// tappable and the page still scrolls normally on touch.
function SortablePlayerRow({
  id,
  index,
  displayName,
  role,
  teamCode,
  efppm,
  tourPoints,
  xiStatus,
  compact,
  isLocked,
  onCaptain,
  onVice,
}: {
  id: string;
  index: number;
  displayName: string;
  role: string;
  teamCode: string;
  efppm: number;
  tourPoints: number | null;
  xiStatus: "in" | "out" | null;
  compact: boolean;
  isLocked: boolean;
  onCaptain: () => void;
  onVice: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: isLocked });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1.5 ${isDragging ? "relative opacity-90" : ""}`}
    >
      <span className="w-5 shrink-0 text-center text-xs font-mono text-mist2">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <PlayerCard
          playerKey={id}
          displayName={displayName}
          role={role}
          teamCode={teamCode}
          efppm={efppm}
          tourPoints={tourPoints}
          takenBy={null}
          isSelected
          isCaptain={index === 0}
          isViceCaptain={index === 1}
          onCaptainClick={isLocked ? undefined : onCaptain}
          onViceCaptainClick={isLocked ? undefined : onVice}
          isMyTurn={!isLocked}
          compact={compact}
          xiStatus={xiStatus}
        />
      </div>
      {!isLocked && (
        <button
          {...attributes}
          {...listeners}
          aria-label={`Drag ${displayName} to reorder`}
          className="shrink-0 h-10 w-8 grid place-items-center rounded-md bg-navy hover:bg-navy2 text-mist cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default function TeamPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const router = useRouter();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState("");

  const initializedRef = useRef(false);

  // My team — a single priority ranking of the full squad.
  // Index 0 = highest priority = Captain; index 1 = Vice-Captain. On match day
  // the top `picksPerUser` who are actually playing form the scoring XI.
  const [ranking, setRanking] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Drag-to-reorder. PointerSensor (distance 6) covers mouse + touch; the grip
  // handle is `touch-none` so dragging it never scrolls the page. Keyboard sensor
  // makes it accessible (focus the handle, Space, arrow keys).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRanking((r) => {
      const from = r.indexOf(active.id as string);
      const to = r.indexOf(over.id as string);
      if (from < 0 || to < 0) return r;
      return arrayMove(r, from, to);
    });
  }

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}`);
    if (res.status === 401) { router.push("/"); return; }
    if (!res.ok) {
      setError("Failed to load team data.");
      return;
    }
    const d: PageData = await res.json();
    setData(d);

    if (initializedRef.current) return;
    initializedRef.current = true;

    const players = parsePlayers(d.mySelection?.selectedPlayers);
    if (players.length > 0) {
      // Normalize legacy rows: float the stored C/VC to the top two so the
      // ranking's head matches the armband (new model: C = #1, VC = #2).
      const c = d.mySelection?.captainKey;
      const vc = d.mySelection?.viceCaptainKey;
      const head = [c, vc].filter(
        (k): k is string => !!k && players.includes(k)
      );
      const rest = players.filter((k) => !head.includes(k));
      setRanking([...head, ...rest]);
    } else if (d.contest.mode === "live") {
      const myPicks = (d.picks ?? [])
        .filter((p) => p.pickedBy === d.username)
        .sort((a, b) => a.pickNumber - b.pickNumber);
      setRanking(myPicks.map((p) => p.playerKey));
    }
  }, [code]);

  useEffect(() => {
    async function joinAndFetch() {
      // Ensure user is in contestParticipants regardless of how they arrived
      await fetch(`/api/draft/${code}/join`, { method: "POST" });
      fetchData();
    }
    joinAndFetch();
  }, [code, fetchData]);

  const isManual = data?.contest.mode === "manual";

  // Poll opponent's picks every 5s for manual drafts (no real-time turn order)
  useEffect(() => {
    if (!isManual) return;
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [isManual, fetchData]);

  const LOCK_BUFFER = 15 * 60;
  const lockTs = (data?.contest?.matchDeadline ?? 0) + LOCK_BUFFER;

  const isLocked =
    data?.mySelection?.isLocked ||
    (data?.contest?.mode === "live" &&
      data?.contest?.matchDeadline != null &&
      Math.floor(Date.now() / 1000) >= lockTs);

  const countdown = useCountdown(lockTs);

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    const res = await fetch(`/api/draft/${code}/team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // The ranking IS the team; C/VC are its first two (server re-derives too).
        selectedPlayers: ranking,
        captainKey: ranking[0] ?? null,
        viceCaptainKey: ranking[1] ?? null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      router.push(`/match/${data?.contest.matchKey}`);
    } else {
      const err = await res.json().catch(() => ({}));
      setSaveError(err.error ?? "Save failed. Try again.");
    }
  }

  // Move a player to an absolute rank (others slide to fill the gap).
  function moveToIndex(key: string, target: number) {
    setRanking((r) => {
      const i = r.indexOf(key);
      if (i < 0) return r;
      const t = Math.max(0, Math.min(r.length - 1, target));
      if (i === t) return r;
      const copy = [...r];
      copy.splice(i, 1);
      copy.splice(t, 0, key);
      return copy;
    });
  }

  // Tapping C/VC promotes the player to rank #1 / #2 — the new model's top two
  // are Captain & Vice. Everyone else slides down preserving their order.
  function setCaptain(key: string) {
    moveToIndex(key, 0);
  }

  function setVC(key: string) {
    moveToIndex(key, 1);
  }

  function addNew(key: string) {
    const ppu = data?.contest.picksPerUser ?? 11;
    const bpu = data?.contest.backupsPerUser ?? 4;
    setRanking((r) => (r.length < ppu + bpu ? [...r, key] : r));
  }

  if (error) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-mist">Loading…</p>
      </main>
    );
  }

  const ppu = data.contest.picksPerUser;
  const bpu = data.contest.backupsPerUser;
  const selectedSet = new Set(ranking);

  // Frozen post-lock substitution log for MY team (written by the results route
  // once lineups are out). Empty/absent until then.
  let myChanges: Change[] = [];
  if (data.mySelection?.effectiveChanges) {
    try {
      myChanges = JSON.parse(data.mySelection.effectiveChanges) as Change[];
    } catch {
      myChanges = [];
    }
  }

  // Official-lineup status for the swap helper: show In XI / Not in XI per player
  // only once that player's team's lineup is actually announced.
  const poolByKey = new Map(data.playerPool.map((p) => [p.key, p]));
  const lineupsMeta = data.lineups;
  function xiStatusFor(keyVal: string): "in" | "out" | null {
    const meta = poolByKey.get(keyVal);
    if (!meta) return null;
    if (!lineupsMeta?.perTeam?.[meta.teamCode]) return null; // lineup not out yet
    return meta.isLikelyXI ? "in" : "out";
  }

  // Opponent's team
  const opponent = data.participants.find((u) => u !== data.username);
  const opponentSel = data.allSelections.find((s) => s.user === opponent);
  const opponentPlayers = parsePlayers(opponentSel?.selectedPlayers);
  const opponentStarters = opponentPlayers.slice(0, ppu);
  const opponentBackups = opponentPlayers.slice(ppu);

  function OpponentPlayerRow({ keyVal, isCaptain, isVC, compact }: { keyVal: string; isCaptain: boolean; isVC: boolean; compact?: boolean }) {
    const p = getPlayerByKey(keyVal);
    if (!p) return null;
    return (
      <PlayerCard
        playerKey={keyVal}
        displayName={p.displayName}
        role={p.role}
        teamCode={p.teamCode}
        efppm={p.efppm}
        tourPoints={poolByKey.get(keyVal)?.tourPoints ?? null}
        takenBy={null}
        isSelected
        isCaptain={isCaptain}
        isViceCaptain={isVC}
        isMyTurn={false}
        compact={compact}
      />
    );
  }

  return (
    <main className="min-h-screen bg-ink text-white pb-28">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${data.contest.matchKey}`} className="text-mist hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{data.contest.matchLabel}</h1>
            <p className="text-xs text-mist">{countdown}</p>
          </div>
          <Link href={`/draft/${code}/results`} className="text-xs text-gold hover:brightness-110 font-mono">
            Results →
          </Link>
        </div>

        {/* Refresh the lineup — manual + auto-check at roundlock. Available whether
            you've picked or are still building, so you can pull the official XI
            the moment it posts (rows below flip to In XI / Not in XI). */}
        <LineupRefresh
          announced={!!data.lineups?.announced}
          roundlockTs={lockTs}
          onRefresh={fetchData}
        />

        {isLocked && (
          <div className="bg-navy rounded-xl px-4 py-3 text-center">
            <p className="text-mist font-medium">
              🔒 Team locked ·{" "}
              <Link href={`/draft/${code}/results`} className="text-gold">View results</Link>
            </p>
          </div>
        )}

        {/* Lineup status — when official XIs are out, the rows show In XI / Not in XI */}
        {data.lineups?.announced && (
          <div className="rounded-xl px-4 py-2.5 bg-emerald-950 border border-emerald-500/60 space-y-0.5">
            <p className="text-xs text-emerald-200">
              <span className="font-extrabold uppercase tracking-wider text-emerald-300">🟢 Lineups Out</span>
              {data.lineups.toss ? <span className="text-emerald-300/70"> · 🪙 {data.lineups.toss}</span> : null}
            </p>
            {!isLocked && (
              <p className="text-[11px] text-emerald-300/70">Swap anyone marked ✗ Not in XI for a player who&apos;s ✓ In XI.</p>
            )}
          </div>
        )}

        {/* What backup intelligence did to my team (post-lock, once lineups are out) */}
        <ChangesBanner changes={myChanges} />

        {/* ── MY TEAM (one priority-ranked list) ── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-mist uppercase tracking-wider px-1">
            My Team — ranked by priority
          </p>

          {/* Call out the auto-backup behaviour up front so it's predictable */}
          {!isLocked && (
            <div className="rounded-xl px-3 py-2 bg-ink2 border border-hair space-y-1">
              <p className="text-[11px] text-cloud leading-relaxed">
                Drag the ⠿ handle to rank your squad.{" "}
                <span className="text-yellow-400 font-bold">①</span> = Captain (2×),{" "}
                <span className="text-blue-400 font-bold">②</span> = Vice (1.5×) — tap{" "}
                <span className="text-yellow-400 font-bold">C</span>/
                <span className="text-blue-400 font-bold">VC</span> to promote anyone (even a backup) to the top.
              </p>
              <p className="text-[11px] text-mist2 leading-relaxed">
                On match day we field your top {ppu} who are{" "}
                <span className="text-emerald-400">playing</span>. If someone&apos;s out, the next-ranked
                playing player slides up — and the armband passes down to your next playing pick.
              </p>
            </div>
          )}

          {ranking.length === 0 ? (
            <p className="text-mist2 text-sm py-2 px-1">
              {isManual ? "Tap players below to add them" : "Your players from the draft"}
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={ranking} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {ranking.map((key, i) => {
                    const p = getPlayerByKey(key);
                    return (
                      <Fragment key={key}>
                        <SortablePlayerRow
                          id={key}
                          index={i}
                          displayName={p?.displayName ?? key}
                          role={p?.role ?? "BAT"}
                          teamCode={p?.teamCode ?? ""}
                          efppm={p?.efppm ?? 0}
                          tourPoints={poolByKey.get(key)?.tourPoints ?? null}
                          xiStatus={xiStatusFor(key)}
                          compact={i >= ppu}
                          isLocked={!!isLocked}
                          onCaptain={() => setCaptain(key)}
                          onVice={() => setVC(key)}
                        />
                        {i === ppu - 1 && ranking.length > ppu && (
                          <div className="flex items-center gap-2 py-1.5 px-1">
                            <div className="flex-1 h-px bg-navy2" />
                            <p className="text-[10px] text-mist2 uppercase tracking-widest whitespace-nowrap">
                              ↑ top {ppu} = your XI · drag backups up ↓
                            </p>
                            <div className="flex-1 h-px bg-navy2" />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {isManual && !isLocked && (
            <ManualPool
              pool={data.playerPool}
              selectedSet={selectedSet}
              opponentKey={opponentSel?.user ?? null}
              opponentPicked={new Set(opponentPlayers)}
              canAddMore={ranking.length < ppu + bpu}
              onAdd={addNew}
            />
          )}
        </div>

        {/* ── OPPONENT'S TEAM ── */}
        <div className="space-y-1 pt-2 border-t border-hair">
          <p className="text-xs font-semibold text-mist uppercase tracking-wider px-1">
            {opponent ? `${getUserLabel(opponent)}'s Team` : "Opponent's Team"}
          </p>

          {!opponentSel ? (
            <p className="text-mist2 text-sm py-3 px-1">
              {opponent ? `${getUserLabel(opponent)} hasn't set their team yet` : "Waiting for opponent…"}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-cloud">Starting XI</h2>
                  <span className="text-xs text-mist2">{opponentStarters.length}/{ppu}</span>
                </div>
                <div className="space-y-1">
                  {opponentStarters.map((key) => (
                    <OpponentPlayerRow
                      key={key}
                      keyVal={key}
                      isCaptain={key === opponentSel.captainKey}
                      isVC={key === opponentSel.viceCaptainKey}
                    />
                  ))}
                </div>
              </div>

              {bpu > 0 && opponentBackups.length > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-sm font-semibold text-mist2">Bench</h2>
                    <span className="text-xs text-mist2">{opponentBackups.length}/{bpu}</span>
                  </div>
                  <div className="space-y-1">
                    {opponentBackups.map((key) => (
                      <OpponentPlayerRow
                        key={key}
                        keyVal={key}
                        isCaptain={false}
                        isVC={false}
                        compact
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Save button */}
      {!isLocked && (
        <div className="fixed bottom-0 inset-x-0 p-3 bg-ink/95 backdrop-blur border-t border-hair">
          <div className="max-w-lg mx-auto space-y-2">
            {ranking.length < ppu && ranking.length > 0 && (
              <p className="text-yellow-400 text-xs text-center">
                Need at least {ppu} ranked players — currently {ranking.length}
              </p>
            )}
            {saveError && <p className="text-red-400 text-xs text-center">{saveError}</p>}
            <button
              onClick={handleSave}
              disabled={saving || ranking.length < ppu}
              className="w-full h-12 rounded-xl bg-gold hover:brightness-110 disabled:bg-navy2 disabled:text-mist2 disabled:shadow-none text-ink font-bold uppercase tracking-wide glow-gold transition"
            >
              {saving ? "Saving…" : "Save Team"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
