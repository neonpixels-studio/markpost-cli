import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiRequestError,
  assertApiSuccess,
  authedRequest,
  describeSystemicFailure,
  formatErrorMessages,
  getApiToken,
  getBaseUrl,
  isSystemicApiFailure,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import { ApiError, ApiResourceObject, ApiResponse } from '@/types/api.types.js';

vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

vi.mock('@/libs/errors.js', () => ({
  logErrorMessage: vi.fn(),
}));

describe('getBaseUrl', () => {
  const original = process.env.BASE_URL;

  afterEach(() => {
    process.env.BASE_URL = original;
  });

  it('returns BASE_URL env var when set', () => {
    process.env.BASE_URL = 'https://example.com';
    expect(getBaseUrl()).toBe('https://example.com');
  });

  it('returns default URL when BASE_URL is not set', () => {
    delete process.env.BASE_URL;
    expect(getBaseUrl()).toBe('https://sync.danholloran.me');
  });
});

describe('getApiToken', () => {
  const original = process.env.API_TOKEN;

  afterEach(() => {
    process.env.API_TOKEN = original;
  });

  it('returns API_TOKEN env var when set', () => {
    process.env.API_TOKEN = 'test-token';
    expect(getApiToken()).toBe('test-token');
  });

  it('returns undefined when API_TOKEN is not set', () => {
    delete process.env.API_TOKEN;
    expect(getApiToken()).toBeUndefined();
  });
});

describe('formatErrorMessages', () => {
  const error = (title: string, detail: string): ApiError => ({
    status: '400',
    title,
    detail,
    source: {},
  });

  it('returns "Unknown error occurred" for empty array', () => {
    expect(formatErrorMessages([])).toBe('Unknown error occurred');
  });

  it('returns "Title: Detail" for a single error', () => {
    expect(formatErrorMessages([error('Bad Request', 'Invalid input')])).toBe(
      'Bad Request: Invalid input',
    );
  });

  it('returns a bulleted list for multiple errors', () => {
    const errors = [
      error('Bad Request', 'Invalid input'),
      error('Unprocessable', 'Missing field'),
    ];
    expect(formatErrorMessages(errors)).toBe(
      '- Bad Request: Invalid input\n- Unprocessable: Missing field',
    );
  });
});

describe('assertApiSuccess', () => {
  const error = (title: string, detail: string): ApiError => ({
    status: '400',
    title,
    detail,
    source: {},
  });

  it('does not throw when the response is ok and carries no errors', () => {
    expect(() =>
      assertApiSuccess({ ok: true } as Response, { data: {} }),
    ).not.toThrow();
  });

  it('does not throw when the response is ok and errors is a present but empty array', () => {
    expect(() =>
      assertApiSuccess({ ok: true } as Response, { data: { errors: [] } }),
    ).not.toThrow();
  });

  it('throws with the real error detail when the body carries errors', () => {
    const body = {
      data: { errors: [error('Unauthorized', 'Invalid or missing token')] },
    };

    expect(() => assertApiSuccess({ ok: false } as Response, body)).toThrow(
      'Unauthorized: Invalid or missing token',
    );
  });

  it('throws "Unknown error occurred" when the response fails with no error body', () => {
    expect(() =>
      assertApiSuccess({ ok: false } as Response, undefined),
    ).toThrow('Unknown error occurred');
  });

  it('throws when the response is ok but the body still carries errors', () => {
    const body = { data: { errors: [error('Conflict', 'Duplicate record')] } };

    expect(() => assertApiSuccess({ ok: true } as Response, body)).toThrow(
      'Conflict: Duplicate record',
    );
  });

  // markpost's declared `ApiResponse<T>` contract models a top-level
  // `errors` field (`{ errors: ApiError[], data?: never }`) as an
  // alternative to today's actual `data.errors` shape. Nothing currently
  // sends this shape, but the CLI must not silently accept it as success
  // just because it doesn't match the shape every handler happens to use
  // today.
  it('throws when the body carries top-level errors instead of nested data.errors', () => {
    const body = { errors: [error('Unauthorized', 'Invalid or missing token')] };

    expect(() => assertApiSuccess({ ok: false } as Response, body)).toThrow(
      'Unauthorized: Invalid or missing token',
    );
  });

  it('throws when the response is ok but carries top-level errors', () => {
    const body = { errors: [error('Conflict', 'Duplicate record')] };

    expect(() => assertApiSuccess({ ok: true } as Response, body)).toThrow(
      'Conflict: Duplicate record',
    );
  });

  it('does not let an empty data.errors mask a populated top-level errors', () => {
    const body = {
      data: { errors: [] },
      errors: [error('Conflict', 'Duplicate record')],
    };

    expect(() => assertApiSuccess({ ok: true } as Response, body)).toThrow(
      'Conflict: Duplicate record',
    );
  });

  // Regression coverage: an off-contract, non-array `errors` field (an
  // object here, but a string has the same problem) must not throw a raw
  // `TypeError` out of the spread — it degrades to "no errors present"
  // instead, and `!response.ok` still surfaces "Unknown error occurred".
  it('does not throw a TypeError when data.errors is not an array', () => {
    const body = { data: { errors: { detail: 'not an array' } } };

    expect(() => assertApiSuccess({ ok: false } as Response, body)).toThrow(
      'Unknown error occurred',
    );
  });
});

