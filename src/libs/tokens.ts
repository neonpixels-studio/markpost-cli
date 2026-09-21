import {
  authedRequest,
  logApiFailure,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
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

export const fetchTokens = async (): Promise<Token[]> => {
  try {
    const body = (await authedRequest(TOKENS_PATH)) as TokenListApiResponse;

    return unwrapResourceCollection('fetchTokens', body, 'token');
  } catch (error) {
    logApiFailure('fetchTokens', error);

    return [];
  }
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
    logApiFailure(`createToken["${input.name}"]`, error);

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
    logApiFailure(`revokeToken["${id}"]`, error);

    return false;
  }
};
