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
