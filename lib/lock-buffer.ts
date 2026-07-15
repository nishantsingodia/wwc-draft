// The post-start grace window during which a team can still be edited before it
// locks. Kept in its own tiny module (no matches.json import) so client components
// — e.g. the draft board's redirect guard — can import the constant without pulling
// the whole schedule into their bundle. Previously hardcoded as `30 * 60` in four
// places (results page, team page, lineup refresh); import this instead.
export const LOCK_BUFFER = 30 * 60; // 30 min
