import type { ApiResourceObject, ApiResponse } from '#src/types/api.types.js';
import type { ScopeName } from '#src/types/vendor/markpost-scopes.generated.js';

// Mirrors markpost's API token contract by hand (markpost is the source of
// truth): the resource shape from `tokenSerializer`
// (server/api/tokens/index.get.ts) and the mint response from
// server/api/tokens/index.post.ts. Keep in lockstep — there is no
// dedicated api.types.ts export for tokens on the markpost side (the shapes
// live inline in the handler files), so this file is the CLI's one hand
// vendored copy of both.
//
// `scopes` on a read token stays a plain `string[] | null` rather than a
// strict `ScopeName` union: it is display-only there, and an older token may
// carry a scope this CLI build predates. Scopes the CLI *sends* (create and
// update) are validated against the allowlist vendored from markpost by
// `npm run sync:scopes-contract` (see libs/scopes.ts).
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
// (server/api/tokens/index.post.ts `MintTokenAttributes`). Omitting `scopes`
// mints a full-access token (the same default a Clerk-session mint gets).
export type CreateTokenInput = {
  name: string;
  expiresInDays?: number;
  scopes?: ScopeName[];
};

// Mirrors PATCH /api/tokens/{id} (server/api/tokens/[id].patch.ts). The
// handler requires `scopes` to be present: a list of scopes, or null for
// full access (`tokens update --full-access`).
export type UpdateTokenScopesInput = {
  scopes: ScopeName[] | null;
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
