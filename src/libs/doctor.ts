import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiRequestError,
  authedRequest,
  getApiToken,
  getBaseUrl,
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

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

// The cheapest authed read that has no side effects (GET /api/settings would
// create a default settings row for a fresh account). It needs `records:read`,
// which every sync needs too, so a token lacking it is worth flagging.
export const TOKEN_PROBE_PATH = '/api/records/stats';

const pass = (name: string, detail: string): CheckResult => ({
  name,
  ok: true,
  detail,
});

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
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    return fail(CHECK_BASE_URL, `${baseUrl} is not a valid URL`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return fail(
      CHECK_BASE_URL,
      `${baseUrl} must use http: or https:, got ${parsed.protocol}`,
    );
  }

  return pass(CHECK_BASE_URL, parsed.origin);
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

  return response.status;
};

export const checkApiReachable = async (
  baseUrl: string,
  probe: ReachabilityProbe = probeReachability,
): Promise<CheckResult> => {
  try {
    const status = await probe(baseUrl);

    return pass(CHECK_REACHABLE, `${baseUrl} responded (HTTP ${status})`);
  } catch (error) {
    return fail(CHECK_REACHABLE, `${baseUrl}: ${messageFromError(error)}`);
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
    return `token was accepted but is not allowed to read records (needs records:read): ${error.message}`;
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

export const checkOutputDirectory = async (
  configured: string | undefined,
): Promise<CheckResult> => {
  if (!configured) {
    return fail(CHECK_OUTPUT_DIRECTORY, 'not configured');
  }

  let directory: string;

  try {
    directory = expandHomeDirectory(configured, homedir);
  } catch (error) {
    return fail(CHECK_OUTPUT_DIRECTORY, messageFromError(error));
  }

  try {
    const stats = await stat(directory);

    if (!stats.isDirectory()) {
      return fail(CHECK_OUTPUT_DIRECTORY, `${directory} is not a directory`);
    }

    await access(directory, constants.W_OK);
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code ?? messageFromError(error);

    return fail(
      CHECK_OUTPUT_DIRECTORY,
      `${directory} is not usable (${reason})`,
    );
  }

  return pass(CHECK_OUTPUT_DIRECTORY, `${directory} exists and is writable`);
};

export const runDoctorChecks = async (): Promise<CheckResult[]> => {
  const apiToken = getApiToken();
  const outputDirectory = getConfiguredOutputDirectory();
  const baseUrl = getBaseUrl();

  return [
    checkConfigPresent(apiToken, outputDirectory),
    checkBaseUrl(baseUrl),
    await checkApiReachable(baseUrl),
    await checkTokenAccepted(apiToken),
    await checkOutputDirectory(outputDirectory),
  ];
};
