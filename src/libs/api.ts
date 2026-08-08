import { config } from '@/libs/config.js';
import { ApiError, ApiErrorEnvelope, ApiResponse } from '@/types/api.types.js';
import { logErrorMessage } from '@/libs/errors.js';

export const getBaseUrl = () => {
  return process.env.BASE_URL ?? 'https://sync.danholloran.me';
};

export const getApiToken = () => {
  return process.env.API_TOKEN ?? config.get('apiToken');
};

// Auth/authorization failures that doom the whole batch, not one request:
// 401 is a missing/expired/revoked token (markpost's `requireUser` throws a
// bare 401 with no `data.errors` body — so this must key off the HTTP status,
// not the parsed error list); 403 is sign-ups disabled (`ensureUserRegistered`)
// or the plan record-limit exceeded (`assertWithinRecordLimit` in markpost's
// `server/utils/planLimits.ts`) — both persist for every subsequent request.
const AUTH_STATUS_CODES = [401, 403];
// A rate-limit response will keep rejecting the whole burst, so a bulk caller
// should back off rather than keep firing requests that make it worse.
const RATE_LIMIT_STATUS_CODES = [429];
// Any 5xx is a server-side fault, not something the caller's payload can fix.
const SERVER_ERROR_MIN_STATUS = 500;

// A failed API request carrying the HTTP status the server responded with, so
// callers can tell a per-request problem (a 4xx the payload caused) apart from
// a systemic one (auth or server fault) that will recur on every subsequent
// request in a batch. `assertApiSuccess` throws this on any non-success.
export class ApiRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.statusCode = statusCode;
  }

  get isAuthFailure(): boolean {
    return AUTH_STATUS_CODES.includes(this.statusCode);
  }

  get isRateLimited(): boolean {
    return RATE_LIMIT_STATUS_CODES.includes(this.statusCode);
  }

  get isServerError(): boolean {
    return this.statusCode >= SERVER_ERROR_MIN_STATUS;
  }

  // Systemic = will recur for every other request too, so a bulk caller should
  // stop rather than fire N requests it already knows are doomed.
  get isSystemic(): boolean {
    return this.isAuthFailure || this.isRateLimited || this.isServerError;
  }
}

// Narrowing guard: true only for a systemic `ApiRequestError`. A network
// error, a per-file 4xx, or any other thrown value stays out so the caller
// keeps its existing per-item handling for those.
export const isSystemicApiFailure = (
  error: unknown,
): error is ApiRequestError =>
  error instanceof ApiRequestError && error.isSystemic;

// Labels the failure by kind so the classification stays inside the API layer
// instead of leaking status-code logic into command code. Falls back to a
// generic label if handed a non-systemic error, so a mislabel can't happen.
const failureKind = (error: ApiRequestError): string => {
  if (error.isAuthFailure) {
    return 'Authentication failed';
  }

  if (error.isRateLimited) {
    return 'Rate limited';
  }

  if (error.isServerError) {
    return 'Server error';
  }

  return 'Request failed';
};

// Human-readable summary of a systemic failure for the abort message.
export const describeSystemicFailure = (error: ApiRequestError): string => {
  return `${failureKind(error)} (HTTP ${error.statusCode}): ${error.message}`;
};

export const formatErrorMessages = (errors: ApiError[]) => {
  if (errors.length === 1) {
    return `${errors?.[0]?.title}: ${errors?.[0]?.detail}`;
  }

  if (errors.length > 1) {
    return errors
      .map((error) => `- ${error.title}: ${error.detail}`)
      .join('\n');
  }

  return 'Unknown error occurred';
};

// markpost's systemic failures often carry no `data.errors` body (e.g.
// `requireUser` throws a bare 401), which would otherwise surface as the
// useless "Unknown error occurred". These give the user something to act on
// when the body is empty; a populated `data.errors` still wins over them.
const STATUS_FALLBACK_MESSAGES: Record<number, string> = {
  401: 'Invalid or missing API token — run `markpost config` to set a valid one',
  403: 'Access forbidden — your account may be at its plan limit or sign-ups are disabled',
  429: 'Rate limited — too many requests in a short window; retry shortly',
};

