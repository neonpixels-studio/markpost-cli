import { describe, expect, it } from 'vitest';

import {
  CONFLICT_STRATEGIES,
  DEFAULT_AUTO_DELETE,
  DEFAULT_AUTO_SYNC,
  DEFAULT_CONFLICT_STRATEGY,
  DEFAULT_FRONTMATTER_ENABLED,
  isConflictStrategy,
  normalizeAutoDelete,
  normalizeAutoSync,
  normalizeConflictStrategy,
  normalizeFrontmatterEnabled,
} from '@/types/settings.types.js';

import {
  CONFLICT_STRATEGIES as MARKPOST_CONFLICT_STRATEGIES,
  USER_SETTINGS_DEFAULTS as MARKPOST_USER_SETTINGS_DEFAULTS,
} from './vendor/markpost-settings-contract.generated.js';

// Locks the CLI's settings contract to the vendored copy of markpost's real
// CONFLICT_STRATEGIES enum (server/utils/response.ts) and `user_settings`
// column defaults (server/db/schema.ts), refreshed by hand via
// `npm run sync:settings-contract`
// (README.md#source-and-settings-contract-sync). Before this test, both were
// hand-mirrored with no automated guard — the same silent-drift gap that let
// sources.types.ts drift in markpost-cli#78.
describe('markpost settings contract drift', () => {
  it('accepts exactly the conflict strategies markpost does, and no others', () => {
    expect([...CONFLICT_STRATEGIES].sort()).toEqual(
      [...MARKPOST_CONFLICT_STRATEGIES].sort(),
    );
  });

  it('falls back to the same defaults as markpost user_settings columns', () => {
    expect(DEFAULT_CONFLICT_STRATEGY).toBe(
      MARKPOST_USER_SETTINGS_DEFAULTS.conflictStrategy,
    );
    expect(DEFAULT_AUTO_DELETE).toBe(
      MARKPOST_USER_SETTINGS_DEFAULTS.autoDelete,
    );
    expect(DEFAULT_AUTO_SYNC).toBe(MARKPOST_USER_SETTINGS_DEFAULTS.autoSync);
    expect(DEFAULT_FRONTMATTER_ENABLED).toBe(
      MARKPOST_USER_SETTINGS_DEFAULTS.frontmatter,
    );
  });
});

describe('isConflictStrategy', () => {
  it.each(CONFLICT_STRATEGIES)(
    'accepts the known strategy "%s"',
    (strategy) => {
      expect(isConflictStrategy(strategy)).toBe(true);
    },
  );

  it('rejects an unknown value', () => {
    expect(isConflictStrategy('bogus')).toBe(false);
  });
});

describe('normalizeConflictStrategy', () => {
  it.each(CONFLICT_STRATEGIES)(
    'passes through the known strategy "%s"',
    (strategy) => {
      expect(normalizeConflictStrategy(strategy)).toBe(strategy);
    },
  );

  it('falls back to the default for an unknown value', () => {
    expect(normalizeConflictStrategy('bogus')).toBe(DEFAULT_CONFLICT_STRATEGY);
  });

  it('falls back to the default for null', () => {
    expect(normalizeConflictStrategy(null)).toBe(DEFAULT_CONFLICT_STRATEGY);
  });

  it('falls back to the default for undefined', () => {
    expect(normalizeConflictStrategy(undefined)).toBe(
      DEFAULT_CONFLICT_STRATEGY,
    );
  });
});

describe('normalizeAutoDelete', () => {
  it('passes through a real boolean', () => {
    expect(normalizeAutoDelete(true)).toBe(true);
    expect(normalizeAutoDelete(false)).toBe(false);
  });

  it.each([
    ['the string "false"', 'false'],
    ['the number 0', 0],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('falls back to the default for %s', (_label, value) => {
    expect(normalizeAutoDelete(value)).toBe(DEFAULT_AUTO_DELETE);
  });
});

describe('normalizeAutoSync', () => {
  it('passes through a real boolean', () => {
    expect(normalizeAutoSync(true)).toBe(true);
    expect(normalizeAutoSync(false)).toBe(false);
  });

  it.each([
    ['the string "false"', 'false'],
    ['the number 0', 0],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('falls back to the default for %s', (_label, value) => {
    expect(normalizeAutoSync(value)).toBe(DEFAULT_AUTO_SYNC);
  });
});

describe('normalizeFrontmatterEnabled', () => {
  it('passes through a real boolean', () => {
    expect(normalizeFrontmatterEnabled(true)).toBe(true);
    expect(normalizeFrontmatterEnabled(false)).toBe(false);
  });

  it.each([
    ['the string "false"', 'false'],
    ['the number 0', 0],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('falls back to the default for %s', (_label, value) => {
    expect(normalizeFrontmatterEnabled(value)).toBe(
      DEFAULT_FRONTMATTER_ENABLED,
    );
  });
});
