import type { ApiResourceObject, ApiResponse } from '@/types/api.types.js';

// Mirrors markpost's frontmatter shape (server/utils/markdown.ts
// `FrontmatterObject`): the object markpost assembles at ingestion and stores
// in the record's `frontmatter` jsonb column. markpost is the source of truth
// for this shape; keep it in sync by hand.
export type Frontmatter = {
  title: string;
  source: string;
  created: string;
  tags: string[];
};

export type Record = {
  uuid: string;
  createdAt: string;
  title: string;
  content: string;
  // markpost's recordSerializer (server/utils/response.ts) returns these on
  // every record: `status` is the lifecycle state (pending/synced/error) the
  // `records list --status` filter already keys off, and `syncedAt` is when
  // the record was last written to disk (null until first synced). Typed
  // optional so older/off-contract responses that omit them still parse.
  status?: string | null;
  syncedAt?: string | null;
  // The failure reason markpost's markRecordError sets on a webhook-ingestion
  // failure (server/api/hooks/[slug].post.ts), surfaced via recordSerializer
  // (server/utils/response.ts) on every record. markpost's PATCH endpoint
  // only clears it when a caller explicitly sends `errorMessage: null` (see
  // `ERROR_STATUS`'s doc comment in src/libs/records.ts), so it can stay
  // populated even after the record's status has moved on from `error` —
  // callers must gate display on the CURRENT `status`, not on this field's
  // presence alone. Typed optional, like `status`/`syncedAt` above, for
  // older/off-contract responses that omit it.
  //
  // This gate applies to the CLI's human-readable text output only:
  // `--json` intentionally passes through the raw API value unfiltered
  // (matching every other field), so a `--json` consumer must apply the
  // same `status === "error"` check itself before treating errorMessage as
  // current.
  errorMessage?: string | null;
  // Present on records markpost ingested through its markdown pipeline
  // (webhook/email); null for records created with only a title + content
  // (e.g. `markpost push`). Typed for good DX, but treated as untrusted JSON
  // at runtime — see src/libs/frontmatter.ts.
  source?: string | null;
  tags?: string[] | null;
  frontmatter?: Frontmatter | null;
};

export type PaginatedRecordsMeta = {
  total: number;
  size: number;
  hasMore: boolean;
};

// The JSON:API resource object markpost's `recordSerializer`
// (`server/utils/response.ts`) actually produces for a record: `attributes`
// plus the `type`/`id`/`links` envelope fields the old `ApiData` type dropped.
export type RecordResource = ApiResourceObject & {
  type: 'records';
  attributes: Record;
};

export type RecordApiResponse = ApiResponse<RecordResource | null>;

export type RecordListApiResponse = ApiResponse<RecordResource[]>;

// Mirrors markpost's `RecordExportRow` (server/utils/recordExport.ts) — the
// shape `GET /api/records/export` returns for each record. Copied by hand
// like `Frontmatter` above: this is a `server/utils` export, not part of the
// vendored `server/types/api.types.ts` contract `scripts/sync-contract.mjs`
// keeps in sync automatically, and the export response isn't JSON:API-wrapped
// (see server/api/records/export.get.ts), so it has no `RecordResource`
// counterpart either.
export type RecordExportRow = {
  uuid: string;
  createdAt: string;
  title: string;
  content: string;
  source: string | null;
  sourceId: string | null;
  status: string;
  filePath: string | null;
  tags: unknown;
  frontmatter: unknown;
  syncedAt: string | null;
  errorMessage: string | null;
};