// The single seam both records.ts and sources.ts route through: it must
// attach the bearer auth header, merge caller-supplied headers on top without
// dropping auth, return the parsed body on success, and delegate error
// detection to `assertApiSuccess` (so a 2xx body carrying `errors` still
// throws, not just a non-2xx status).
describe('authedRequest', () => {
  const mockFetch = (responseBody: unknown, ok = true, status = 200) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(responseBody),
      }),
    );
  };

  beforeEach(() => {
    vi.stubEnv('BASE_URL', 'https://example.com');
    vi.stubEnv('API_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('prefixes the base URL and attaches the bearer auth header', async () => {
    mockFetch({ data: {} });
    await authedRequest('/api/records');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('merges caller-provided headers without dropping the auth header', async () => {
    mockFetch({ data: {} });
    await authedRequest('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json' },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/vnd.api+json',
        },
      }),
    );
  });

  it('returns the parsed body on success', async () => {
    mockFetch({ data: { attributes: { uuid: 'abc-123' } } });
    await expect(authedRequest('/api/records')).resolves.toEqual({
      data: { attributes: { uuid: 'abc-123' } },
    });
  });

  it('throws with the real error detail when a 2xx body still carries errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Conflict', detail: 'Duplicate record' }] } },
      true,
    );
    await expect(authedRequest('/api/records')).rejects.toThrow(
      'Conflict: Duplicate record',
    );
  });

  it('throws with the real error detail when the response is not ok', async () => {
    mockFetch(
      {
        data: {
          errors: [{ title: 'Unauthorized', detail: 'Invalid or missing token' }],
        },
      },
      false,
    );
    await expect(authedRequest('/api/records')).rejects.toThrow(
      'Unauthorized: Invalid or missing token',
    );
  });

  // The seam must propagate the HTTP status onto the thrown error, since
  // `createRecord` only re-throws (fail-fast) when `isSystemicApiFailure`
  // sees a systemic status. A seam that dropped the status would still pass
  // the message-only assertions above, so classification is asserted here.
  it('propagates the HTTP status so systemic failures stay classifiable', async () => {
    mockFetch(
      {
        data: {
          errors: [
            { title: 'Unauthorized', detail: 'Invalid or missing token' },
          ],
        },
      },
      false,
      401,
    );
    await expect(authedRequest('/api/records')).rejects.toMatchObject({
      statusCode: 401,
      isSystemic: true,
    });
  });
});

