import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { expandHomeDirectory } from '@/libs/paths.js';

const HOME = '/home/user';
const resolveHome = () => HOME;

describe('expandHomeDirectory', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHomeDirectory('~', resolveHome)).toBe(HOME);
  });

  it('expands ~/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('~/notes', resolveHome)).toBe(
      join(HOME, 'notes'),
    );
  });

  it('expands a nested ~/sub/dir path', () => {
    expect(expandHomeDirectory('~/notes/work', resolveHome)).toBe(
      join(HOME, 'notes', 'work'),
    );
  });

  it('expands a bare $HOME to the home directory', () => {
    expect(expandHomeDirectory('$HOME', resolveHome)).toBe(HOME);
  });

  it('expands $HOME/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('$HOME/notes', resolveHome)).toBe(
      join(HOME, 'notes'),
    );
  });

  it('expands a bare ${HOME} to the home directory', () => {
    expect(expandHomeDirectory('${HOME}', resolveHome)).toBe(HOME);
  });

  it('expands ${HOME}/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('${HOME}/notes', resolveHome)).toBe(
      join(HOME, 'notes'),
    );
  });

  it('leaves an already-absolute path unchanged', () => {
    expect(expandHomeDirectory('/var/notes', resolveHome)).toBe('/var/notes');
  });

  it('leaves a relative path with a literal tilde mid-string unchanged', () => {
    expect(expandHomeDirectory('notes/~drafts', resolveHome)).toBe(
      'notes/~drafts',
    );
  });

  it('leaves a plain relative path unchanged', () => {
    expect(expandHomeDirectory('notes', resolveHome)).toBe('notes');
  });

  it('does not expand ~user (another user’s home is not resolvable)', () => {
    expect(expandHomeDirectory('~other/notes', resolveHome)).toBe(
      '~other/notes',
    );
  });

  it('does not expand a $HOME prefix that is not a whole path token', () => {
    expect(expandHomeDirectory('$HOMEwork', resolveHome)).toBe('$HOMEwork');
  });

  it('does not resolve the home directory when no prefix matches', () => {
    const resolver = vi.fn(() => HOME);

    expandHomeDirectory('/var/notes', resolver);

    expect(resolver).not.toHaveBeenCalled();
  });

  it('throws instead of writing to the cwd when the home directory is empty', () => {
    expect(() => expandHomeDirectory('~/notes', () => '')).toThrow(
      'no home directory is available',
    );
  });
});
