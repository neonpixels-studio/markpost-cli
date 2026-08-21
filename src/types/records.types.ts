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