describe('assertApiSuccess (systemic classification)', () => {
  const authError: ApiError = {
    status: '401',
    title: 'Unauthorized',
    detail: 'Invalid or missing token',
    source: {},
  };

  it('throws an ApiRequestError carrying the response status', () => {
    const body = { data: { errors: [authError] } };

    expect(() =>
      assertApiSuccess({ ok: false, status: 401 } as Response, body),
    ).toThrow(ApiRequestError);

    try {
      assertApiSuccess({ ok: false, status: 401 } as Response, body);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).statusCode).toBe(401);
      expect((error as ApiRequestError).isSystemic).toBe(true);
    }
  });

  // markpost's `requireUser` throws a bare 401 with no `data.errors` body, so
  // without a status fallback the user would see the useless "Unknown error
  // occurred". The message must instead tell them the token is the problem.
  it('gives an actionable message for an errorless 401 response', () => {
    try {
      assertApiSuccess({ ok: false, status: 401 } as Response, {});
      throw new Error('expected assertApiSuccess to throw');
    } catch (error) {
      expect((error as ApiRequestError).message).toBe(
        'Invalid or missing API token — run `markpost config` to set a valid one',
      );
      expect((error as ApiRequestError).isSystemic).toBe(true);
    }
  });

  it('prefers a populated data.errors detail over the status fallback', () => {
    const body = {
      data: { errors: [authError] },
    };

    try {
      assertApiSuccess({ ok: false, status: 401 } as Response, body);
      throw new Error('expected assertApiSuccess to throw');
    } catch (error) {
      expect((error as ApiRequestError).message).toBe(
        'Unauthorized: Invalid or missing token',
      );
    }
  });

  it('throws a non-systemic ApiRequestError for a 4xx the payload caused', () => {
    const body = {
      data: {
        errors: [{ status: '422', title: 'Unprocessable', detail: 'Bad' }],
      },
    };

    try {
      assertApiSuccess({ ok: false, status: 422 } as Response, body);
      throw new Error('expected assertApiSuccess to throw');
    } catch (error) {
      expect((error as ApiRequestError).statusCode).toBe(422);
      expect((error as ApiRequestError).isSystemic).toBe(false);
    }
  });

  // Classification keys off the HTTP status, not the body. markpost never sends
  // a 2xx carrying errors (its handlers always throw non-2xx), but the CLI
  // still rejects that off-contract shape — and must treat it as non-systemic
  // (status 200), so an odd 200-with-errors body can't masquerade as an auth
  // failure just because an inner error object claims `status: '401'`.
  it('throws a non-systemic error for an ok response that still carries errors', () => {
    const body = {
      data: { errors: [{ status: '401', title: 'Odd', detail: 'off-contract' }] },
    };

    try {
      assertApiSuccess({ ok: true, status: 200 } as Response, body);
      throw new Error('expected assertApiSuccess to throw');
    } catch (error) {
      expect((error as ApiRequestError).statusCode).toBe(200);
      expect((error as ApiRequestError).isSystemic).toBe(false);
    }
  });
});

describe('ApiRequestError', () => {
  it('classifies 401 and 403 as auth failures (and systemic)', () => {
    for (const statusCode of [401, 403]) {
      const error = new ApiRequestError('nope', statusCode);
      expect(error.isAuthFailure).toBe(true);
      expect(error.isServerError).toBe(false);
      expect(error.isSystemic).toBe(true);
    }
  });

  it('classifies 429 as a rate limit (and systemic)', () => {
    const error = new ApiRequestError('nope', 429);
    expect(error.isRateLimited).toBe(true);
    expect(error.isAuthFailure).toBe(false);
    expect(error.isServerError).toBe(false);
    expect(error.isSystemic).toBe(true);
  });

  it('classifies any 5xx as a server error (and systemic)', () => {
    for (const statusCode of [500, 502, 503]) {
      const error = new ApiRequestError('nope', statusCode);
      expect(error.isServerError).toBe(true);
      expect(error.isAuthFailure).toBe(false);
      expect(error.isSystemic).toBe(true);
    }
  });

  it('treats a 4xx that is not auth or rate limit as non-systemic', () => {
    for (const statusCode of [400, 404, 409, 422]) {
      expect(new ApiRequestError('nope', statusCode).isSystemic).toBe(false);
    }
  });
});

describe('isSystemicApiFailure', () => {
  it('is true only for a systemic ApiRequestError', () => {
    expect(isSystemicApiFailure(new ApiRequestError('nope', 401))).toBe(true);
    expect(isSystemicApiFailure(new ApiRequestError('nope', 503))).toBe(true);
  });

  it('is false for a non-systemic ApiRequestError', () => {
    expect(isSystemicApiFailure(new ApiRequestError('nope', 422))).toBe(false);
  });

  it('is false for a plain Error or non-error value', () => {
    expect(isSystemicApiFailure(new Error('network down'))).toBe(false);
    expect(isSystemicApiFailure('boom')).toBe(false);
    expect(isSystemicApiFailure(undefined)).toBe(false);
  });
});

