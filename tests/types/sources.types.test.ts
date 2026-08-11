import { describe, expect, it } from 'vitest';

import { SOURCE_TYPES } from '@/types/sources.types.js';

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
