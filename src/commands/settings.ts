import chalk from 'chalk';
import {
  fetchSettings,
  resolveSyncSettings,
  updateSettings,
  ResolvedSyncSettings,
  SettingsReadResult,
} from '@/libs/settings.js';
import { checkConfig } from '@/libs/config.js';
import { failWithSubcommandUsage, failWithUsage } from '@/libs/usage.js';
import {
  CONFLICT_STRATEGIES,
  ConflictStrategy,
  isConflictStrategy,
  UpdateSettingsInput,
} from '@/types/settings.types.js';

// The boolean settings a `set` accepts, keyed by the exact attribute name
// markpost's PUT contract expects (server/api/settings/index.put.ts). Named
// so the parser and usage text share one source of truth for the field names.
const BOOLEAN_SETTING_KEYS = ['autoSync', 'autoDelete', 'frontmatter'] as const;
type BooleanSettingKey = (typeof BOOLEAN_SETTING_KEYS)[number];

const CONFLICT_STRATEGY_KEY = 'conflictStrategy';

// A `set` field arrives as one `key=value` token; the first `=` splits it so a
// value can safely contain further `=` (none of the current values do, but the
// split shouldn't silently truncate one that did).
const KEY_VALUE_SEPARATOR = '=';

const BOOLEAN_TRUE = 'true';
const BOOLEAN_FALSE = 'false';

// Width the settable-key labels pad to so their accepted-value columns line up.
// `conflictStrategy` (the longest key) plus two spaces sets it.
const KEY_LABEL_WIDTH = CONFLICT_STRATEGY_KEY.length + 2;

const BOOLEAN_VALUES_HINT = `${BOOLEAN_TRUE}|${BOOLEAN_FALSE}`;

// Derive the `settable keys` block from the same constants the parser validates
// against, so adding or renaming a key can't leave the usage text (or `get`
// output) silently describing fields that no longer match what `set` accepts.
const SETTABLE_KEYS_USAGE = [
  ...BOOLEAN_SETTING_KEYS.map(
    (key) => `    ${key.padEnd(KEY_LABEL_WIDTH)}${BOOLEAN_VALUES_HINT}`,
  ),
  `    ${CONFLICT_STRATEGY_KEY.padEnd(KEY_LABEL_WIDTH)}${CONFLICT_STRATEGIES.join('|')}`,
].join('\n');

export const USAGE = `Usage: markpost settings <get|set> [key=value ...]

  get              Print the current server-side sync settings
  set <key=value>  Update one or more settings, e.g.
                   markpost settings set autoDelete=false conflictStrategy=overwrite

  settable keys:
${SETTABLE_KEYS_USAGE}`;

// A parse either yields a typed value or a human-readable reason it failed, so
// the caller reports the exact problem instead of a generic "invalid value".
type ParseResult<TValue> =
  { ok: true; value: TValue } | { ok: false; error: string };

const isBooleanSettingKey = (key: string): key is BooleanSettingKey => {
  return (BOOLEAN_SETTING_KEYS as readonly string[]).includes(key);
};

const parseBoolean = (raw: string): ParseResult<boolean> => {
  if (raw === BOOLEAN_TRUE) {
    return { ok: true, value: true };
  }

  if (raw === BOOLEAN_FALSE) {
    return { ok: true, value: false };
  }

  return {
    ok: false,
    error: `expected \`${BOOLEAN_TRUE}\` or \`${BOOLEAN_FALSE}\`, got \`${raw}\``,
  };
};

const parseConflictStrategy = (raw: string): ParseResult<ConflictStrategy> => {
  if (isConflictStrategy(raw)) {
    return { ok: true, value: raw };
  }

  return {
    ok: false,
    error: `expected one of ${CONFLICT_STRATEGIES.join(', ')}, got \`${raw}\``,
  };
};

const applyBooleanField = (
  input: UpdateSettingsInput,
  key: BooleanSettingKey,
  rawValue: string,
): string | null => {
  const parsed = parseBoolean(rawValue);

  if (!parsed.ok) {
    return `${key}: ${parsed.error}`;
  }

  input[key] = parsed.value;
  return null;
};

const applyConflictStrategyField = (
  input: UpdateSettingsInput,
  rawValue: string,
): string | null => {
  const parsed = parseConflictStrategy(rawValue);

  if (!parsed.ok) {
    return `${CONFLICT_STRATEGY_KEY}: ${parsed.error}`;
  }

  input.conflictStrategy = parsed.value;
  return null;
};

