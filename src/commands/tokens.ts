import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { createToken, fetchTokens, revokeToken } from '@/libs/tokens.js';
import { checkConfig } from '@/libs/config.js';
import { getApiToken } from '@/libs/api.js';
import { failWithMessage } from '@/libs/errors.js';
import { isInteractiveTerminal, sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage, failWithUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import { CreateTokenInput, Token } from '@/types/tokens.types.js';

export const USAGE = `Usage: markpost tokens <list|create|revoke> [id] [--yes]

  list                                             List all API tokens (pass --json for machine-readable output)
  create --name <name> [--expires-in-days <days>]  Mint a new API token; the raw secret is shown once and cannot be retrieved again
  revoke <id>                                      Revoke an API token by id. Asks to confirm first (revoking is irreversible); pass --yes to skip the prompt (for scripts)`;

const LIST_SUBCOMMAND = 'list';
const CREATE_SUBCOMMAND = 'create';
// `revoke` is the only subcommand `--yes` applies to, so it's named for the
// guard that rejects the flag elsewhere as well as its handler-map key.
const REVOKE_SUBCOMMAND = 'revoke';

// The confirmation escape hatch, read straight from argv the same way
// `hasJsonFlag` reads `--json`, so the runner can reject it on the wrong
// subcommand before any subcommand-level parseArgs runs. `sources delete`
// reaches the same outcome via a single unified `parseArgs` call instead;
// this file keeps `--json` and `--yes` consistent with each other rather
// than matching that mechanism exactly.
const YES_FLAG = '--yes';
const ARGS_TERMINATOR = '--';

// Unlike a plain `args.includes(YES_FLAG)`, this stops scanning at a literal
// `--`, so `tokens revoke -- --yes` (an id that happens to be the string
// "--yes") isn't misread as the flag — matching how `revokeTokenCommand`'s
// own `parseArgs` call (which understands `--`) resolves the same argv.
const hasYesFlag = (args: string[]): boolean => {
  const terminatorIndex = args.indexOf(ARGS_TERMINATOR);
  const scanned =
    terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return scanned.includes(YES_FLAG);
};

const TOKEN_SECRET_NOTICE =
  'API token (shown once — copy it now, it cannot be retrieved later):';

// markpost reveals the freshly minted raw secret exactly once, in the create
// response only (never list). Mirrors `printProviderSecret` in
// commands/sources.ts.
const printTokenSecret = (token: string): void => {
  console.log('');
  console.log(chalk.yellowBright(`  ${TOKEN_SECRET_NOTICE}`));
  // The secret is untrusted API output like every other field printToken
  // handles, so it's sanitized too.
  console.log(chalk.bold(`  ${sanitizeForTerminal(token)}`));
};

// Shared by every "sanitize an untrusted field, or show a fixed fallback
// when it's absent" line below (expires, last used, scopes) — the same
// concern repeated three times, so it's pulled into one helper.
const sanitizedOrFallback = (
  value: string | null | undefined,
  fallback: string,
): string => (value ? sanitizeForTerminal(value) : fallback);

// Collapses a scopes array into the comma-joined string `sanitizedOrFallback`
// expects, or `null` for "no scopes" (full access) so that helper's own
// fallback handles the display text. Split out so the scopes print line
// below isn't a nested ternary.
const formatScopes = (scopes: string[] | null): string | null =>
  scopes && scopes.length > 0 ? scopes.join(', ') : null;

// Every field here comes from the untrusted API response, so each is
// stripped of control/ANSI escapes before printing (see terminal.ts). Prints
// only the unmasked `prefix` (e.g. `mp_live_ab12` — markpost stores the raw
// secret's first 12 characters, see server/utils/tokens.ts extractTokenPrefix),
// never the full secret.
const printToken = (token: Token): void => {
  console.log(chalk.bold(sanitizeForTerminal(token.name)));
  console.log(`  id:         ${sanitizeForTerminal(token.id)}`);
  console.log(`  prefix:     ${sanitizeForTerminal(token.prefix)}`);
  console.log(`  created:    ${sanitizeForTerminal(token.createdAt)}`);
  console.log(`  expires:    ${sanitizedOrFallback(token.expiresAt, 'never')}`);
  console.log(
    `  last used:  ${sanitizedOrFallback(token.lastUsedAt, 'never used')}`,
  );
  console.log(
    `  scopes:     ${sanitizedOrFallback(formatScopes(token.scopes), 'full access')}`,
  );
};

// The JSON view of a token: the Token contract fields, enumerated (not
// spread) so a malformed/hostile list response carrying a one-time `token`
// secret can never leak through this path — mirrors
// `serializeSourceForJson` in commands/sources.ts. The `Required<Token>`
// return type fails the build if a future Token field is added here without
// a deliberate decision.
const serializeTokenForJson = (token: Token): Required<Token> => ({
  id: token.id,
  name: token.name,
  prefix: token.prefix,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  scopes: token.scopes,
});

// `list` takes no flags beyond `--json` and no positionals. Parsed (rather
// than ignoring `rest` outright) so a typo like `list --jsn` or a stray
// `list foo` fails loud via parseArgs's strict mode instead of silently
// running the plain-text path with exit 0 — the same guarantee `create` and
// `revoke` already have for their own arguments.
const listTokensCommand = async (
  rest: string[],
  json: boolean,
): Promise<void> => {
  parseArgs({ args: rest, options: { json: { type: 'boolean' } } });

  const tokens = await fetchTokens();

  // JSON mode prints the array (empty included, as `[]`) with no "No tokens
  // found." line so stdout stays valid JSON for `jq`.
  if (json) {
    printJson(tokens.map(serializeTokenForJson));
    return;
  }

  if (tokens.length === 0) {
    console.log('No API tokens found.');
    return;
  }

  tokens.forEach(printToken);
};

// Only digits (with an optional leading `-`) count as a whole number. Plain
// `Number()` + `Number.isInteger()` would also accept hex (`0x10`) and
// exponent (`1e2`) forms, silently minting a token with a surprising expiry
// — this pattern rejects both.
const WHOLE_NUMBER_PATTERN = /^-?\d+$/;

// Resolves `--expires-in-days`: `undefined` when the flag was omitted
// (matches markpost's own "no expiry requested" semantics), a parsed number
// when it's a clean whole number, or `null` when it's present but malformed
// (including an empty string). markpost enforces the actual bounds (1-3650
// days, server/api/tokens/index.post.ts) — this only guards against sending
// a non-numeric value, so the range check stays in one place instead of
// being duplicated (and risking drift) on the CLI side.
const resolveExpiresInDays = (
  raw: string | undefined,
): number | null | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  return WHOLE_NUMBER_PATTERN.test(raw.trim()) ? Number(raw) : null;
};

