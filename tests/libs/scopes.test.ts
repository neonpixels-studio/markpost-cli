import { describe, expect, it } from 'vitest';

import { parseScopesFlag } from '#src/libs/scopes.js';
import { SCOPE_NAMES } from '#src/types/vendor/markpost-scopes.generated.js';

describe('parseScopesFlag', () => {
  it('accepts every scope in the vendored markpost allowlist', () => {
    expect(parseScopesFlag(SCOPE_NAMES.join(','))).toEqual({
      ok: true,
      scopes: [...SCOPE_NAMES],
    });
  });

  it('trims whitespace and collapses duplicates', () => {
    expect(parseScopesFlag(' records:read , records:read,tokens:read')).toEqual(
      { ok: true, scopes: ['records:read', 'tokens:read'] },
    );
  });

  it('rejects unknown scopes and lists the valid ones', () => {
    const result = parseScopesFlag('records:read,nope,also:bad');

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringContaining('Unknown scope(s): nope, also:bad'),
    });
    expect(result).toMatchObject({
      message: expect.stringContaining(SCOPE_NAMES.join(', ')),
    });
  });

  it('rejects an empty value', () => {
    expect(parseScopesFlag('').ok).toBe(false);
    expect(parseScopesFlag(' , ').ok).toBe(false);
  });
});
