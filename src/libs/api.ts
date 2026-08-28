import { config } from '@/libs/config.js';
import { ApiError, ApiErrorEnvelope, ApiResponse } from '@/types/api.types.js';
import { logErrorMessage } from '@/libs/errors.js';

export const getBaseUrl = () => {
  return process.env.BASE_URL ?? 'https://sync.danholloran.me';
};

export const getApiToken = () => {
  return process.env.API_TOKEN ?? config.get('apiToken');
};

// How long any API request may stall before it's aborted. Without this a
// hung connection blocks the sync — and any unattended cron run — forever;
// `AbortSignal.timeout` makes a stalled request fail loud instead.
export const API_REQUEST_TIMEOUT_MS = 30_000;

// A timeout must be distinguishable from an ordinary API failure so it
// surfaces as its own clear message (fail loud) rather than being logged as
// a generic error or collapsing into a silent empty result.
export class ApiTimeoutError extends Error {
  constructor(url: string) {
    super(`Request to ${url} timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
    this.name = 'ApiTimeoutError';
  }
}

// A cause chain should never be circular, but a self-referential `cause`
// would spin `isTimeoutAbort` forever — an unacceptable failure mode for the
// helper whose whole purpose is preventing hangs. Bound the walk instead.
const MAX_CAUSE_DEPTH = 8;

// `apiFetch` owns the only signal on these requests (it takes
// `Omit<…, 'signal'>`), so *any* abort is the timeout firing. `AbortSignal
// .timeout` aborts with a `TimeoutError` DOMException, but undici doesn't
// always surface that bare — a mid-body abort can come back as a `TypeError`
// ("terminated") with the real reason on `.cause`, and some paths report a
// plain `AbortError`. Match either abort name, walking the (bounded) cause
// chain, and let every unrelated rejection pass through untouched.
const ABORT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);

const isTimeoutAbort = (error: unknown): boolean => {
  let current: unknown = error;

  for (
    let depth = 0;
    current instanceof Error && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    if (ABORT_ERROR_NAMES.has(current.name)) {
      return true;
    }

    current = current.cause;
  }

  return false;
};

export type ApiFetchResult = { response: Response; body: unknown };

// Single seam wrapping `fetch` (and the JSON read) with a request timeout so
// a stalled connection fails loud as `ApiTimeoutError` instead of hanging
// forever. Owns only the timeout + transport concern: callers still attach
// their own headers/body and run `assertApiSuccess` on the result. The
// signal is owned here (`Omit<..., 'signal'>`) so a caller can't silently
// override the timeout.
export const apiFetch = async (
  url: string,
  init: Omit<RequestInit, 'signal'> = {},
): Promise<ApiFetchResult> => {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
    const body = await response.json();

    return { response, body };
  } catch (error) {
    if (isTimeoutAbort(error)) {
      throw new ApiTimeoutError(url);
    }

    throw error;
  }
};

// Guard for the resilient per-call catches that otherwise downgrade any
// failure to an empty result: a timeout must escape them so the sync fails
// loud (non-zero exit) rather than reporting "nothing to fetch". Call this
// first in those catches — it re-throws a timeout and returns for every
// other error, letting the caller fall through to its conservative fallback.
export const rethrowIfTimeout = (error: unknown): void => {
  if (error instanceof ApiTimeoutError) {
    throw error;
  }
};

// Pulls a printable string off an unknown thrown value: an `Error`'s message,
// otherwise its `String()` form. Shared by `logApiFailure` and
// `describeApiError` so neither re-derives the extraction.
const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The one way to report a failed API call from a resilient catch: re-throw a
// timeout (fail loud) and log every other error. Bundling both halves means
// a new call site can't log-and-swallow a timeout by forgetting the rethrow,
// and removes the `error instanceof Error ? ...` extraction repeated at
// every catch. Callers still return their own conservative fallback after.
export const logApiFailure = (context: string, error: unknown): void => {
  rethrowIfTimeout(error);

  logErrorMessage(context, messageFromError(error));
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
// Request-shape failures: a malformed payload (400) or an off-contract
// validation rejection (422, e.g. markpost tightening the PATCH attributes it
// accepts). When every record in a batch is built the same way, such a failure
// recurs identically for all of them, so a bulk caller can abort rather than
// retry each doomed request. A per-record 4xx (a 404 for a record deleted
// mid-run, a 422 on one record's own value) and a transient 429 are deliberately
// excluded — the caller confirms the whole batch agreed before treating it as
// request-shape.
const FATAL_REQUEST_STATUS_CODES = [400, 422];
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

  // A request-shape 4xx (400/422) that recurs identically for every record built
  // the same way — the request the caller constructed is wrong, so firing the
  // rest of a batch just repeats the same failure. Excludes per-record 4xx (a
  // 404 for a record deleted mid-run) and the transient 429, which don't doom
  // the batch.
  get isFatalRequest(): boolean {
    return FATAL_REQUEST_STATUS_CODES.includes(this.statusCode);
  }

  // Systemic = will recur for every other request too, so a bulk caller should
  // stop rather than fire N requests it already knows are doomed.
  get isSystemic(): boolean {
    return this.isAuthFailure || this.isRateLimited || this.isServerError;
  }

  // Permanent = won't clear on a blind retry: a dead/missing token (401) or a
  // forbidden account state — sign-ups disabled or a plan limit (403) — needs a
  // human to fix config or the account first. A rate-limit (429) or 5xx is
  // systemic-but-transient, so it stays out: an autoSync daemon should keep
  // retrying those on its next pass ("retry shortly"), not shut down for good.
  get isPermanent(): boolean {
    return this.isAuthFailure;
  }
}

// Narrowing guard: true only for a systemic `ApiRequestError`. A network
// error, a per-file 4xx, or any other thrown value stays out so the caller
// keeps its existing per-item handling for those.
export const isSystemicApiFailure = (
  error: unknown,
): error is ApiRequestError =>
  error instanceof ApiRequestError && error.isSystemic;

// Narrowing guard: true only for a request-shape `ApiRequestError` (a 400/422
// rejection — NOT a per-record 404, an auth 401/403, or a transient 429). Lets a
// bulk caller TAG the outcome so it can decide, after seeing a SECOND chunk agree
// with nothing synced, whether the request shape itself is wrong (see
// `markRecordsSynced`). It does not itself mean "abort now" — a lone 400/422 can
// still be an isolated rejection.
export const isFatalRequestError = (error: unknown): error is ApiRequestError =>
  error instanceof ApiRequestError && error.isFatalRequest;

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

// The clearest user-facing message for any error surfaced from an API call: a
// systemic `ApiRequestError` (auth/rate-limit/5xx) gets its classified,
// actionable description (`describeSystemicFailure`); anything else falls back
// to its raw message. Keeps command-layer catches from re-deriving the
// systemic-vs-generic split at every call site. Callers sanitize the result
// before printing — a server-derived message can carry a terminal escape.
export const describeApiError = (error: unknown): string => {
  if (isSystemicApiFailure(error)) {
    return describeSystemicFailure(error);
  }

  return messageFromError(error);
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
// silently drop them. The transport goes through `apiFetch`, so every request
// made via this seam inherits the request timeout (a stall fails loud as
// `ApiTimeoutError` instead of hanging the sync forever); `signal` is owned by
// `apiFetch`, so callers can't override the timeout.
export const authedRequest = async (
  path: string,
  init: Omit<RequestInit, 'headers' | 'signal'> & {
    headers?: Record<string, string>;
  } = {},
): Promise<unknown> => {
  const { response, body } = await apiFetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiToken()}`,
      ...init.headers,
    },
  });

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
