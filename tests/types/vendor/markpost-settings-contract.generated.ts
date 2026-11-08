// GENERATED FILE — do not hand-edit.
//
// CONFLICT_STRATEGIES below is a verbatim copy of markpost's
// `server/utils/response.ts` export of the same name.
// USER_SETTINGS_DEFAULTS is assembled from the `.default(...)` values on the
// matching columns of markpost's `userSettings` table in
// `server/db/schema.ts`. markpost is the source of truth for both;
// `src/types/settings.types.ts` mirrors them by hand, and the drift test at
// `tests/types/settings.types.test.ts` fails if that mirror stops matching
// this file.
//
// Regenerate with `npm run sync:settings-contract` (see
// README.md#source-and-settings-contract-sync). Review the diff, then commit.
//
// See tests/types/vendor/markpost-settings-contract.manifest.json for the
// exact commits this was synced from.

export const CONFLICT_STRATEGIES = ["suffix", "overwrite", "skip"] as const;

export const USER_SETTINGS_DEFAULTS = {
  autoSync: true,
  autoDelete: true,
  frontmatter: true,
  conflictStrategy: "suffix",
} as const;
