"use client";

import { useRouter } from "next/navigation";
import RefreshPoints from "./refresh-points";

// Match-level wrapper for the "Refresh live points" control. A refresh triggers a
// whole-match bot run (scores every contest on this match), so it lives on the match
// page rather than per-draft. onRefreshed re-renders the server component so match
// status (live → completed) and any derived state update once the run lands.
export default function MatchRefresh({ matchStarted }: { matchStarted: boolean }) {
  const router = useRouter();
  return <RefreshPoints matchStarted={matchStarted} onRefreshed={() => router.refresh()} />;
}
