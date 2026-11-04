// GENERATED FILE — do not hand-edit.
//
// SCOPE_NAMES is the list of `name` values in the `SCOPES`
// array of markpost's `shared/utils/scopes.ts`, which is the source of truth
// for the token scope allowlist.
//
// Regenerate with `npm run sync:scopes-contract` (see
// README.md#scopes-contract-sync). Review the diff, then commit.
//
// See src/types/vendor/markpost-scopes.manifest.json for the exact commit
// this was synced from.

export const SCOPE_NAMES = [
  "records:read",
  "records:write",
  "sources:read",
  "sources:write",
  "events:read",
  "tokens:read",
  "tokens:write",
  "settings:read",
  "settings:write",
  "billing:read",
  "billing:write",
  "account:write",
  "feedback:write",
] as const;

export type ScopeName = (typeof SCOPE_NAMES)[number];
