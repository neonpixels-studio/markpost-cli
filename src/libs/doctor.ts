import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiRequestError,
  authedRequest,
  getApiToken,
  assertSafeBaseUrl,
  getConfiguredBaseUrl,
} from '#src/libs/api.js';
import { getConfigValue } from '#src/libs/config.js';
import { messageFromError } from '#src/libs/errors.js';
import { expandHomeDirectory } from '#src/libs/paths.js';
import { sanitizeForTerminal } from '#src/libs/terminal.js';

export type CheckResult = { name: string; ok: boolean; detail: string };

export const CHECK_CONFIG = 'config';
export const CHECK_BASE_URL = 'base-url';
export const CHECK_REACHABLE = 'api-reachable';
export const CHECK_TOKEN = 'token';
export const CHECK_OUTPUT_DIRECTORY = 'output-directory';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

// The cheapest authed read that has no side effects (GET /api/settings would
// create a default settings row for a fresh account). It needs `records:read`,
// which every sync needs too, so a token lacking it is worth flagging.
export const TOKEN_PROBE_PATH = '/api/records/stats';

const pass = (name: string, detail: string): CheckResult => ({
  name,
  ok: true,
  detail: sanitizeForTerminal(detail),
});

const skipped = (name: string, reason: string): CheckResult =>
  fail(name, `skipped, ${reason}`);

// Origin only, so credentials embedded in BASE_URL (user:pass@host) never print.
const displayUrl = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '(invalid URL)';
  }
};

const fail = (name: string, detail: string): CheckResult => ({
  name,
  ok: false,
  detail: sanitizeForTerminal(detail),
});

export const getConfiguredOutputDirectory = (): string | undefined => {
  return process.env.OUTPUT_DIRECTORY ?? getConfigValue('outputDirectory');
};

// Presence only, never the values: the token must not reach the output.
export const checkConfigPresent = (
  apiToken: string | undefined,
  outputDirectory: string | undefined,
): CheckResult => {
  const missing = [
    apiToken ? null : 'apiToken',
    outputDirectory ? null : 'outputDirectory',
  ].filter((key) => key !== null);

  if (missing.length > 0) {
    return fail(
      CHECK_CONFIG,
      `missing ${missing.join(', ')} (run \`markpost config set <key> <value>\` or set API_TOKEN / OUTPUT_DIRECTORY)`,
    );
  }

  return pass(CHECK_CONFIG, 'apiToken and outputDirectory are set');
};

export const checkBaseUrl = (baseUrl: string): CheckResult => {
  try {
    assertSafeBaseUrl(baseUrl);
  } catch (error) {
    return fail(CHECK_BASE_URL, messageFromError(error));
  }

  return pass(CHECK_BASE_URL, new URL(baseUrl).origin);
};

// Any HTTP response, even a 4xx/5xx, proves the host answered; only a thrown
// network error or timeout counts as unreachable.
export type ReachabilityProbe = (baseUrl: string) => Promise<number>;

export const probeReachability: ReachabilityProbe = async (baseUrl) => {
  // apiFetch would also parse the body as JSON, which the HTML landing page
  // is not; the timeout it exists to enforce is applied here directly.
  // eslint-disable-next-line no-restricted-globals
  const response = await fetch(baseUrl, {
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });

  await response.body?.cancel();

  return response.status;
};

// fetch rejects with a generic "fetch failed" and puts the real reason
// (ENOTFOUND, ECONNREFUSED, ...) on `cause`.
const describeNetworkFailure = (error: unknown): string => {
  const causeCode = (error as { cause?: NodeJS.ErrnoException })?.cause?.code;

  return causeCode
    ? `${messageFromError(error)} (${causeCode})`
    : messageFromError(error);
};

