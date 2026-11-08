import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertContractIsTypeOnly,
  parseFromPathArg,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-contract.mjs';

describe('parseFromPathArg', () => {
  it('returns undefined when no --from flag is present', () => {
    expect(parseFromPathArg([])).toBeUndefined();
  });

  it('accepts the space form: --from <path>', () => {
    const existingPath = mkdtempSync(join(tmpdir(), 'sync-contract-test-'));

    try {
      expect(parseFromPathArg(['--from', existingPath])).toBe(existingPath);
    } finally {
      rmSync(existingPath, { recursive: true, force: true });
    }
  });

  it('accepts the equals form: --from=<path>', () => {
    const existingPath = mkdtempSync(join(tmpdir(), 'sync-contract-test-'));

    try {
      expect(parseFromPathArg([`--from=${existingPath}`])).toBe(existingPath);
    } finally {
      rmSync(existingPath, { recursive: true, force: true });
    }
  });

  it('throws when --from= has an empty value', () => {
    expect(() => parseFromPathArg(['--from='])).toThrow(
      '--from requires a path to a local markpost checkout',
    );
  });

  it('throws when --from has no following value', () => {
    expect(() => parseFromPathArg(['--from'])).toThrow(
      '--from requires a path to a local markpost checkout',
    );
  });

  it('throws when --from is immediately followed by another flag', () => {
    expect(() => parseFromPathArg(['--from', '--other'])).toThrow();
  });

  it('throws when the --from path does not exist', () => {
    expect(() =>
      parseFromPathArg(['--from', '/no/such/path/on/this/machine']),
    ).toThrow('--from path does not exist');
  });

  it('throws on an unrecognized flag', () => {
    expect(() => parseFromPathArg(['--dry-run'])).toThrow(
      'Unrecognized argument(s): --dry-run',
    );
  });

  // Regression coverage: an unrecognized flag alongside a valid --from must
  // still fail loudly instead of being silently ignored.
  it('throws on an unrecognized flag even when --from is also present', () => {
    const existingPath = mkdtempSync(join(tmpdir(), 'sync-contract-test-'));

    try {
      expect(() =>
        parseFromPathArg(['--from', existingPath, '--dry-run']),
      ).toThrow('Unrecognized argument(s): --dry-run');
    } finally {
      rmSync(existingPath, { recursive: true, force: true });
    }
  });

  // Regression coverage: a near-miss on the flag name must not be treated
  // as `--from` just because it shares the prefix — a loose prefix check
  // would silently fall through to the network-clone path instead of
  // failing on the typo.
  it('throws on a near-miss flag name instead of silently ignoring it', () => {
    expect(() => parseFromPathArg(['--fromm', '/tmp'])).toThrow(
      'Unrecognized argument(s): --fromm, /tmp',
    );
  });

  // Regression coverage: a bare positional path (no `--from` flag at all)
  // must fail loudly rather than being silently ignored.
  it('throws on a bare positional argument', () => {
    expect(() => parseFromPathArg(['../markpost'])).toThrow(
      'Unrecognized argument(s): ../markpost',
    );
  });

  // Regression coverage: mixing both forms must not silently pick the
  // `--from=` value and drop the space-form value (or vice versa) — that's
  // exactly the "wrong checkout gets vendored" risk this parser guards
  // against everywhere else.
  it('throws when --from is given twice, even across both forms', () => {
    expect(() =>
      parseFromPathArg(['--from=/a', '--from', '/b']),
    ).toThrow('--from may only be given once');
  });
});

describe('assertContractIsTypeOnly', () => {
  it('accepts type aliases, interfaces, and type-only imports', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        import type { Foo } from './foo';
        export type ApiError = { status: string };
        export interface ApiResourceObject { type: string; }
      `),
    ).not.toThrow();
  });

  it('accepts an inline type-only import specifier', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        import { type Foo } from './foo';
        export type ApiError = { status: string; foo: Foo };
      `),
    ).not.toThrow();
  });

  it('accepts a type-only re-export', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        export type { Foo } from './foo';
      `),
    ).not.toThrow();
  });

  it('rejects a named import with a mix of type-only and value specifiers', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        import { type Foo, readFileSync } from './foo';
        export type ApiError = { status: string; foo: Foo };
      `),
    ).toThrow(/non-type declaration/);
  });

  it('rejects a non-type-only re-export', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        export { helper } from './foo';
      `),
    ).toThrow(/non-type declaration/);
  });

  // Regression coverage: a default binding is always a runtime value, even
  // when every named specifier alongside it is individually type-only.
  it('rejects a default import mixed with type-only named specifiers', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        import Foo, { type Bar } from './foo';
        export type ApiError = { status: string; bar: Bar };
      `),
    ).toThrow(/non-type declaration/);
  });

  it('rejects a runtime statement, e.g. a value export', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        export const ApiError = { status: 'x' };
      `),
    ).toThrow(/non-type declaration/);
  });

  it('rejects a runtime (non type-only) import', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        import { readFileSync } from 'node:fs';
        export type ApiError = { status: string };
      `),
    ).toThrow(/non-type declaration/);
  });

  it('rejects a side-effecting function declaration', () => {
    expect(() =>
      assertContractIsTypeOnly(`
        console.log('side effect');
      `),
    ).toThrow(/non-type declaration/);
  });
});
