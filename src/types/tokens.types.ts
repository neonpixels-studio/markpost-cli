import type { ApiResourceObject, ApiResponse } from '@/types/api.types.js';

// Mirrors markpost's API token contract by hand (markpost is the source of
// truth): the resource shape from `tokenSerializer`
// (server/api/tokens/index.get.ts) and the mint response from
// server/api/tokens/index.post.ts. Keep in lockstep — there is no
// dedicated api.types.ts export for tokens on the markpost side (the shapes
// live inline in the handler files), so this file is the CLI's one hand
// vendored copy of both.
//
// `scopes` is carried as a plain `string[] | null` rather than a strict
// `ScopeName` union: the CLI only ever displays scopes (list output) and
// mints full-access tokens (create never sends a `scopes` attribute), so it
// has no need to validate against markpost's allowlist — that enforcement
// stays server-side.
export type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  scopes: string[] | null;
};

// Only markpost's mint response (POST /api/tokens) reveals the one-time raw
// secret; it is never present on list. Modelling it on a create-only type
// (not the base `Token`) documents where the field appears, mirroring
// `CreatedSource` in sources.types.ts. The mint handler always sets `token`
// on success (server/api/tokens/index.post.ts), but it's typed as possibly
// absent so an off-contract response can't be silently trusted — see
// `createTokenCommand`'s explicit check.
export type CreatedToken = Token & {
  token?: string;
};

// Mirrors markpost's POST /api/tokens mint attributes
// (server/api/tokens/index.post.ts `MintTokenAttributes`). `scopes` is
// deliberately omitted: the CLI always mints a full-access token today (the
// same default a Clerk-session mint gets by omitting the attribute), and
// exposing a `--scopes` flag is out of scope for this contract to avoid
// re-deriving markpost's `ScopeName` allowlist by hand.
export type CreateTokenInput = {
  name: string;
  expiresInDays?: number;
};

// The JSON:API resource object markpost's `tokenSerializer` produces:
// `attributes` plus the `type`/`id`/`links` envelope fields.
export type TokenResource = ApiResourceObject & {
  type: 'api_tokens';
  attributes: Token;
};

// The mint response is the only place `attributes` carries the one-time
// `token` secret alongside the rest of the resource.
export type CreatedTokenResource = ApiResourceObject & {
  type: 'api_tokens';
  attributes: CreatedToken;
};

export type TokenListApiResponse = ApiResponse<TokenResource[]>;