// Validates one field against the contract and writes it into the accumulating
// payload, returning an error message (never throwing) so a bad field fails the
// whole `set` with a clear reason before any request is made. An unknown key is
// rejected here rather than passed through — markpost would ignore it, leaving
// the user thinking a typo'd field was applied.
const applyField = (
  input: UpdateSettingsInput,
  key: string,
  rawValue: string,
): string | null => {
  // A repeated key would otherwise last-wins silently — the one hole in an
  // otherwise fail-loud parser, and the case most likely to come from a
  // scripted loop or an edited shell-history line where the user can't see
  // which value actually won. `Object.hasOwn` (not `key in input`) so an
  // inherited member name like `toString` isn't mistaken for a repeat and
  // instead falls through to the "Unknown setting" branch below.
  if (Object.hasOwn(input, key)) {
    return `${key}: given more than once.`;
  }

  if (isBooleanSettingKey(key)) {
    return applyBooleanField(input, key, rawValue);
  }

  if (key === CONFLICT_STRATEGY_KEY) {
    return applyConflictStrategyField(input, rawValue);
  }

  return `Unknown setting: \`${key}\``;
};

const splitPair = (token: string): { key: string; value: string } | null => {
  const separatorIndex = token.indexOf(KEY_VALUE_SEPARATOR);

  // `<= 0` rejects both a token with no `=` and one with an empty key (`=x`).
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    key: token.slice(0, separatorIndex),
    value: token.slice(separatorIndex + KEY_VALUE_SEPARATOR.length),
  };
};

const applyToken = (
  input: UpdateSettingsInput,
  token: string,
): string | null => {
  const pair = splitPair(token);

  if (!pair) {
    return `Invalid field \`${token}\` — expected \`key=value\`.`;
  }

  return applyField(input, pair.key, pair.value);
};

type BuildResult =
  { ok: true; input: UpdateSettingsInput } | { ok: false; error: string };

// Folds every `key=value` token into one validated payload, stopping at the
// first bad field so the request is never sent with a partial or invalid set.
const buildUpdateInput = (tokens: string[]): BuildResult => {
  const input: UpdateSettingsInput = {};

  for (const token of tokens) {
    const error = applyToken(input, token);

    if (error) {
      return { ok: false, error };
    }
  }

  return { ok: true, input };
};

// Every value here is either a boolean or a normalized `ConflictStrategy`
// literal (not raw API text), so it's safe to print without terminal
// sanitization — unlike the free-form record/source fields other commands
// receive from the server.
const printSettings = (settings: ResolvedSyncSettings): void => {
  console.log(`  autoSync:         ${settings.autoSync}`);
  console.log(`  autoDelete:       ${settings.autoDelete}`);
  console.log(`  frontmatter:      ${settings.includeFrontmatter}`);
  console.log(`  conflictStrategy: ${settings.conflictStrategy}`);
};

const getSettings = async (rest: string[]): Promise<void> => {
  if (rest.length > 0) {
    failWithUsage('`settings get` takes no arguments.', USAGE);
    return;
  }

  const result = await fetchSettings();

  // Unlike the sync (which degrades a failed read to safe defaults), an
  // explicit `settings get` must fail loud — reporting made-up defaults as the
  // server's current settings would mislead the user about what's stored.
  if (!result.ok) {
    console.error(chalk.redBright('Could not read settings from the server.'));
    process.exitCode = 1;
    return;
  }

  // A successful read with no saved row means the account has never customized
  // its settings, so what prints below are markpost's defaults, not stored
  // values. Say so rather than letting the user read a default `autoDelete:
  // true` as a deliberate choice.
  if (result.settings === null) {
    console.log(
      'No saved settings on this account — showing markpost defaults:',
    );
  }

  printSettings(resolveSyncSettings(result));
};

const setSettings = async (rest: string[]): Promise<void> => {
  if (rest.length === 0) {
    failWithUsage(
      'No fields to set — provide at least one `key=value`.',
      USAGE,
    );
    return;
  }

  const built = buildUpdateInput(rest);

  if (!built.ok) {
    failWithUsage(built.error, USAGE);
    return;
  }

  const updated = await updateSettings(built.input);

  if (!updated) {
    console.error(chalk.redBright('Failed to update settings.'));
    process.exitCode = 1;
    return;
  }

  // Reuse the read's normalizer so the echoed-back settings print exactly like
  // `get` does, from one place.
  const echoed: SettingsReadResult = { ok: true, settings: updated };
  console.log(chalk.greenBright('Settings updated.'));
  printSettings(resolveSyncSettings(echoed));
};

// Membership check and handler come from the same Map, so a valid subcommand
// always has a handler. A Map (not an object) keeps a subcommand named
// "toString" from resolving to a prototype member.
const SETTINGS_HANDLERS = new Map<string, (rest: string[]) => Promise<void>>([
  ['get', (rest) => getSettings(rest)],
  ['set', (rest) => setSettings(rest)],
]);

export const runSettingsCommand = async (args: string[]): Promise<void> => {
  const [subcommand, ...rest] = args;
  const handler = SETTINGS_HANDLERS.get(subcommand);

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account (mirrors `sources`).
  if (!handler) {
    failWithSubcommandUsage(subcommand, USAGE);
    return;
  }

  try {
    if (!(await checkConfig())) {
      return;
    }

    await handler(rest);
  } catch (error) {
    console.error(chalk.redBright(error));
    process.exitCode = 1;
  }
};
