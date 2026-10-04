// The generic envelope types below are re-exported from markpost's own
// contract (vendored in ./vendor/markpost-api.types.ts) rather than
// hand-mirrored, so the CLI can't silently drift from what the server
// actually sends. Run `npm run sync:contract` to refresh the vendored copy;
// see README.md#contract-sync.
//
// `ApiRequest` is deliberately NOT re-exported here: the CLI doesn't yet
// type its own request bodies (they're built as untyped literals in
// records.ts/sources.ts), and markpost's `ApiRequest` doesn't model the
// `data.type` discriminator every request the CLI actually sends includes.
// Wiring it in would mean inventing a CLI-side type that diverges from the
// vendored contract to route around that gap — exactly what this change is
// trying to avoid. Left as follow-up work; see the PR description.
export type {
  ApiError,
  ApiResourceObject,
  ApiResponse,
} from '#src/types/vendor/markpost-api.types.js';

import type { ApiError } from '#src/types/vendor/markpost-api.types.js';

// CLI-only additions below: shapes markpost's handlers return that aren't
// (and don't need to be) part of the shared generic contract.

// The records and sources delete handlers (`server/api/records/index.delete.ts`,
// `server/api/sources/[uuid].delete.ts`) return `{ meta: { deleted } }` directly
// on success — not an `ApiResponse<T>` (there's no `data`/`errors` union member
// here, just a bare meta object). Their error path still goes through the same
// `apiErrorHandler`, so failures still arrive as `ApiErrorEnvelope` (below).
export type ApiDeleteMeta = {
  deleted: number;
};

export type ApiDeleteResponse = {
  meta?: ApiDeleteMeta;
};

// The real error envelope markpost endpoints send on failure. `data.errors`
// is the wire format Nitro's error handler actually produces for a thrown
// `ApiError` (`throw createError({ statusCode, data: { errors } })` in
// markpost's `server/utils/errors.ts`) — that's the shape every error
// response the CLI has ever observed actually takes, regardless of whether
// the success shape is a single resource or a list.
//
// The top-level `errors` field mirrors the *other* branch of the vendored
// `ApiResponse<T>` union (`{ errors: ApiError[], data?: never }`): markpost's
// own declared contract allows a handler to return that shape directly
// (e.g. on a 2xx), even though none of today's handlers do — they all go
// through `apiErrorHandler`, which only ever produces `data.errors`. Both
// are checked so the CLI can't silently swallow errors from either
// legal shape.
export type ApiErrorEnvelope = {
  data?: {
    errors?: ApiError[];
  };
  errors?: ApiError[];
};

// markpost's own `links` bag is a generic `Record<string, string | null>`
// (`ApiResponseBase.links` in the vendored contract), but every endpoint the
// CLI actually calls (`server/utils/pagination.ts` -> `paginationLinks`)
// narrows that down to exactly `next`/`prev`. This mirrors that real,
// observed shape rather than the fully generic bag.
export type ApiPaginationLinks = {
  next: string | null;
  prev?: string | null;
};
