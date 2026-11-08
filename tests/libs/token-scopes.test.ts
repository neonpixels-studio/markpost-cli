import { describe, expect, it } from 'vitest';
import {
  COMMAND_REQUIRED_SCOPES,
  findLostCommandScopes,
  formatLostScopesWarning,
} from '#src/libs/token-scopes.js';
import { SCOPE_NAMES } from '#src/types/vendor/markpost-scopes.generated.js';

describe('COMMAND_REQUIRED_SCOPES', () => {
  it('only references scopes markpost knows about', () => {
    const known = new Set<string>(SCOPE_NAMES);
    const referenced = Object.values(COMMAND_REQUIRED_SCOPES).flat();

    expect(referenced.filter((scope) => !known.has(scope))).toEqual([]);
  });
});

describe('findLostCommandScopes', () => {
  it('reports every command that loses a scope when full access is narrowed', () => {
    const lost = findLostCommandScopes(null, ['records:read']);
    const commands = lost.map(({ command }) => command);

    expect(commands).toContain('sync');
    expect(commands).toContain('push');
    expect(commands).not.toContain('get');
  });

  it('lists only the scopes actually lost per command', () => {
    const lost = findLostCommandScopes(null, ['records:read']);

    expect(lost.find(({ command }) => command === 'sync')?.scopes).toEqual([
      'records:write',
      'settings:read',
    ]);
  });

  it('ignores scopes the token did not hold before', () => {
    expect(findLostCommandScopes(['records:read'], ['records:read'])).toEqual(
      [],
    );
    const lost = findLostCommandScopes(['records:read'], ['events:read']);

    expect(lost.map(({ command }) => command)).toEqual([
      'sync',
      'get',
      'records',
      'export',
    ]);
    lost.forEach(({ scopes }) => expect(scopes).toEqual(['records:read']));
  });

  it('never loses anything when the new scopes are full access', () => {
    expect(findLostCommandScopes(['records:read'], null)).toEqual([]);
  });
});

describe('formatLostScopesWarning', () => {
  it('names each command with its lost scopes', () => {
    const warning = formatLostScopesWarning('tok-1', [
      { command: 'push', scopes: ['records:write'] },
    ]);

    expect(warning).toContain('push (records:write)');
    expect(warning).toContain('markpost tokens update tok-1 --scopes');
  });
});
