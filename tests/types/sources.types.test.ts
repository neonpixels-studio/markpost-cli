import { describe, expect, it } from 'vitest';

import {
  isManualSecretProvider,
  isRotatableProvider,
  MANUAL_SECRET_PROVIDERS,
  ROTATABLE_PROVIDERS,
  SECRET_BACKED_PROVIDERS,
  SOURCE_TYPES,
} from '@/types/sources.types.js';

import { SOURCE_TYPES as MARKPOST_SOURCE_TYPES } from './vendor/markpost-source-types.generated.js';
import {
  MANUAL_SECRET_PROVIDER_IDS as MARKPOST_MANUAL_SECRET_PROVIDER_IDS,
  ROTATABLE_PROVIDER_IDS as MARKPOST_ROTATABLE_PROVIDER_IDS,
  SECRET_BACKED_PROVIDER_IDS as MARKPOST_SECRET_BACKED_PROVIDER_IDS,
} from './vendor/markpost-webhook-secrets.generated.js';

// Locks SOURCE_TYPES to the vendored copy of markpost's real
// shared/utils/sourceTypes.ts (see the rationale on SOURCE_TYPES in
// src/types/sources.types.ts), refreshed by hand via
// `npm run sync:source-contract` (README.md#source-and-settings-contract-sync)
// instead of a hardcoded literal — a hand-typed duplicate here is exactly
// what let this file list a source type (`rss`) markpost had already dropped
// (markpost#116, issue #78) with green tests. Order-insensitive: the
// contract is which types are offered, not their prompt display order.
describe('SOURCE_TYPES', () => {
  it('offers exactly the source types markpost accepts, and no others', () => {
    expect([...SOURCE_TYPES].sort()).toEqual([...MARKPOST_SOURCE_TYPES].sort());
  });
});

// Locks the provider-classification sets to the vendored copy of markpost's
// shared/utils/webhookSecrets.ts (MANUAL_SECRET_PROVIDER_IDS /
// SECRET_BACKED_PROVIDER_IDS / ROTATABLE_PROVIDER_IDS), refreshed by hand via
// `npm run sync:source-contract`. A drift here means the rotate-secret
// command prompts for a secret on the wrong provider — or offers rotation on
// a source markpost has no rotatable secret for.
describe('rotatable provider sets', () => {
  it('classifies the same providers as manual-secret as markpost does', () => {
    expect([...MANUAL_SECRET_PROVIDERS].sort()).toEqual(
      [...MARKPOST_MANUAL_SECRET_PROVIDER_IDS].sort(),
    );
  });

  it('classifies the same providers as generated secret-backed as markpost does', () => {
    expect([...SECRET_BACKED_PROVIDERS].sort()).toEqual(
      [...MARKPOST_SECRET_BACKED_PROVIDER_IDS].sort(),
    );
  });

  it('treats the same providers as rotatable as markpost does, and nothing else', () => {
    expect([...ROTATABLE_PROVIDERS].sort()).toEqual(
      [...MARKPOST_ROTATABLE_PROVIDER_IDS].sort(),
    );
  });

  it('recognises stripe as manual-secret and the generated providers as not', () => {
    expect(isManualSecretProvider('stripe')).toBe(true);
    expect(isManualSecretProvider('github')).toBe(false);
  });

  it('treats a null or non-provider source as neither manual nor rotatable', () => {
    expect(isManualSecretProvider(null)).toBe(false);
    expect(isRotatableProvider(null)).toBe(false);
    expect(isRotatableProvider('webhook')).toBe(false);
  });

  it('recognises each rotatable provider', () => {
    expect(isRotatableProvider('stripe')).toBe(true);
    expect(isRotatableProvider('github')).toBe(true);
    expect(isRotatableProvider('zapier')).toBe(true);
    expect(isRotatableProvider('shortcuts')).toBe(true);
  });
});
