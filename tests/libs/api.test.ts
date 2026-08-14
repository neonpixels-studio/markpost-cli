import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_REQUEST_TIMEOUT_MS,
  apiFetch,
  ApiRequestError,
  ApiTimeoutError,
  assertApiSuccess,
  authedRequest,
  describeApiError,
  describeSystemicFailure,
  formatErrorMessages,
  getApiToken,
  getBaseUrl,
  isSystemicApiFailure,
  logApiFailure,
  rethrowIfTimeout,
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

  // Permanence gates whether an autoSync daemon should shut down: auth failures
  // (401/403) won't clear on retry, but a rate-limit/5xx is transient.
  it('marks only auth failures (401/403) as permanent', () => {
    for (const statusCode of [401, 403]) {
      expect(new ApiRequestError('nope', statusCode).isPermanent).toBe(true);
    }
  });

  it('marks a rate limit and 5xx as NOT permanent (transient)', () => {
    for (const statusCode of [429, 500, 503]) {
      expect(new ApiRequestError('nope', statusCode).isPermanent).toBe(false);
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

describe('describeApiError', () => {
  // A systemic failure gets the classified, actionable description so a command
  // can surface *why* it failed (e.g. an expired token) rather than a bare message.
  it('classifies a systemic ApiRequestError with its status label', () => {
    const error = new ApiRequestError('Invalid or missing API token', 401);
    expect(describeApiError(error)).toBe(
      'Authentication failed (HTTP 401): Invalid or missing API token',
    );
  });

  // A non-systemic ApiRequestError (a per-request 4xx) falls back to its bare
  // message — no systemic classification prefix, since it isn't batch-wide.
  it('returns the bare message for a non-systemic ApiRequestError', () => {
    const error = new ApiRequestError('Record not found', 404);
    expect(describeApiError(error)).toBe('Record not found');
  });

  it('returns the message of a plain Error', () => {
    expect(describeApiError(new Error('Network error'))).toBe('Network error');
  });

  // A thrown non-Error value (a bare string) still yields a printable message
  // rather than "[object Object]" or a crash.
  it('stringifies a thrown non-Error value', () => {
    expect(describeApiError('boom')).toBe('boom');
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

describe('apiFetch', () => {
  const originalFetch = global.fetch;

  const okResponse = (body: unknown = {}) =>
    ({ ok: true, json: () => Promise.resolve(body) }) as unknown as Response;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the response and parsed body on success', async () => {
    const parsed = { data: { attributes: { uuid: 'abc-123' } } };
    global.fetch = vi.fn().mockResolvedValue(okResponse(parsed));

    const result = await apiFetch('https://example.com/api/records');

    expect(result.response.ok).toBe(true);
    expect(result.body).toEqual(parsed);
  });

  // Pins the timeout to the named constant: a mutation to `AbortSignal
  // .timeout(1)` or to a controller that never fires (both of which would
  // silently defeat the timeout) makes this assertion fail.
  it('arms the request with an AbortSignal for the configured timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;

    await apiFetch('https://example.com/api/records', { method: 'GET' });

    expect(timeoutSpy).toHaveBeenCalledWith(API_REQUEST_TIMEOUT_MS);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('GET');
  });

  // A stalled connection is aborted by `AbortSignal.timeout`, which `fetch`
  // rejects with a `TimeoutError` DOMException — the exact shape reproduced
  // here. It must surface as a distinct `ApiTimeoutError` with a clear
  // message, never as a generic error or a silent hang.
  it('rejects a stalled request with a distinct ApiTimeoutError', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    global.fetch = vi.fn().mockRejectedValue(timeout);

    await expect(
      apiFetch('https://example.com/api/records'),
    ).rejects.toBeInstanceOf(ApiTimeoutError);

    await expect(apiFetch('https://example.com/api/records')).rejects.toThrow(
      `Request to https://example.com/api/records timed out after ${API_REQUEST_TIMEOUT_MS}ms`,
    );
  });

  // The signal aborts the body stream too, so a server that stalls after
  // sending headers rejects `response.json()` with the same TimeoutError —
  // it must translate to ApiTimeoutError just like a connection stall.
  it('rejects with ApiTimeoutError when the body read stalls past the timeout', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(timeout),
    } as unknown as Response);

    await expect(
      apiFetch('https://example.com/api/records'),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  // undici can surface a mid-body timeout wrapped in a `TypeError`
  // ("terminated") with the real reason on `.cause`; the translation must
  // still recognize it or the sync silently degrades to an empty result.
  it('translates a timeout wrapped in a cause chain', async () => {
    const wrapped = new TypeError('terminated', {
      cause: new DOMException('The operation timed out.', 'TimeoutError'),
    });
    global.fetch = vi.fn().mockRejectedValue(wrapped);

    await expect(
      apiFetch('https://example.com/api/records'),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  // apiFetch owns the only signal, so any abort is the timeout firing —
  // including a plain AbortError-named DOMException some undici paths report.
  it('translates a plain AbortError as a timeout', async () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    global.fetch = vi.fn().mockRejectedValue(aborted);

    await expect(
      apiFetch('https://example.com/api/records'),
    ).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('lets a non-timeout error pass through unwrapped', async () => {
    const networkError = new TypeError('fetch failed');
    global.fetch = vi.fn().mockRejectedValue(networkError);

    await expect(apiFetch('https://example.com/api/records')).rejects.toBe(
      networkError,
    );
  });

  // A circular `cause` chain must not spin the abort walk forever — the whole
  // point of the helper is preventing hangs. `MAX_CAUSE_DEPTH` bounds the walk,
  // so a self-referential cause whose names never match an abort terminates and
  // passes the original error through. Remove the bound and this test hangs
  // until vitest's per-test timeout fails it.
  it('does not hang on a self-referential cause chain', async () => {
    const looping = new TypeError('terminated') as TypeError & {
      cause: unknown;
    };
    looping.cause = looping;
    global.fetch = vi.fn().mockRejectedValue(looping);

    await expect(apiFetch('https://example.com/api/records')).rejects.toBe(
      looping,
    );
  });
});

describe('logApiFailure', () => {
  beforeEach(() => {
    vi.mocked(logErrorMessage).mockClear();
  });

  // The rethrow-vs-log split is the whole reason this seam exists: a timeout
  // must escape the resilient catch (fail loud) and must NOT also be logged as
  // a generic error, since callers like the sync log its reason themselves.
  it('re-throws a timeout without logging it', () => {
    const timeout = new ApiTimeoutError('https://example.com/api/records');

    expect(() => logApiFailure('fetchThing', timeout)).toThrow(timeout);
    expect(logErrorMessage).not.toHaveBeenCalled();
  });

  it('logs the message of any non-timeout error without throwing', () => {
    expect(() =>
      logApiFailure('fetchThing', new Error('server error')),
    ).not.toThrow();
    expect(logErrorMessage).toHaveBeenCalledWith('fetchThing', 'server error');
  });

  it('stringifies a non-Error thrown value when logging', () => {
    expect(() => logApiFailure('fetchThing', 'boom')).not.toThrow();
    expect(logErrorMessage).toHaveBeenCalledWith('fetchThing', 'boom');
  });
});

describe('rethrowIfTimeout', () => {
  it('re-throws an ApiTimeoutError so it escapes a resilient catch', () => {
    const timeout = new ApiTimeoutError('https://example.com/api/records');

    expect(() => rethrowIfTimeout(timeout)).toThrow(timeout);
  });

  it('returns without throwing for any other error', () => {
    expect(() => rethrowIfTimeout(new Error('server error'))).not.toThrow();
    expect(() => rethrowIfTimeout('boom')).not.toThrow();
  });
});
