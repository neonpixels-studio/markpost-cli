import chalk from 'chalk';
import {
  CONFIG_KEYS,
  ConfigKey,
  getConfigPath,
  getConfigValue,
  isConfigKey,
  setConfigValue,
} from '@/libs/config.js';

export const USAGE = `Usage: markpost config <get|set|path> [key] [value]

  get [key]      Show all stored config, or just <key> if given
  set <key> <value>  Store <value> under <key>
  path           Print the location of the config file

  keys: ${CONFIG_KEYS.join(', ')}`;

// apiToken is a secret, so it's never printed in full. outputDirectory is a
// plain path and shown as-is.
const SENSITIVE_KEYS = new Set<ConfigKey>(['apiToken']);

const NOT_SET_LABEL = '(not set)';

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

// Usage that accompanies an error goes to stderr (with a non-zero exit) so a
// piped `config get` doesn't fold help text into its captured output.
const failWithUsage = (message: string): void => {
  console.error(chalk.redBright(message));
  console.error(USAGE);
  process.exitCode = 1;
};

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

const getConfig = (key?: string): void => {
  if (!key) {
    CONFIG_KEYS.forEach(printKey);
    return;
  }

  if (!isConfigKey(key)) {
    failWithUsage(`Unknown config key: ${key}`);
    return;
  }

  printKey(key);
};

const setConfig = (key?: string, value?: string): void => {
  const trimmedValue = value?.trim();

  if (!key || !trimmedValue) {
    failWithUsage('Both a key and a non-empty value are required.');
    return;
  }

  if (!isConfigKey(key)) {
    failWithUsage(`Unknown config key: ${key}`);
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

export const runConfigCommand = async (args: string[]): Promise<void> => {
  const [subcommand, key, value] = args;

  const maxArgs = MAX_ARGS_BY_SUBCOMMAND.get(subcommand ?? '');

  if (maxArgs !== undefined && args.length > maxArgs) {
    failWithUsage(
      `Too many arguments for \`config ${subcommand}\`. Quote values that contain spaces.`,
    );
    return;
  }

  if (subcommand === 'get') {
    getConfig(key);
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
