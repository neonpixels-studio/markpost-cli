import Conf from 'conf';
import packageJson from './../../package.json' with { type: 'json' };
import { input } from '@inquirer/prompts';
import chalk from 'chalk';

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

// In --json mode an interactive prompt would render to the terminal and a
// piped consumer can't answer it anyway. So fail loud: write a structured
// diagnostic to stderr (not stdout — stdout is the data channel `--json | jq`
// reads, and a valid-JSON error there would be silently parsed as data),
// leaving stdout empty, then exit non-zero.
const failConfigRequiredAsJson = (field: ConfigField): void => {
  console.error(
    JSON.stringify({
      error: 'config_required',
      missing: field.key,
      message: `${field.key} is not configured. In --json mode the CLI will not prompt; set the ${field.envVar} environment variable or run \`markpost config\` before retrying.`,
    }),
  );
  process.exit(1);
};

const ensureConfigValue = async (
  field: ConfigField,
  json: boolean,
): Promise<void> => {
  if (getConfigValue(field.key)) {
    return;
  }

  const fromEnv = process.env[field.envVar];

  if (fromEnv) {
    setConfigValue(field.key, fromEnv);
    return;
  }

  if (json) {
    // Explicit return so the short-circuit doesn't rely on process.exit being
    // terminating — without it, a non-terminating exit would fall through to
    // the interactive prompt this branch exists to avoid.
    failConfigRequiredAsJson(field);
    return;
  }

  const value = await input({ message: field.promptMessage });

  if (!value) {
    console.error(chalk.redBright(`${field.promptMessage} is required!`));
    // Explicit return so the write below stays unreachable even if process.exit
    // is stubbed/patched (as it is in tests) and doesn't terminate — matching
    // the --json branch's invariant, without which an empty answer persists ''.
    process.exit(1);
    return;
  }

  setConfigValue(field.key, value);
};

export const checkConfig = async (json = false): Promise<void> => {
  await ensureConfigValue(API_TOKEN_FIELD, json);
  await ensureConfigValue(OUTPUT_DIRECTORY_FIELD, json);
};
