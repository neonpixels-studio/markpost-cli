import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSafeServerFilePath,
  FilePathViolationError,
  filePathViolation,
  resolveWithinVault,
} from '#src/libs/filePathSafety.js';

describe('filePathViolation', () => {
  it.each([
    'note.md',
    '99-incoming/2026-01-01-hello.md',
    'a/b/c/deep note.MD',
    'a/..b/ok.md',
    'v1.2/notes.md',
  ])('accepts the valid relative path %s', (value) => {
    expect(filePathViolation(value)).toBeNull();
  });

  it.each([
    ['../x.md', 'traversal'],
    ['a/../../x.md', 'traversal'],
    ['a/../x.md', 'traversal'],
    ['a/.. /x.md', 'traversal'],
    ['.../x.md', 'traversal'],
    ['/etc/passwd.md', 'absolute'],
    ['\\\\server\\share\\x.md', 'absolute'],
    ['C:\\x.md', 'invalid-characters'],
    ['C:/x.md', 'invalid-characters'],
    ['a\\b.md', 'invalid-characters'],
    ['a/b?.md', 'invalid-characters'],
    ['a\0b.md', 'invalid-characters'],
    ['a/\nb.md', 'invalid-characters'],
    ['notes/CON/x.md', 'unsafe-segment'],
    ['nul.md', 'unsafe-segment'],
    ['notes/com1.md', 'unsafe-segment'],
    ['notes/LPT9.txt.md', 'unsafe-segment'],
    ['a//b.md', 'unsafe-segment'],
    ['a/b.md/', 'unsafe-segment'],
    ['a/trailing./b.md', 'unsafe-segment'],
    ['a/ padded/b.md', 'unsafe-segment'],
    ['notes/x.txt', 'missing-extension'],
    ['notes/.md', 'missing-extension'],
    ['', 'empty'],
    ['   ', 'empty'],
    [`${'a/'.repeat(300)}x.md`, 'too-long'],
    [`${'é'.repeat(130)}.md`, 'segment-too-long'],
  ])('rejects %j as %s', (value, violation) => {
    expect(filePathViolation(value)).toBe(violation);
  });
});

describe('assertSafeServerFilePath', () => {
  it('does not throw for a safe path', () => {
    expect(() => assertSafeServerFilePath('a/b.md')).not.toThrow();
  });

  it('throws a FilePathViolationError naming the path and reason', () => {
    expect(() => assertSafeServerFilePath('../x.md')).toThrow(
      FilePathViolationError,
    );
    expect(() => assertSafeServerFilePath('../x.md')).toThrow(
      /"\.\.\/x\.md".*traversal/,
    );
  });
});

describe('resolveWithinVault', () => {
  let workspace: string;
  let vault: string;
  let outside: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'markpost-vault-')));
    vault = join(workspace, 'vault');
    outside = join(workspace, 'outside');
    mkdirSync(vault);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('resolves a nested path inside the vault, even if its folders do not exist yet', () => {
    expect(resolveWithinVault(vault, 'a/b/c.md')).toBe(
      resolve(vault, 'a/b/c.md'),
    );
  });

  it.each(['../x.md', 'a/../../x.md', '/etc/x.md', '..', '.'])(
    'throws for the escaping path %s',
    (relativePath) => {
      expect(() => resolveWithinVault(vault, relativePath)).toThrow(
        FilePathViolationError,
      );
    },
  );

  it('throws when a subfolder is a symlink pointing outside the vault', () => {
    symlinkSync(outside, join(vault, 'link'));

    expect(() => resolveWithinVault(vault, 'link/x.md')).toThrow(
      FilePathViolationError,
    );
    expect(() => resolveWithinVault(vault, 'link/new/x.md')).toThrow(
      FilePathViolationError,
    );
  });

  it('fails closed on a dangling subfolder symlink', () => {
    symlinkSync(join(outside, 'missing'), join(vault, 'dangling'));

    expect(() => resolveWithinVault(vault, 'dangling/x.md')).toThrow(
      FilePathViolationError,
    );
  });

  it('fails closed on a looping subfolder symlink', () => {
    symlinkSync(join(vault, 'loop'), join(vault, 'loop'));

    expect(() => resolveWithinVault(vault, 'loop/x.md')).toThrow(
      FilePathViolationError,
    );
    expect(() => resolveWithinVault(vault, 'loop/sub/x.md')).toThrow(
      FilePathViolationError,
    );
  });

  it('allows a subfolder symlink that stays inside the vault', () => {
    mkdirSync(join(vault, 'real'));
    symlinkSync(join(vault, 'real'), join(vault, 'alias'));

    expect(resolveWithinVault(vault, 'alias/x.md')).toBe(
      resolve(vault, 'alias/x.md'),
    );
  });

  it('accepts a vault root that is itself a symlink', () => {
    const linkedVault = join(workspace, 'vault-link');
    symlinkSync(vault, linkedVault);

    expect(resolveWithinVault(linkedVault, 'a/x.md')).toBe(
      resolve(linkedVault, 'a/x.md'),
    );
  });

  it('does not follow a symlink at the leaf (writers unlink it instead)', () => {
    symlinkSync(join(outside, 'target.md'), join(vault, 'leaf.md'));

    expect(resolveWithinVault(vault, 'leaf.md')).toBe(
      resolve(vault, 'leaf.md'),
    );
  });
});
