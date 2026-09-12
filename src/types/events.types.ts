import type { ApiResourceObject, ApiResponse } from '@/types/api.types.js';

// markpost's event kinds (server/db/schema.ts EVENT_KINDS): a webhook/email
// source that silently stops ingesting shows up here as a `warn`/`err` entry
// even though `records list` never sees it. Not re-exported from the vendored
// contract: EVENT_KINDS lives in markpost's schema, not its api.types.ts.
export const EVENT_KINDS = ['ok', 'dim', 'warn', 'err'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// Mirrors markpost's eventSerializer attributes (server/utils/response.ts).
// `kind` stays `string` (not `EventKind`) because it's untrusted API output —
// same reasoning as Record's `status` in records.types.ts — so an
// off-contract value still parses instead of failing the whole response.
export type Event = {
  id: string;
  userId: string;
  ts: string;
  kind: string;
  message: string;
  recordUuid: string | null;
  sourceId: string | null;
};

export type PaginatedEventsMeta = {
  total: number;
  size: number;
  hasMore: boolean;
};

// The JSON:API resource object markpost's `eventSerializer` actually
// produces: `attributes` plus the `type`/`id`/`links` envelope fields.
export type EventResource = ApiResourceObject & {
  type: 'events';
  attributes: Event;
};

export type EventListApiResponse = ApiResponse<EventResource[]>;
