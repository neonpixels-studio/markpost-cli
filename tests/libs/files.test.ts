import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// chmod-based permission tests are meaningless when the suite runs as root
// (root bypasses the mode bits), so they are skipped in that case.
const runningAsRoot = process.getuid?.() === 0;

import { resolveMarkdownInputs } from '@/libs/files.js';

let workspace: string;

const createFile = (relativePath: string): string => {
  const absolutePath = join(workspace, relativePath);
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, `# ${relativePath}`);
  return absolutePath;
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'markpost-files-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('resolveMarkdownInputs', () => {
  it('resolves multiple explicit files, preserving order', () => {
    const first = createFile('a.md');
    const second = createFile('b.md');

    const { files, missing } = resolveMarkdownInputs([first, second]);

    expect(files).toEqual([first, second]);
    expect(missing).toEqual([]);
  });

  it('takes an explicit file as-is even without a .md extension', () => {
    const note = createFile('notes.txt');

    const { files } = resolveMarkdownInputs([note]);

    expect(files).toEqual([note]);
  });

  it('recurses a directory, collecting only markdown files', () => {
    const top = createFile('vault/top.md');
    const nested = createFile('vault/nested/deep.md');
    createFile('vault/ignore.txt');

    const { files } = resolveMarkdownInputs([join(workspace, 'vault')]);

    expect(new Set(files)).toEqual(new Set([top, nested]));
    expect(files).toHaveLength(2);
  });

  it('expands a glob to its markdown matches', () => {
    const first = createFile('one.md');
    const second = createFile('two.md');
    createFile('skip.txt');

    const { files } = resolveMarkdownInputs([join(workspace, '*.md')]);

    expect(new Set(files)).toEqual(new Set([first, second]));
  });

  it('deduplicates files reached through overlapping inputs', () => {
    const file = createFile('dupe.md');

    const { files } = resolveMarkdownInputs([
      file,
      join(workspace, '*.md'),
      workspace,
    ]);

    expect(files).toEqual([file]);
  });

  it('recurses into a directory that a glob lands on', () => {
    const nested = createFile('vault/inner/note.md');

    const { files } = resolveMarkdownInputs([join(workspace, '*')]);

    expect(files).toContain(nested);
  });

  it('treats an existing directory with no markdown as an unmatched input', () => {
    mkdirSync(join(workspace, 'empty'), { recursive: true });

    const { files, missing } = resolveMarkdownInputs([join(workspace, 'empty')]);

    expect(files).toEqual([]);
    expect(missing).toEqual([join(workspace, 'empty')]);
  });

  it('records a broken symlink as skipped instead of aborting', () => {
    const real = createFile('real.md');
    const broken = join(workspace, 'dangling.md');
    symlinkSync(join(workspace, 'does-not-exist.md'), broken);

    const { files, skipped } = resolveMarkdownInputs([
      real,
      join(workspace, '*.md'),
    ]);

    expect(files).toContain(real);
    expect(skipped).toContain(broken);
  });

  it('skips hidden entries when recursing a directory', () => {
    const visible = createFile('vault/note.md');
    createFile('vault/.obsidian/config.md');

    const { files } = resolveMarkdownInputs([join(workspace, 'vault')]);

    expect(files).toEqual([visible]);
  });

  it('collects .markdown files when recursing a directory', () => {
    const md = createFile('vault/note.md');
    const markdown = createFile('vault/other.markdown');

    const { files } = resolveMarkdownInputs([join(workspace, 'vault')]);

    expect(new Set(files)).toEqual(new Set([md, markdown]));
  });

  it('collapses a symlink and its target to a single file', () => {
    const target = createFile('real.md');
    const link = join(workspace, 'link.md');
    symlinkSync(target, link);

    const { files } = resolveMarkdownInputs([target, link]);

    expect(files).toHaveLength(1);
  });

  it('terminates on a directory symlink cycle', () => {
    const note = createFile('vault/note.md');
    symlinkSync(join(workspace, 'vault'), join(workspace, 'vault/loop'));

    const { files } = resolveMarkdownInputs([join(workspace, 'vault')]);

    expect(files).toContain(note);
  });

  it('skips a non-regular file named explicitly', () => {
    const { files, skipped } = resolveMarkdownInputs(['/dev/null']);

    expect(files).toEqual([]);
    expect(skipped).toEqual(['/dev/null']);
  });

  it.skipIf(runningAsRoot)(
    'records an unreadable directory as skipped',
    () => {
      const locked = join(workspace, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);

      try {
        const { files, skipped } = resolveMarkdownInputs([locked]);

        expect(files).toEqual([]);
        expect(skipped).toEqual([locked]);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it.skipIf(runningAsRoot)(
    'deduplicates an unreadable directory reached through overlapping inputs',
    () => {
      const locked = join(workspace, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);

      try {
        const { skipped } = resolveMarkdownInputs([workspace, locked]);

        expect(skipped).toEqual([locked]);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it('reports inputs that match nothing without dropping the rest', () => {
    const real = createFile('real.md');

    const { files, missing } = resolveMarkdownInputs([
      real,
      join(workspace, 'does-not-exist.md'),
    ]);

    expect(files).toEqual([real]);
    expect(missing).toEqual([join(workspace, 'does-not-exist.md')]);
  });

  describe('home directory expansion', () => {
    let originalHome: string | undefined;

    beforeEach(() => {
      originalHome = process.env.HOME;
      process.env.HOME = workspace;
    });

    afterEach(() => {
      if (originalHome === undefined) {
        delete process.env.HOME;
        return;
      }

      process.env.HOME = originalHome;
    });

    it('expands a leading ~ so a quoted glob matches under home', () => {
      const note = createFile('vault/note.md');

      const { files, missing } = resolveMarkdownInputs(['~/vault/**']);

      expect(files).toEqual([note]);
      expect(missing).toEqual([]);
    });

    it('expands a leading $HOME so a quoted glob matches under home', () => {
      const note = createFile('vault/note.md');

      const { files, missing } = resolveMarkdownInputs(['$HOME/vault/**']);

      expect(files).toEqual([note]);
      expect(missing).toEqual([]);
    });

    it('expands a leading ${HOME} so a quoted glob matches under home', () => {
      const note = createFile('vault/note.md');

      const { files, missing } = resolveMarkdownInputs(['${HOME}/vault/**']);

      expect(files).toEqual([note]);
      expect(missing).toEqual([]);
    });

    it('expands a bare ~ to the home directory itself', () => {
      const note = createFile('note.md');

      const { files } = resolveMarkdownInputs(['~']);

      expect(files).toContain(note);
    });

    it('expands a bare $HOME to the home directory itself', () => {
      const note = createFile('note.md');

      const { files } = resolveMarkdownInputs(['$HOME']);

      expect(files).toContain(note);
    });

    it('leaves a path without a home reference untouched', () => {
      const note = createFile('vault/note.md');

      const { files } = resolveMarkdownInputs([join(workspace, 'vault')]);

      expect(files).toEqual([note]);
    });

    it('does not expand a ~ that is not a home reference', () => {
      const { files, missing } = resolveMarkdownInputs(['~backup/note.md']);

      expect(files).toEqual([]);
      expect(missing).toEqual(['~backup/note.md']);
    });

    it('does not expand a $HOME prefix that is not a home reference', () => {
      const { files, missing } = resolveMarkdownInputs(['$HOMEBREW/note.md']);

      expect(files).toEqual([]);
      expect(missing).toEqual(['$HOMEBREW/note.md']);
    });

    it('reports an unmatched home reference as the raw input, not expanded', () => {
      const { files, missing } = resolveMarkdownInputs(['~/nope.md']);

      expect(files).toEqual([]);
      expect(missing).toEqual(['~/nope.md']);
    });
  });

  it('returns no files when nothing resolves', () => {
    const { files, missing } = resolveMarkdownInputs([
      join(workspace, 'nope.md'),
      join(workspace, '*.md'),
    ]);

    expect(files).toEqual([]);
    expect(missing).toEqual([
      join(workspace, 'nope.md'),
      join(workspace, '*.md'),
    ]);
  });
});