const resolveErrorMessage = (errors: ApiError[], status: number): string => {
  if (errors.length > 0) {
    return formatErrorMessages(errors);
  }

  return STATUS_FALLBACK_MESSAGES[status] ?? formatErrorMessages(errors);
};

// An off-contract body can send `errors` as something other than an array
// (an object, a string, `null`) — spreading that directly would throw
// `TypeError: ... is not iterable` out of `assertApiSuccess` and surface a
// JS internals message instead of the server's actual error detail (or, for
// a string, spread into per-character entries and format as garbage).
// Falling back to `[]` for anything non-array keeps the "no errors present"
// path honest without crashing on a malformed field.
const toErrorArray = (value: unknown): ApiError[] =>
  Array.isArray(value) ? value : [];

// Every error response the API sends back is a non-2xx status carrying
// `data.errors`, regardless of whether the success shape is a single
// resource or a list; markpost's declared contract also allows a top-level
// `errors` field as an alternative shape (see `ApiErrorEnvelope`). Accept
// `unknown` so this works for both response shapes without callers needing
// to reshape their body first.
export const assertApiSuccess = (response: Response, body: unknown): void => {
  const envelope = body as ApiErrorEnvelope | undefined;
  // Combine both shapes rather than falling back from one to the other:
  // `??` would let a present-but-empty `data.errors: []` mask a populated
  // top-level `errors`, silently passing a body that carries both.
  const errors = [
    ...toErrorArray(envelope?.data?.errors),
    ...toErrorArray(envelope?.errors),
  ];
  const hasErrors = errors.length > 0;

  if (response.ok && !hasErrors) {
    return;
  }

  throw new ApiRequestError(
    resolveErrorMessage(errors, response.status),
    response.status,
  );
};

// Single seam for talking to the markpost API: prefixes the base URL,
// attaches the bearer token, throws with the server's real error detail on
// failure (via `assertApiSuccess`, so a 2xx response that still carries
// `errors` is caught here too, not just a non-2xx status), otherwise returns
// the parsed body for the caller to read in whatever shape (list, single,
// meta) it expects. `headers` is narrowed to a plain object so caller headers
// reliably merge on top of the auth header — a `Headers` instance or tuple
// array (both legal on `RequestInit`) would spread to nothing/garbage and
// silently drop them.
export const authedRequest = async (
  path: string,
  init: Omit<RequestInit, 'headers'> & {
    headers?: Record<string, string>;
  } = {},
): Promise<unknown> => {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiToken()}`,
      ...init.headers,
    },
  });

  const body = await response.json();

  assertApiSuccess(response, body);

  return body;
};

// Reads the `attributes` off a single-resource success response. Callers
// should run this only after `assertApiSuccess` has already ruled out the
// errors branch. The `?? null` covers every way this can come back empty —
// `data` missing entirely, `data` explicitly `null`, or (an off-contract
// response) a resource object with no `attributes` — collapsing all of them
// to the same `null` the return type promises, rather than leaking
// `undefined` in the last case.
export const unwrapResourceAttributes = <
  TResource extends { attributes: unknown },
>(
  body: ApiResponse<TResource | null>,
): TResource['attributes'] | null => body.data?.attributes ?? null;

// Reads the `attributes` off every resource in a list-success response,
// dropping (and loudly logging) any resource that's off-contract — no
// `attributes` at all, or `attributes` explicitly `null`. `!= null` catches
// both in one check. `context` identifies the caller in the log line (e.g.
// `fetchPaginatedRecords`, `fetchSources`) so a skip is traceable back to
// the request that produced it.
export const unwrapResourceCollection = <
  TResource extends { attributes: unknown },
>(
  context: string,
  body: ApiResponse<TResource[]>,
  label: string,
): TResource['attributes'][] => {
  const resources = body.data ?? [];
  const usableResources = resources.filter(
    (resource) => resource?.attributes != null,
  );

  if (usableResources.length !== resources.length) {
    logErrorMessage(
      context,
      `Skipped ${resources.length - usableResources.length} ${label}(s) with no attributes`,
    );
  }

  return usableResources.map(({ attributes }) => attributes);
};
