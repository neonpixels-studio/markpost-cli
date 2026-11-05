import chalk from 'chalk';
import {
  CONFIG_KEYS,
  ConfigKey,
  getConfigPath,
  getConfigValue,
  isConfigKey,
  setConfigValue,
} from '#src/libs/config.js';
import { failWithMessage } from '#src/libs/errors.js';
import { hasJsonFlag, printJson, withoutJsonFlag } from '#src/libs/output.js';
import { failWithSubcommandUsage, failWithUsage } from '#src/libs/usage.js';

export const USAGE = `Usage: markpost config <get|set|path> [key] [value] [--json]

  get [key] [--json]  Show all stored config, or just <key> if given;
                 --json prints machine-readable output (secrets stay masked)
  set <key> <value>  Store <value> under <key>
  path           Print the location of the config file

  keys: ${CONFIG_KEYS.join(', ')}`;

// apiToken is a secret, so it's never printed in full. outputDirectory is a
// plain path and shown as-is.
const SENSITIVE_KEYS = new Set<ConfigKey>(['apiToken']);

const NOT_SET_LABEL = '(not set)';
const GET_SUBCOMMAND = 'get';
const CONFIG_READ_FAILED_MESSAGE = 'Could not read config.';
const JSON_ONLY_ON_GET_MESSAGE = '--json is only supported by `config get`.';

// A fixed-width middle mask keeps the redacted token from leaking its real
// length, while the visible edges still let a user confirm which token is
// stored.
const VISIBLE_EDGE_LENGTH = 4;
const MASK_SEGMENT = '****';

// Require at least as many hidden characters as revealed ones before showing
// the edges (both edges reveal VISIBLE_EDGE_LENGTH * 2) — otherwise a short
// token would surface most of the secret.
const MIN_LENGTH_TO_REVEAL_EDGES = VISIBLE_EDGE_LENGTH * 4;

// How many arguments each subcommand accepts, counting the subcommand itself.
// More than this means an unquoted value with spaces was split, so fail rather
// than silently store (or read from) a truncated value.
const MAX_ARGS_BY_SUBCOMMAND = new Map<string, number>([
  ['get', 2],
  ['set', 3],
  ['path', 1],
]);

const maskToken = (token: string): string => {
  if (token.length < MIN_LENGTH_TO_REVEAL_EDGES) {
    return MASK_SEGMENT;
  }

  const prefix = token.slice(0, VISIBLE_EDGE_LENGTH);
  const suffix = token.slice(-VISIBLE_EDGE_LENGTH);

  return `${prefix}${MASK_SEGMENT}${suffix}`;
};

const formatValue = (key: ConfigKey, value: string | undefined): string => {
  if (!value) {
    return NOT_SET_LABEL;
  }

  if (SENSITIVE_KEYS.has(key)) {
    return maskToken(value);
  }

  return value;
};

const printKey = (key: ConfigKey): void => {
  // Guard the store read so an access-time failure surfaces a readable message
  // instead of a raw stack trace. (A file corrupt enough to break parsing
  // throws earlier, in the `conf` constructor at import time — see the
  // follow-up note in the PR.)
  try {
    console.log(`${key}: ${formatValue(key, getConfigValue(key))}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(chalk.redBright(`Could not read ${key}: ${detail}`));
    process.exitCode = 1;
  }
};

// Unset values are `null` (the JSON counterpart of the "(not set)" label), and
// sensitive values go through the same mask as the human output so a token is
// never printed in full in either mode.
const jsonValue = (
  key: ConfigKey,
  value: string | undefined,
): string | null => {
  if (!value) {
    return null;
  }

  return SENSITIVE_KEYS.has(key) ? maskToken(value) : value;
};

const printKeysAsJson = (keys: readonly ConfigKey[]): void => {
  try {
    printJson(
      Object.fromEntries(
        keys.map((key) => [key, jsonValue(key, getConfigValue(key))]),
      ),
    );
  } catch {
    // Fixed text on purpose: a corrupt-config parse error can embed an excerpt
    // of the file, which holds the raw API token.
    failWithMessage(CONFIG_READ_FAILED_MESSAGE, true);
  }
};

const resolveRequestedKeys = (
  key: string | undefined,
  json: boolean,
): readonly ConfigKey[] | null => {
  if (!key) {
    return CONFIG_KEYS;
  }

  if (!isConfigKey(key)) {
    failWithUsage(`Unknown config key: ${key}`, USAGE, json);
    return null;
  }

  return [key];
};

const getConfig = (key: string | undefined, json: boolean): void => {
  const keys = resolveRequestedKeys(key, json);

  if (!keys) {
    return;
  }

  if (json) {
    printKeysAsJson(keys);
    return;
  }

  keys.forEach(printKey);
};

const setConfig = (key?: string, value?: string): void => {
  const trimmedValue = value?.trim();

  if (!key || !trimmedValue) {
    failWithUsage('Both a key and a non-empty value are required.', USAGE);
    return;
  }

  if (!isConfigKey(key)) {
    failWithUsage(`Unknown config key: ${key}`, USAGE);
    return;
  }

  // `conf` throws on schema-validation and filesystem errors (e.g. an
  // unwritable config dir); surface a friendly message rather than a stack
  // trace.
  try {
    setConfigValue(key, trimmedValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(chalk.redBright(`Could not save ${key}: ${detail}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    chalk.greenBright(`Set ${key} to ${formatValue(key, trimmedValue)}`),
  );
};

const printPath = (): void => {
  console.log(getConfigPath());
};

export const runConfigCommand = async (rawArgs: string[]): Promise<void> => {
  const json = hasJsonFlag(rawArgs);
  const args = withoutJsonFlag(rawArgs);
  const [subcommand, key, value] = args;

  // `set` and `path` have no JSON rendering; reject the flag instead of
  // silently dropping it (or, for `set`, storing "--json" as a value).
  if (json && !MAX_ARGS_BY_SUBCOMMAND.has(subcommand ?? '')) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  if (json && subcommand !== GET_SUBCOMMAND) {
    failWithUsage(JSON_ONLY_ON_GET_MESSAGE, USAGE, json);
    return;
  }

  const maxArgs = MAX_ARGS_BY_SUBCOMMAND.get(subcommand ?? '');

  if (maxArgs !== undefined && args.length > maxArgs) {
    failWithUsage(
      `Too many arguments for \`config ${subcommand}\`. Quote values that contain spaces.`,
      USAGE,
      json,
    );
    return;
  }

  if (subcommand === GET_SUBCOMMAND) {
    getConfig(key, json);
    return;
  }

  if (subcommand === 'set') {
    setConfig(key, value);
    return;
  }

  if (subcommand === 'path') {
    printPath();
    return;
  }

  // A bare `markpost config` or an unrecognized subcommand prints usage, the
  // same convention `markpost records`/`markpost sources` follow.
  console.log(USAGE);
};
