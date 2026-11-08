import type { ScopeName } from '#src/types/vendor/markpost-scopes.generated.js';

// Scopes each CLI command needs from the token it authenticates with, taken
// from the requireScope() gate on the markpost endpoints the command calls
// (server/api/**). Commands with several subcommands list the union across
// all of them. Keep in step with markpost when a command starts calling a
// new endpoint.
export const COMMAND_REQUIRED_SCOPES: Readonly<
  Record<string, readonly ScopeName[]>
> = {
  sync: ['records:read', 'records:write', 'settings:read'],
  push: ['records:write'],
  get: ['records:read'],
  records: ['records:read', 'records:write'],
  export: ['records:read'],
  events: ['events:read'],
  sources: ['sources:read', 'sources:write'],
  tokens: ['tokens:read', 'tokens:write'],
  settings: ['settings:read', 'settings:write'],
};

export type LostCommandScopes = {
  command: string;
  scopes: ScopeName[];
};

// A null scopes list is markpost's full-access value: every scope is held.
const holdsScope = (scopes: readonly string[] | null, scope: string): boolean =>
  scopes === null || scopes.includes(scope);

// Per command, the required scopes the token holds today but would lose with
// the new list. Scopes it never held are not reported: the update did not
// take them away. Full access (null) after the update never loses anything.
export const findLostCommandScopes = (
  currentScopes: readonly string[] | null,
  newScopes: readonly string[] | null,
): LostCommandScopes[] =>
  Object.entries(COMMAND_REQUIRED_SCOPES)
    .map(([command, required]) => ({
      command,
      scopes: required.filter(
        (scope) =>
          holdsScope(currentScopes, scope) && !holdsScope(newScopes, scope),
      ),
    }))
    .filter((lost) => lost.scopes.length > 0);

export const formatLostScopesWarning = (lost: LostCommandScopes[]): string => {
  const details = lost
    .map(({ command, scopes }) => `${command} (${scopes.join(', ')})`)
    .join('; ');

  return `WARNING: this is the token this CLI is currently configured with, and the new scopes drop scopes its commands need, so they will fail with 403 errors: ${details}. Restore access with \`markpost tokens update <id> --scopes <a,b>\` from another token, or set a new token with \`markpost config set apiToken <token>\`.`;
};
