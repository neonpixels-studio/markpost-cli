// GENERATED FILE — do not hand-edit.
//
// This is a vendored, verbatim copy of markpost's `server/types/api.types.ts`.
// markpost is the source of truth for the request/response contract; the CLI
// mirrors it here instead of re-deriving it by hand so the two can't quietly
// drift apart the way `ApiData` (attributes+errors on one object) did before.
//
// Regenerate with `npm run sync:contract` (see README.md#contract-sync).
// The drift test at tests/types/contract-drift.test.ts fails if this file's
// exports or the CLI's usage of them stop lining up.
//
// Source: neonpixels-studio/markpost @ server/types/api.types.ts
// See src/types/vendor/manifest.json for the exact commit this was synced from.

export type ApiError = {
  status: string;
  title: string;
  detail: string;
  source?: { pointer?: string; parameter?: string };
};

export type ApiRequest = {
  data: {
    attributes: object;
  };
};

export type ApiResourceObject = {
  type: string;
  id: string;
  attributes: object;
  links?: { self: string };
};

type ApiResponseBase = {
  meta?: Record<string, unknown>;
  links?: Record<string, string | null>;
};

export type ApiResponse<T = ApiResourceObject | ApiResourceObject[] | null> =
  | (ApiResponseBase & { data: T; errors?: never })
  | (ApiResponseBase & { errors: ApiError[]; data?: never });

// Sort values accepted by GET /api/records via `sort`. A leading `-` means
// descending. Omitting `sort` is equivalent to `-createdAt` (newest first).
// Records have no updated-at column, so createdAt is the only sortable field.
export type RecordSort = "createdAt" | "-createdAt";

// Query parameters accepted by GET /api/records.
// `filter[tag]` uses AND semantics: a record must carry every listed tag. A
// single value is split on commas ("a,b"); a repeated param is read literally,
// so a tag containing a comma is sent as `filter[tag]=a,b&filter[tag]=a,b`.
export type RecordListQuery = {
  "page[size]"?: string;
  "page[after]"?: string;
  "filter[source]"?: string;
  "filter[status]"?: string;
  "filter[q]"?: string;
  "filter[tag]"?: string | string[];
  sort?: RecordSort;
};

// Query parameters accepted by GET /api/records/deletions, the tombstone feed
// a syncing client (markpost-cli) polls to learn which records were deleted
// server-side. `filter[since]` is an ISO 8601 timestamp (inclusive); omit it
// for everything still retained. Tombstones are kept for 30 days
// (RECORD_TOMBSTONE_RETENTION_DAYS), so a client offline longer must do a full
// reconcile. Results are ordered oldest-deleted first; page with `page[after]`
// (the last `recordUuid` returned). `meta.complete` is false when `since` is
// omitted or older than the retention window.
export type RecordDeletionListQuery = {
  "page[size]"?: string;
  "page[after]"?: string;
  "filter[since]"?: string;
};
