import type { ApiResourceObject, ApiResponse } from '@/types/api.types.js';

// Mirrors markpost's canonical source-type list (shared/utils/sourceTypes.ts).
// Keep in lockstep: the server rejects any type absent here with a 400. RSS was
// dropped in markpost#116 (no polling infrastructure to ingest it), so it must
// stay out of this list — see tests/types/sources.types.test.ts.
export const SOURCE_TYPES = [
  'webhook',
  'email',
  'stripe',
  'github',
  'zapier',
  'shortcuts',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export type Source = {
  uuid: string;
  createdAt: string;
  type: SourceType;
  name: string;
  provider: string | null;
  endpointSlug: string;
  routeFolder: string;
  lastHitAt: string | null;
  recordCount: number;
};

export type CreateSourceInput = {
  type: SourceType;
  name: string;
  routeFolder: string;
  provider?: string;
};

// Mirrors markpost's PATCH /api/sources/[uuid] payload, which only accepts
// routeFolder and fieldMapping updates.
export type UpdateSourceInput = {
  routeFolder?: string;
  fieldMapping?: unknown;
};

// The JSON:API resource object markpost's `sourceSerializer`
// (`server/utils/response.ts`) actually produces for a source: `attributes`
// plus the `type`/`id`/`links` envelope fields the old `ApiData` type dropped.
export type SourceResource = ApiResourceObject & {
  type: 'sources';
  attributes: Source;
};

export type SourceApiResponse = ApiResponse<SourceResource | null>;

export type SourceListApiResponse = ApiResponse<SourceResource[]>;
