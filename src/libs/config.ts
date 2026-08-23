import Conf from 'conf';
import packageJson from './../../package.json' with { type: 'json' };
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { JSON_ERROR_CONFIG_REQUIRED, printJsonError } from '@/libs/output.js';

const schema = {
  apiToken: {
    type: 'string',
  },
  outputDirectory: {
    type: 'string',
  },
};

export const config = new Conf({
  projectName: packageJson.name,
  schema,
  // The store holds the API token, so keep the file readable only by its
  // owner instead of the default world-readable 0o644.
  configFileMode: 0o600,
});

// The keys the CLI persists, in the order they're displayed. Kept as one
// source of truth so the `config` command can iterate and validate against it
// rather than hard-coding the key list a second time.
export const CONFIG_KEYS = [
  'apiToken',
  'outputDirectory',
] as const satisfies readonly (keyof typeof schema)[];

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const isConfigKey = (value: string): value is ConfigKey => {
  return (CONFIG_KEYS as readonly string[]).includes(value);
};

// Thin seams over the `conf` store so callers (and their tests) don't reach
// into the Conf instance directly — the filesystem-backed store stays behind
// these accessors and can be mocked in isolation.
export const getConfigValue = (key: ConfigKey): string | undefined => {
  return config.get(key) as string | undefined;
};

export const setConfigValue = (key: ConfigKey, value: string): void => {
  config.set(key, value);
};

export const getConfigPath = (): string => {
  return config.path;
};

// One configurable value's identity: its store key, the env var that can set
// it non-interactively, and the label shown when prompting. Kept as data so a
// single resolver (below) handles both fields instead of duplicating the
// check-env-then-prompt flow per key.
type ConfigField = {
  key: ConfigKey;
  envVar: string;
  promptMessage: string;
};

const API_TOKEN_FIELD: ConfigField = {
  key: 'apiToken',
  envVar: 'API_TOKEN',
  promptMessage: 'Sync API Token',
};

const OUTPUT_DIRECTORY_FIELD: ConfigField = {
  key: 'outputDirectory',
  envVar: 'OUTPUT_DIRECTORY',
  promptMessage: 'Output Directory',
};

// Every field checkConfig requires, in resolution order. Kept as data (like
// CONFIG_KEYS) so the resolver loops instead of duplicating a guard per field.
const REQUIRED_CONFIG_FIELDS: readonly ConfigField[] = [
  API_TOKEN_FIELD,
  OUTPUT_DIRECTORY_FIELD,
];

// In --json mode an interactive prompt would render to the terminal and a
// piped consumer can't answer it anyway. So fail loud: write a structured
// diagnostic to stderr (not stdout — stdout is the data channel `--json | jq`
// reads, and a valid-JSON error there would be silently parsed as data),
// leaving stdout empty, then flag a non-zero exit. Set `process.exitCode`
// rather than calling `process.exit(1)`: stderr writes are async on a pipe and
// `process.exit` tears the process down without flushing them, so on the exact
// piped path this diagnostic exists for it could be dropped. Setting the exit
// code lets the process drain stderr and exit non-zero on its own — matching
// the repo-wide `process.exitCode = 1` convention (see errors.ts, usage.ts).
const failConfigRequiredAsJson = (field: ConfigField): void => {
  process.exitCode = 1;
  printJsonError(
    JSON_ERROR_CONFIG_REQUIRED,
    `${field.key} is not configured. In --json mode the CLI will not prompt; set the ${field.envVar} environment variable or run \`markpost config set ${field.key} <value>\` before retrying.`,
    { missing: field.key },
  );
};

// Resolves one field, returning whether the caller may proceed: `true` when the
// value is present (stored, from env, or freshly prompted), `false` when it
// could not be resolved and a diagnostic was emitted with a non-zero exit code
// set. Callers must stop on `false` — without a terminating `process.exit`, the
// short-circuit now rides on this return value instead of process teardown.
const ensureConfigValue = async (
  field: ConfigField,
  json: boolean,
): Promise<boolean> => {
  if (getConfigValue(field.key)) {
    return true;
  }

  const fromEnv = process.env[field.envVar];

  if (fromEnv) {
    setConfigValue(field.key, fromEnv);
    return true;
  }

  if (json) {
    failConfigRequiredAsJson(field);
    return false;
  }

  const value = await input({ message: field.promptMessage });

  if (!value) {
    process.exitCode = 1;
    console.error(chalk.redBright(`${field.promptMessage} is required!`));
    return false;
  }

  setConfigValue(field.key, value);
  return true;
};

// Resolves every required config field in order, stopping at the first that
// can't be resolved. Returns `true` only when all fields are present; a `false`
// return means a diagnostic was emitted and a non-zero exit code set, so the
// caller must return without doing work that needs the config.
export const checkConfig = async (json = false): Promise<boolean> => {
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!(await ensureConfigValue(field, json))) {
      return false;
    }
  }

  return true;
};
