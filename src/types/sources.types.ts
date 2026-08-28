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

// Providers whose signing secret the user pastes in (the provider issues it),
// so rotation collects a new value rather than revealing a generated one.
// Mirrors markpost's MANUAL_SECRET_PROVIDER_IDS
// (shared/utils/webhookSecrets.ts); keep in lockstep — see
// tests/types/sources.types.test.ts.
export const MANUAL_SECRET_PROVIDERS = ['stripe'] as const;

// Providers whose secret markpost generates and reveals exactly once on
// rotation. Mirrors markpost's SECRET_BACKED_PROVIDER_IDS
// (shared/utils/webhookSecrets.ts); keep in lockstep.
export const SECRET_BACKED_PROVIDERS = [
  'github',
  'zapier',
  'shortcuts',
] as const;

// Every provider a source can rotate a secret for — the union of the manual
// and generated sets, mirroring markpost's ROTATABLE_PROVIDER_IDS. A source
// with any other provider (or none, e.g. a plain webhook/email source) has no
// rotatable secret.
export const ROTATABLE_PROVIDERS = [
  ...MANUAL_SECRET_PROVIDERS,
  ...SECRET_BACKED_PROVIDERS,
] as const;

export const isManualSecretProvider = (
  provider: string | null,
): provider is (typeof MANUAL_SECRET_PROVIDERS)[number] =>
  provider !== null &&
  (MANUAL_SECRET_PROVIDERS as readonly string[]).includes(provider);

export const isRotatableProvider = (
  provider: string | null,
): provider is (typeof ROTATABLE_PROVIDERS)[number] =>
  provider !== null &&
  (ROTATABLE_PROVIDERS as readonly string[]).includes(provider);

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

// Mirrors markpost's POST /api/sources/[uuid]/rotate-secret payload. Only a
// manual-secret provider (stripe) supplies `providerSecret`; for a generated
// provider (github/zapier/shortcuts) it is omitted and markpost mints a fresh
// secret it reveals once. See markpost server/api/sources/[uuid]/rotate-secret.post.ts.
export type RotateSourceSecretInput = {
  providerSecret?: string;
};

// The JSON:API resource object markpost's `sourceSerializer`
// (`server/utils/response.ts`) actually produces for a source: `attributes`
// plus the `type`/`id`/`links` envelope fields the old `ApiData` type dropped.
export type SourceResource = ApiResourceObject & {
  type: 'sources';
  attributes: Source;
};

export type SourceListApiResponse = ApiResponse<SourceResource[]>;

// The create and rotate-secret responses are the only places the serializer
// reveals `providerSecret`, so their resource attributes are `CreatedSource`,
// not the base `Source`.
export type CreatedSourceResource = ApiResourceObject & {
  type: 'sources';
  attributes: CreatedSource;
};
