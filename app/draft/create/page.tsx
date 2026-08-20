import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import CreateDraft from "@/components/create-draft-form";

/**
 * Server shell so the form knows who "you" are.
 *
 * This page used to be a static client component, which is exactly why a manual draft could
 * only say HOW MANY friends and never WHICH: with no session there was no way to pre-select
 * and lock the creator, so the drafter list fell back to roster order. Reading the session
 * here costs the static prerender and buys an actual friend picker.
 */
export default async function CreateDraftPage() {
  const username = await getSession();
  if (!username) redirect("/");
  return <CreateDraft username={username} />;
}
