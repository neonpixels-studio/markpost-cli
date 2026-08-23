import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { expandHomeDirectory } from '@/libs/paths.js';

const HOME = '/home/user';

describe('expandHomeDirectory', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHomeDirectory('~', HOME)).toBe(HOME);
  });

  it('expands ~/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('~/notes', HOME)).toBe(join(HOME, 'notes'));
  });

  it('expands a nested ~/sub/dir path', () => {
    expect(expandHomeDirectory('~/notes/work', HOME)).toBe(
      join(HOME, 'notes', 'work'),
    );
  });

  it('expands a bare $HOME to the home directory', () => {
    expect(expandHomeDirectory('$HOME', HOME)).toBe(HOME);
  });

  it('expands $HOME/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('$HOME/notes', HOME)).toBe(join(HOME, 'notes'));
  });

  it('expands a bare ${HOME} to the home directory', () => {
    expect(expandHomeDirectory('${HOME}', HOME)).toBe(HOME);
  });

  it('expands ${HOME}/sub to a path under the home directory', () => {
    expect(expandHomeDirectory('${HOME}/notes', HOME)).toBe(join(HOME, 'notes'));
  });

  it('leaves an already-absolute path unchanged', () => {
    expect(expandHomeDirectory('/var/notes', HOME)).toBe('/var/notes');
  });

  it('leaves a relative path with a literal tilde mid-string unchanged', () => {
    expect(expandHomeDirectory('notes/~drafts', HOME)).toBe('notes/~drafts');
  });

  it('leaves a plain relative path unchanged', () => {
    expect(expandHomeDirectory('notes', HOME)).toBe('notes');
  });

  it('does not expand ~user (another user’s home is not resolvable)', () => {
    expect(expandHomeDirectory('~other/notes', HOME)).toBe('~other/notes');
  });

  it('does not expand a $HOME prefix that is not a whole path token', () => {
    expect(expandHomeDirectory('$HOMEwork', HOME)).toBe('$HOMEwork');
  });
});