const createTokenCommand = async (rest: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      'expires-in-days': { type: 'string' },
    },
  });

  if (!values.name) {
    failWithUsage('`tokens create` requires --name <name>.', USAGE);
    return;
  }

  const expiresInDays = resolveExpiresInDays(values['expires-in-days']);

  if (expiresInDays === null) {
    failWithUsage(
      `--expires-in-days must be a whole number, got \`${values['expires-in-days']}\`.`,
      USAGE,
    );
    return;
  }

  const input: CreateTokenInput = { name: values.name, expiresInDays };
  const created = await createToken(input);

  if (!created) {
    // A token may still have been minted server-side with its one-time
    // secret in the response the CLI just discarded; that secret is now
    // unrecoverable, so point at how to recover deliberately rather than
    // letting a blind retry orphan a token. `failWithMessage` (not a bare
    // console.error) so a scripted `tokens create ... || alert` catches the
    // failure via a non-zero exit instead of reading it as success.
    failWithMessage(
      'Failed to create token. Run `markpost tokens list` to check whether it was created anyway — if it was, its one-time secret is unrecoverable, so revoke it and run `tokens create` again to mint a new one.',
    );
    return;
  }

  const { token: secret, ...tokenFields } = created;

  // The mint response's whole point is the one-time reveal (see
  // CreatedToken); a response that omits it means the token was created but
  // is now unrecoverable. Fail before printing any success line, so stdout
  // never ends on "Created ..." for an unusable token — mirrors
  // rotateSecretForSource's equivalent guard in commands/sources.ts. The id
  // is already in hand from the response, so point straight at it rather
  // than sending the user through `tokens list` to find it.
  if (!secret) {
    failWithMessage(
      `The token was created but the server did not return its secret — it is now unrecoverable. Run \`markpost tokens revoke ${sanitizeForTerminal(tokenFields.id)}\` then \`tokens create\` again to mint one you can copy.`,
    );
    return;
  }

  console.log(
    chalk.greenBright(
      `Created token "${sanitizeForTerminal(tokenFields.name)}"`,
    ),
  );
  printToken(tokenFields);
  printTokenSecret(secret);
};

// Fetch the token list and pick one out by id, or null if none matches.
// Unlike sources' equivalent, fetchTokens does NOT swallow a failed fetch into
// [] (see libs/tokens.ts), so a resolved list is complete and a non-match is
// genuine — only a thrown fetch leaves the token truly unknown, which the
// caller's `.catch` maps to `undefined`.
const lookupTokenById = async (id: string): Promise<Token | null> => {
  const tokens = await fetchTokens();
  return tokens.find((candidate) => candidate.id === id) ?? null;
};

