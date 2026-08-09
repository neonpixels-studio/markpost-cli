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

describe('isConflictStrategy', () => {
  it.each(CONFLICT_STRATEGIES)('accepts the known strategy "%s"', (strategy) => {
    expect(isConflictStrategy(strategy)).toBe(true);
  });

  it('rejects an unknown value', () => {
    expect(isConflictStrategy('bogus')).toBe(false);
  });
});

describe('normalizeConflictStrategy', () => {
  it.each(CONFLICT_STRATEGIES)('passes through the known strategy "%s"', (strategy) => {
    expect(normalizeConflictStrategy(strategy)).toBe(strategy);
  });

  it('falls back to the default for an unknown value', () => {
    expect(normalizeConflictStrategy('bogus')).toBe(DEFAULT_CONFLICT_STRATEGY);
  });

  it('falls back to the default for null', () => {
    expect(normalizeConflictStrategy(null)).toBe(DEFAULT_CONFLICT_STRATEGY);
  });

  it('falls back to the default for undefined', () => {
    expect(normalizeConflictStrategy(undefined)).toBe(DEFAULT_CONFLICT_STRATEGY);
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
    expect(normalizeFrontmatterEnabled(value)).toBe(DEFAULT_FRONTMATTER_ENABLED);
  });
});