describe('describeSystemicFailure', () => {
  it('labels an auth failure with its status and message', () => {
    const error = new ApiRequestError('Invalid or missing token', 401);
    expect(describeSystemicFailure(error)).toBe(
      'Authentication failed (HTTP 401): Invalid or missing token',
    );
  });

  it('labels a rate limit with its status and message', () => {
    const error = new ApiRequestError('Too many requests', 429);
    expect(describeSystemicFailure(error)).toBe(
      'Rate limited (HTTP 429): Too many requests',
    );
  });

  it('labels a server error with its status and message', () => {
    const error = new ApiRequestError('Unknown error occurred', 503);
    expect(describeSystemicFailure(error)).toBe(
      'Server error (HTTP 503): Unknown error occurred',
    );
  });

  // Guards the label so a non-systemic error handed in by mistake can't be
  // mislabeled as a server error.
  it('falls back to a generic label for a non-systemic error', () => {
    const error = new ApiRequestError('Duplicate record', 409);
    expect(describeSystemicFailure(error)).toBe(
      'Request failed (HTTP 409): Duplicate record',
    );
  });
});

describe('unwrapResourceAttributes', () => {
  type FixtureAttributes = { uuid: string; title: string };
  type FixtureResource = ApiResourceObject & {
    type: 'fixtures';
    attributes: FixtureAttributes;
  };

  it('returns the attributes off a resource object', () => {
    const body: ApiResponse<FixtureResource | null> = {
      data: {
        type: 'fixtures',
        id: 'abc-123',
        attributes: { uuid: 'abc-123', title: 'Hello' },
      },
    };

    expect(unwrapResourceAttributes(body)).toEqual({
      uuid: 'abc-123',
      title: 'Hello',
    });
  });

  it('returns null when data is null', () => {
    const body: ApiResponse<FixtureResource | null> = { data: null };

    expect(unwrapResourceAttributes(body)).toBeNull();
  });

  it('returns null (not undefined) when the resource has no attributes', () => {
    const body = {
      data: { type: 'fixtures', id: 'abc-123' },
    } as ApiResponse<FixtureResource | null>;

    expect(unwrapResourceAttributes(body)).toBeNull();
  });
});

describe('unwrapResourceCollection', () => {
  type FixtureAttributes = { uuid: string; title: string };
  type FixtureResource = ApiResourceObject & {
    type: 'fixtures';
    attributes: FixtureAttributes;
  };

  const fixture: FixtureAttributes = { uuid: 'abc-123', title: 'Hello' };

  beforeEach(() => {
    vi.mocked(logErrorMessage).mockClear();
  });

  it('returns [] and does not log when data is missing entirely', () => {
    const body = {} as ApiResponse<FixtureResource[]>;

    expect(unwrapResourceCollection('context', body, 'fixture')).toEqual([]);
    expect(logErrorMessage).not.toHaveBeenCalled();
  });

  it('returns the attributes of every usable resource', () => {
    const body: ApiResponse<FixtureResource[]> = {
      data: [
        { type: 'fixtures', id: 'abc-123', attributes: fixture },
        { type: 'fixtures', id: 'def-456', attributes: { ...fixture, uuid: 'def-456' } },
      ],
    };

    expect(unwrapResourceCollection('context', body, 'fixture')).toEqual([
      fixture,
      { ...fixture, uuid: 'def-456' },
    ]);
    expect(logErrorMessage).not.toHaveBeenCalled();
  });

  it('drops a resource with attributes explicitly null and logs the skip', () => {
    const body = {
      data: [
        { type: 'fixtures', id: 'abc-123', attributes: fixture },
        { type: 'fixtures', id: 'def-456', attributes: null },
      ],
    } as unknown as ApiResponse<FixtureResource[]>;

    expect(unwrapResourceCollection('myContext', body, 'fixture')).toEqual([
      fixture,
    ]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'myContext',
      'Skipped 1 fixture(s) with no attributes',
    );
  });

  // The everything-dropped path matters most: it still returns successfully
  // (an empty array, not a thrown error), so the only signal something's
  // wrong is the logged skip count — this must not silently look identical
  // to "the server legitimately returned zero resources".
  it('drops every resource and logs the full count when none are usable', () => {
    const body = {
      data: [
        { type: 'fixtures', id: 'abc-123' },
        { type: 'fixtures', id: 'def-456', attributes: null },
      ],
    } as unknown as ApiResponse<FixtureResource[]>;

    expect(unwrapResourceCollection('myContext', body, 'fixture')).toEqual([]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'myContext',
      'Skipped 2 fixture(s) with no attributes',
    );
  });
});