// The token this CLI actually authenticates with is whatever `getApiToken`
// resolves — `API_TOKEN`, when exported, wins over the stored config value
// (see libs/api.ts), and `checkConfig` only ever writes the env var into
// config when the store is empty, so the two can permanently diverge. Reading
// through `getApiToken` (not `getConfigValue('apiToken')` directly) keeps this
// check aligned with the credential requests actually use. The list only ever
// carries the unmasked `prefix` (the raw secret's own first 12 characters —
// never the full secret), so the one link between an id being revoked and the
// token this CLI authenticates with is whether that secret begins with the
// token's prefix. A truthy `prefix` guard keeps an empty/malformed prefix
// (whose `startsWith('')` is always true) from falsely flagging every token
// as the configured one.
const isConfiguredToken = (token: Token): boolean => {
  const configured = getApiToken();
  return Boolean(
    configured && token.prefix && configured.startsWith(token.prefix),
  );
};

// The lookup is purely to name the token in the prompt and to spot the
// configured-token case, so it's best-effort: a thrown fetch (`undefined`)
// falls back to the bare id rather than blocking a revoke that would
// otherwise succeed. The three outcomes stay distinct so a failed load is
// never mis-reported as a confirmed non-match.
const LOOKUP_FAILED_NOTE = 'token name unavailable — could not load the list';
const NO_MATCH_NOTE = 'no matching token found';

type RevokeConfirmation = {
  label: string;
  isConfigured: boolean;
};

const revokeConfirmationDetails = async (
  id: string,
): Promise<RevokeConfirmation> => {
  const token = await lookupTokenById(id).catch(() => undefined);

  if (token === undefined) {
    return { label: `${id} (${LOOKUP_FAILED_NOTE})`, isConfigured: false };
  }

  if (token === null) {
    return { label: `${id} (${NO_MATCH_NOTE})`, isConfigured: false };
  }

  return {
    label: `${token.name} (${id})`,
    isConfigured: isConfiguredToken(token),
  };
};

// Revoking a token is irreversible: a revoked token stops authenticating
// immediately and cannot be un-revoked. The label is sanitized because the
// token name may have come from an untrusted API response. Defaults to "no"
// so a bare Enter cancels rather than revokes. Isolated here so the revoke
// flow stays unit-testable by mocking the prompt — mirrors `confirmDeletion`
// in commands/sources.ts.
const CONFIGURED_TOKEN_WARNING =
  'WARNING: this is the token this CLI is currently configured with — revoking it will lock this CLI out until you set a new one, either by exporting API_TOKEN or with `markpost config set apiToken <token>`.';

const confirmRevocation = async (
  label: string,
  isConfigured: boolean,
): Promise<boolean> => {
  const configuredWarning = isConfigured ? ` ${CONFIGURED_TOKEN_WARNING}` : '';

  return confirm({
    message: `Revoke token ${sanitizeForTerminal(
      label,
    )}? This cannot be undone — the token stops authenticating immediately.${configuredWarning}`,
    default: false,
  });
};

// Compose the label/configured lookup with the prompt into one named step so
// the call site reads as a sentence; the `||` at the call site is what
// short-circuits this away (lookup included) under `--yes`.
const confirmTokenRevocation = async (id: string): Promise<boolean> => {
  const { label, isConfigured } = await revokeConfirmationDetails(id);

  return confirmRevocation(label, isConfigured);
};

const revokeTokenCommand = async (
  rest: string[],
  skipConfirm: boolean,
): Promise<void> => {
  // Parsed (not a bare destructure) so an unrecognized flag like
  // `--help` fails loud via parseArgs's strict mode instead of being sent
  // as a literal token id, and a second positional is caught explicitly
  // rather than silently dropped (a script revoking two ids would
  // otherwise see only the first one actually revoked and still exit 0).
  // `--yes` is declared so it's consumed as a flag rather than mis-parsed as
  // the id; the runner already read it from argv into `skipConfirm`.
  const { positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { yes: { type: 'boolean' } },
  });
  const [id, ...extraPositionals] = positionals;

  if (!id || extraPositionals.length > 0) {
    failWithUsage(
      '`tokens revoke` takes exactly one id: `markpost tokens revoke <id>`.',
      USAGE,
    );
    return;
  }

  const confirmed = skipConfirm || (await confirmTokenRevocation(id));

  if (!confirmed) {
    console.log('Revocation cancelled.');
    return;
  }

  const revoked = await revokeToken(id);

  if (!revoked) {
    // Exit non-zero so a scripted `revoke <id> || notify` catches a failed
    // revoke instead of reading it as done.
    failWithMessage('Failed to revoke token.');
    return;
  }

  console.log(chalk.greenBright(`Revoked token ${sanitizeForTerminal(id)}.`));
};

