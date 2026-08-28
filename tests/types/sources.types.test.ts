import { describe, expect, it } from 'vitest';

import {
  isManualSecretProvider,
  isRotatableProvider,
  MANUAL_SECRET_PROVIDERS,
  ROTATABLE_PROVIDERS,
  SECRET_BACKED_PROVIDERS,
  SOURCE_TYPES,
} from '@/types/sources.types.js';

// Locks SOURCE_TYPES to the set markpost's server accepts (see the rationale
// on SOURCE_TYPES in src/types/sources.types.ts), so any addition — most
// pointedly reintroducing the dropped `rss` type (markpost#116, issue #78) —
// is a deliberate edit that must also update this list. Order-insensitive:
// the contract is which types are offered, not their prompt display order.
const ACCEPTED_SOURCE_TYPES = [
  'webhook',
  'email',
  'stripe',
  'github',
  'zapier',
  'shortcuts',
] as const;

describe('SOURCE_TYPES', () => {
  it('offers exactly the source types markpost accepts, and no others', () => {
    expect([...SOURCE_TYPES].sort()).toEqual([...ACCEPTED_SOURCE_TYPES].sort());
  });
});

// Locks the provider-classification sets to markpost's
// shared/utils/webhookSecrets.ts (MANUAL_SECRET_PROVIDER_IDS /
// SECRET_BACKED_PROVIDER_IDS / ROTATABLE_PROVIDER_IDS). A drift here means the
// rotate-secret command prompts for a secret on the wrong provider — or offers
// rotation on a source markpost has no rotatable secret for.
describe('rotatable provider sets', () => {
  it('classifies stripe as the only manual-secret provider', () => {
    expect([...MANUAL_SECRET_PROVIDERS].sort()).toEqual(['stripe']);
  });

  it('classifies github/zapier/shortcuts as the generated secret-backed providers', () => {
    expect([...SECRET_BACKED_PROVIDERS].sort()).toEqual(
      ['github', 'shortcuts', 'zapier'],
    );
  });

  it('treats every manual and generated provider as rotatable, and nothing else', () => {
    expect([...ROTATABLE_PROVIDERS].sort()).toEqual(
      ['github', 'shortcuts', 'stripe', 'zapier'],
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
