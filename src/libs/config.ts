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

const checkApiToken = async () => {
  if (config.get('apiToken')) {
    return;
  }

  if (process.env.API_TOKEN) {
    config.set('apiToken', process.env.API_TOKEN);
    return;
  }

  const apiToken = await input({ message: 'Sync API Token' });

  if (!apiToken) {
    console.error(chalk.redBright('Sync API Token is required!'));
    process.exit(1);
  }

  config.set('apiToken', apiToken);
};

const checkOutputDirectory = async () => {
  if (config.get('outputDirectory')) {
    return;
  }

  if (process.env.OUTPUT_DIRECTORY) {
    config.set('outputDirectory', process.env.OUTPUT_DIRECTORY);
    return;
  }

  const outputDirectory = await input({ message: 'Output Directory' });

  if (!outputDirectory) {
    console.error(chalk.redBright('Output Directory is required!'));
    process.exit(1);
  }

  config.set('outputDirectory', outputDirectory);
};

export const checkConfig = async () => {
  await checkApiToken();
  await checkOutputDirectory();
};
