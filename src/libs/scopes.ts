import {
  SCOPE_NAMES,
  type ScopeName,
} from '#src/types/vendor/markpost-scopes.generated.js';

export type ScopesParseResult =
  { ok: true; scopes: ScopeName[] } | { ok: false; message: string };

const SCOPE_SEPARATOR = ',';
const VALID_SCOPES_LIST = SCOPE_NAMES.join(', ');

const isScopeName = (value: string): value is ScopeName =>
  (SCOPE_NAMES as readonly string[]).includes(value);

// Parses a `--scopes a,b` value against markpost's scope allowlist (vendored
// by `npm run sync:scopes-contract`). Validating here means a typo fails
// before any request is sent. Whitespace around entries is trimmed and
// duplicates collapse, matching what markpost persists.
export const parseScopesFlag = (raw: string): ScopesParseResult => {
  const requested = raw
    .split(SCOPE_SEPARATOR)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  if (requested.length === 0) {
    return {
      ok: false,
      message: `--scopes needs at least one scope. Valid scopes: ${VALID_SCOPES_LIST}.`,
    };
  }

  const unknownScopes = requested.filter((scope) => !isScopeName(scope));

  if (unknownScopes.length > 0) {
    return {
      ok: false,
      message: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid scopes: ${VALID_SCOPES_LIST}. If markpost added a scope recently, upgrade the CLI.`,
    };
  }

  return { ok: true, scopes: [...new Set(requested.filter(isScopeName))] };
};
