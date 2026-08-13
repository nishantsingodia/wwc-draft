import { redirect } from "next/navigation";

/**
 * The old match hub, retired.
 *
 * It sat between the lobby and the results page and, of its seven blocks, four were already
 * on the lobby verbatim — same crests, same status, same refresh, same draft rows. Tapping a
 * match therefore cost a screen that showed nothing new before you tapped again to reach the
 * score. Its three genuinely unique controls (rain delay, joining an open draft, creating
 * one) moved into the match card's "···" sheet on the lobby, which now also carries the
 * scoreline and the head-to-head those two screens never showed at all.
 *
 * Kept as a redirect rather than deleted so shared/bookmarked `/match/…` links still land
 * somewhere sensible.
 */
export default async function MatchRedirect({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await params;
  redirect("/lobby");
}