export const checkApiReachable = async (
  baseUrl: string,
  probe: ReachabilityProbe = probeReachability,
): Promise<CheckResult> => {
  try {
    const status = await probe(baseUrl);

    return pass(
      CHECK_REACHABLE,
      `${displayUrl(baseUrl)} responded (HTTP ${status})`,
    );
  } catch (error) {
    return fail(
      CHECK_REACHABLE,
      `${displayUrl(baseUrl)}: ${describeNetworkFailure(error)}`,
    );
  }
};

export type TokenProbe = () => Promise<unknown>;

export const probeToken: TokenProbe = () => authedRequest(TOKEN_PROBE_PATH);

const describeTokenFailure = (error: unknown): string => {
  if (
    error instanceof ApiRequestError &&
    error.statusCode === HTTP_UNAUTHORIZED
  ) {
    return 'token was rejected (missing, expired or revoked)';
  }

  if (error instanceof ApiRequestError && error.statusCode === HTTP_FORBIDDEN) {
    return `token was accepted but the request was forbidden (missing records:read, plan limit, or sign-ups disabled): ${error.message}`;
  }

  return messageFromError(error);
};

export const checkTokenAccepted = async (
  apiToken: string | undefined,
  probe: TokenProbe = probeToken,
): Promise<CheckResult> => {
  if (!apiToken) {
    return fail(CHECK_TOKEN, 'no token to test');
  }

  try {
    await probe();

    return pass(CHECK_TOKEN, 'accepted, records:read is allowed');
  } catch (error) {
    return fail(CHECK_TOKEN, describeTokenFailure(error));
  }
};

const resolveDirectory = (configured: string): string | Error => {
  try {
    return expandHomeDirectory(configured, homedir);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

// Returns why the directory is unusable, or null when files can be created in
// it (write plus search permission, both needed to create entries).
const findDirectoryProblem = async (
  directory: string,
): Promise<string | null> => {
  try {
    const stats = await stat(directory);

    if (!stats.isDirectory()) {
      return `${directory} is not a directory`;
    }

    await access(directory, constants.W_OK | constants.X_OK);

    return null;
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code ?? messageFromError(error);

    return `${directory} is not usable (${reason})`;
  }
};

export const checkOutputDirectory = async (
  configured: string | undefined,
): Promise<CheckResult> => {
  if (!configured) {
    return fail(CHECK_OUTPUT_DIRECTORY, 'not configured');
  }

  const directory = resolveDirectory(configured);

  if (directory instanceof Error) {
    return fail(CHECK_OUTPUT_DIRECTORY, directory.message);
  }

  const problem = await findDirectoryProblem(directory);

  if (problem) {
    return fail(CHECK_OUTPUT_DIRECTORY, problem);
  }

  return pass(CHECK_OUTPUT_DIRECTORY, `${directory} exists and is writable`);
};

// Network checks only run when the URL parses, and the token check only when
// the host answered, so one root cause shows as one failure plus skips.
const runNetworkChecks = async (
  baseUrlResult: CheckResult,
  baseUrl: string,
  apiToken: string | undefined,
): Promise<CheckResult[]> => {
  if (!baseUrlResult.ok) {
    return [
      skipped(CHECK_REACHABLE, 'BASE_URL is invalid'),
      skipped(CHECK_TOKEN, 'BASE_URL is invalid'),
    ];
  }

  const reachableResult = await checkApiReachable(baseUrl);

  if (!reachableResult.ok) {
    return [reachableResult, skipped(CHECK_TOKEN, 'API is unreachable')];
  }

  return [reachableResult, await checkTokenAccepted(apiToken)];
};

export const runDoctorChecks = async (): Promise<CheckResult[]> => {
  const apiToken = getApiToken();
  const outputDirectory = getConfiguredOutputDirectory();
  const baseUrl = getConfiguredBaseUrl();
  const baseUrlResult = checkBaseUrl(baseUrl);

  return [
    checkConfigPresent(apiToken, outputDirectory),
    baseUrlResult,
    ...(await runNetworkChecks(baseUrlResult, baseUrl, apiToken)),
    await checkOutputDirectory(outputDirectory),
  ];
};
