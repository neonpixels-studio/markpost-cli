// GENERATED FILE — do not hand-edit.
//
// This is a vendored, verbatim copy of markpost's `shared/utils/sourceTypes.ts`
// (markpost's canonical source-type list). markpost is the source of truth; `src/types/sources.types.ts`
// mirrors it by hand, and the drift test at
// `tests/types/sources.types.test.ts` fails if that mirror stops matching
// this file.
//
// Regenerate with `npm run sync:source-contract` (see
// README.md#source-and-settings-contract-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ shared/utils/sourceTypes.ts
// See tests/types/vendor/markpost-source-contract.manifest.json for the
// exact commit this was synced from.

// Canonical list of source types. Source creation
// (server/api/sources/index.post.ts) and the records list filter
// (server/api/records/index.get.ts) both import this so the set of types the
// API accepts and the set the filter recognizes can never drift apart. Nuxt
// auto-resolves `shared/` for both the app and server layers, so this is the
// one place that may define them.
//
// RSS/Atom is intentionally excluded: there is no polling infrastructure
// (scheduler, dedup, fetch cadence) anywhere in the codebase to service an
// "rss" source, so creating one would silently never ingest a single record.
// See https://github.com/neonpixels-studio/markpost/issues/116.
export const SOURCE_TYPES = [
  "webhook",
  "email",
  "stripe",
  "github",
  "zapier",
  "shortcuts",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

// applyFieldMapping (server/utils/fieldMapper.ts) has exactly one caller —
// the JSON webhook ingest handler (server/api/hooks/[slug].post.ts). Email
// deliveries take a different path (parseEmailPayload, via the direct
// record-create API) that never reads a source's fieldMapping. Shared so the
// sources UI's card (app/components/SourceCard.vue) and page
// (app/pages/sources.vue) agree on which type that carve-out applies to.
export const EMAIL_SOURCE_TYPE: SourceType = "email";

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

// The source test-event action (server/api/sources/[uuid]/test.post.ts) only
// ever exercises applyFieldMapping and the hooks endpoint's signature
// dispatch — both JSON-webhook-only, same as isSourceMappable's carve-out
// above. Shared here (not just repeated per call site) so the card
// (app/components/SourceCard.vue), the page's own guard
// (app/pages/sources.vue), and the endpoint's guard agree on exactly which
// type that applies to, rather than three separate `=== EMAIL_SOURCE_TYPE`
// comparisons that could individually drift if a new non-JSON-webhook source
// type were ever added.
// The source test-event action (server/api/sources/[uuid]/test.post.ts) only
// ever exercises applyFieldMapping and the hooks endpoint's signature
// dispatch — both JSON-webhook-only, same as isSourceMappable's carve-out
// above. Shared here (not just repeated per call site) so the card
// (app/components/SourceCard.vue), the page's own guard
// (app/pages/sources.vue), and the endpoint's guard agree on exactly which
// type that applies to, rather than three separate `=== EMAIL_SOURCE_TYPE`
// comparisons that could individually drift if a new non-JSON-webhook source
// type were ever added.
// Pause is only enforced by the hooks ingest endpoint
// (server/api/hooks/[slug].post.ts). Email-in has no inbound handler yet, so
// pausing an email source would do nothing; the card hides the control until
// one exists rather than showing a "paused" badge over live ingestion.
export function isSourcePausable(sourceType: string): boolean {
  return sourceType !== EMAIL_SOURCE_TYPE;
}

export function isSourceTestable(sourceType: string): boolean {
  return sourceType !== EMAIL_SOURCE_TYPE;
}

// Email-in addresses (clip-xxxx) are a mailbox the user hands to senders, not a
// URL credential, and there is no inbound handler to cut over, so only the
// webhook-style endpoints can have their slug rotated.
export function isSourceEndpointRotatable(sourceType: string): boolean {
  return sourceType !== EMAIL_SOURCE_TYPE;
}
