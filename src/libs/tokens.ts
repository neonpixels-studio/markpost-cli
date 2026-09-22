import {
  authedRequest,
  logApiFailure,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { ApiResponse } from '@/types/api.types.js';
import {
  CreatedToken,
  CreatedTokenResource,
  CreateTokenInput,
  Token,
  TokenListApiResponse,
} from '@/types/tokens.types.js';

const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';
const TOKENS_PATH = '/api/tokens';

// Deliberately does not swallow a failed fetch into `[]`: a failure must not
// masquerade as "no tokens" the way `sources list` currently lets it — see
// the equivalent comment on `listRecords` in commands/records.ts, which this
// mirrors instead. The command layer's outer try/catch reports the thrown
// error via `failWithMessage`, honoring the documented `--json` failure
// contract (README "JSON failure contract").
export const fetchTokens = async (): Promise<Token[]> => {
  const body = (await authedRequest(TOKENS_PATH)) as TokenListApiResponse;

  return unwrapResourceCollection('fetchTokens', body, 'token');
};

// Mints a token via markpost's POST /api/tokens. The response reveals the raw
// secret exactly once (see `CreatedToken`), so unlike `fetchTokens` this
// returns the full resource attributes rather than the base `Token` shape.
export const createToken = async (
  input: CreateTokenInput,
): Promise<CreatedToken | null> => {
  try {
    const body = (await authedRequest(TOKENS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': JSON_API_CONTENT_TYPE,
      },
      body: JSON.stringify({
        data: {
          type: 'api_tokens',
          attributes: input,
        },
      }),
    })) as ApiResponse<CreatedTokenResource | null>;

    return unwrapResourceAttributes(body);
  } catch (error) {
    // The name is caller-supplied (and, on a round trip, could reflect
    // server-echoed content), so it's sanitized before landing in a log
    // label the same way every printed field is on the command layer.
    logApiFailure(`createToken["${sanitizeForTerminal(input.name)}"]`, error);

    return null;
  }
};

// Revokes a token via markpost's DELETE /api/tokens/{id}. Unlike
// `deleteSource`, the endpoint returns `{ data: null }` on success — no
// `meta.deleted` count to report (server/api/tokens/[id].delete.ts) — so
// success here is simply "the request didn't throw".
export const revokeToken = async (id: string): Promise<boolean> => {
  try {
    await authedRequest(`${TOKENS_PATH}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return true;
  } catch (error) {
    // Sanitized for the same reason as createToken's label above — `id` is
    // user-supplied input landing in a console.error call.
    logApiFailure(`revokeToken["${sanitizeForTerminal(id)}"]`, error);

    return false;
  }
};
