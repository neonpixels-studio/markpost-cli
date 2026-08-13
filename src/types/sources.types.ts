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

// Only markpost's create response reveals the one-time generated signing
// secret, and only for a secret-backed provider (github/zapier/shortcuts); it
// is null for providers that don't mint one and is absent from every
// list/get/update response. Modelling it on a create-only type (not the base
// `Source`) documents where the field appears; `createSourceCommand` then
// peels it off before the shared `printSource`, and the command tests enforce
// that list/update never leak it. See markpost server/utils/response.ts
// (sourceSerializer, revealProviderSecret) and computeProviderSecretPlan.
export type CreatedSource = Source & {
  providerSecret?: string | null;
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

// The create response is the one place the serializer reveals `providerSecret`,
// so its resource attributes are `CreatedSource`, not the base `Source`.
export type CreatedSourceResource = ApiResourceObject & {
  type: 'sources';
  attributes: CreatedSource;
};

export type CreateSourceApiResponse = ApiResponse<CreatedSourceResource | null>;