// Membership check and handler come from the same Map, so a valid subcommand
// always has a handler — mirrors settings.ts/sources.ts. A Map (not an
// object) keeps a subcommand named "toString" from resolving to a prototype
// member. Every handler takes the same `(rest, json, skipConfirm)` shape even
// though only `list` reads `json` and only `revoke` reads `skipConfirm`, so
// dispatch below is a single call with no per-subcommand branch.
const TOKENS_HANDLERS = new Map<
  string,
  (rest: string[], json: boolean, skipConfirm: boolean) => Promise<void>
>([
  [LIST_SUBCOMMAND, (rest, json) => listTokensCommand(rest, json)],
  [CREATE_SUBCOMMAND, (rest) => createTokenCommand(rest)],
  [
    REVOKE_SUBCOMMAND,
    (rest, _json, skipConfirm) => revokeTokenCommand(rest, skipConfirm),
  ],
]);

// Whether `rest` (the args after the subcommand) carries a positional at
// all — used only to reject `tokens revoke --yes` (no id) on usage grounds
// before the config check runs. A malformed flag isn't this helper's problem
// to diagnose: it reports "an id was given" so the guard steps aside and
// `revokeTokenCommand`'s own `parseArgs` produces the real error instead of a
// misleading "requires an id" message.
const revokeIdGiven = (rest: string[]): boolean => {
  try {
    const { positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { yes: { type: 'boolean' } },
    });
    return positionals.length > 0;
  } catch {
    return true;
  }
};

// The invocation-level usage checks that all fail the same way (one usage
// message, non-zero exit). Returns the message to show, or null when the
// invocation is valid. Kept in one place so their ordering is a single unit
// rather than separate guard blocks in the runner — mirrors `usageErrorFor`
// in commands/sources.ts.
const usageErrorFor = (
  subcommand: string,
  rest: string[],
  json: boolean,
  skipConfirm: boolean,
  isInteractive: boolean,
): string | null => {
  // Only `list` renders JSON; reject it elsewhere rather than silently
  // ignoring it — `tokens create --json` would otherwise "succeed" with human
  // text on stdout, losing the one-time secret it was trying to capture.
  if (json && subcommand !== LIST_SUBCOMMAND) {
    return `--json is only supported by \`tokens ${LIST_SUBCOMMAND}\`.`;
  }

  // --yes only skips the revoke confirmation; reject it elsewhere so a
  // misplaced flag fails loudly instead of appearing to take effect.
  if (skipConfirm && subcommand !== REVOKE_SUBCOMMAND) {
    return `--yes is only supported by \`tokens ${REVOKE_SUBCOMMAND}\`.`;
  }

  // --yes promises a non-interactive revoke, so it needs an explicit id —
  // without this, `tokens revoke --yes` clears every guard below and reaches
  // the config check, which can block on an interactive prompt of its own on
  // a non-interactive terminal. Mirrors `sources delete`'s equivalent guard.
  if (skipConfirm && subcommand === REVOKE_SUBCOMMAND && !revokeIdGiven(rest)) {
    return `--yes requires an id: \`markpost tokens ${REVOKE_SUBCOMMAND} <id> --yes\`.`;
  }

  // Without --yes, revoke prompts; inquirer needs both stdin and stdout to be
  // a TTY, so a redirected/non-interactive run would otherwise hang. Refuse
  // instead, pointing at the --yes escape hatch — mirrors `sources delete`.
  if (subcommand === REVOKE_SUBCOMMAND && !skipConfirm && !isInteractive) {
    return `\`tokens ${REVOKE_SUBCOMMAND}\` needs an interactive terminal to confirm; pass an id with --yes (\`markpost tokens ${REVOKE_SUBCOMMAND} <id> --yes\`) to revoke without a prompt.`;
  }

  return null;
};

export const runTokensCommand = async (args: string[]): Promise<void> => {
  // Read `--json` and `--yes` straight from argv so every failure below is
  // rendered in whichever contract the caller asked for, even one thrown
  // before parsing, and so the guards can reject a misplaced flag first.
  const json = hasJsonFlag(args);
  const skipConfirm = hasYesFlag(args);
  const [subcommand, ...rest] = args;
  const handler = TOKENS_HANDLERS.get(subcommand);

  // Validate before the config check so a bad subcommand fails on usage
  // alone, without needing a configured account.
  if (!handler) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  const usageError = usageErrorFor(
    subcommand,
    rest,
    json,
    skipConfirm,
    isInteractiveTerminal(),
  );

  if (usageError) {
    failWithUsage(usageError, USAGE, json);
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await handler(rest, json, skipConfirm);
  } catch (error) {
    // A deliberate Ctrl+C at the revoke prompt throws @inquirer's
    // `ExitPromptError`; that's a user abort, not a command failure, so don't
    // flag it non-zero — mirrors commands/sources.ts.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    // Sanitize — an error surfaced from a tokens API call can be
    // server-derived and carry a terminal escape.
    failWithMessage(sanitizeForTerminal(String(error)), json);
  }
};
