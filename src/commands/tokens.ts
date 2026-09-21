import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { createToken, fetchTokens, revokeToken } from '@/libs/tokens.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage } from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage, failWithUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import { CreateTokenInput, Token } from '@/types/tokens.types.js';

export const USAGE = `Usage: markpost tokens <list|create|revoke> [id]

  list                                             List all API tokens (pass --json for machine-readable output)
  create --name <name> [--expires-in-days <days>]  Mint a new API token; the raw secret is shown once and cannot be retrieved again
  revoke <id>                                      Revoke an API token by id`;

const LIST_SUBCOMMAND = 'list';
const CREATE_SUBCOMMAND = 'create';
const REVOKE_SUBCOMMAND = 'revoke';

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

// Every field here comes from the untrusted API response, so each is
// stripped of control/ANSI escapes before printing (see terminal.ts). Prints
// the masked `prefix` (e.g. `mp_live_ab12`), never a full secret — the
// prefix-masked shape markpost's own listing UI uses.
const printToken = (token: Token): void => {
  console.log(chalk.bold(sanitizeForTerminal(token.name)));
  console.log(`  id:         ${sanitizeForTerminal(token.id)}`);
  console.log(`  prefix:     ${sanitizeForTerminal(token.prefix)}`);
  console.log(`  created:    ${sanitizeForTerminal(token.createdAt)}`);
  console.log(
    `  expires:    ${token.expiresAt ? sanitizeForTerminal(token.expiresAt) : 'never'}`,
  );
  console.log(
    `  last used:  ${token.lastUsedAt ? sanitizeForTerminal(token.lastUsedAt) : 'never used'}`,
  );
  console.log(
    `  scopes:     ${
      token.scopes && token.scopes.length > 0
        ? sanitizeForTerminal(token.scopes.join(', '))
        : 'full access'
    }`,
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

const listTokens = async (json: boolean): Promise<void> => {
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

// Parses `--expires-in-days`: `null` for anything that isn't a clean whole
// number, including an empty string. markpost enforces the actual bounds
// (1-3650 days, server/api/tokens/index.post.ts) — this only guards against
// sending a non-numeric value, so the range check stays in one place instead
// of being duplicated (and risking drift) on the CLI side.
const parseExpiresInDays = (raw: string): number | null => {
  if (raw.trim() === '') {
    return null;
  }

  const parsed = Number(raw);

  return Number.isInteger(parsed) ? parsed : null;
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

  let expiresInDays: number | undefined;

  if (values['expires-in-days'] !== undefined) {
    const parsed = parseExpiresInDays(values['expires-in-days']);

    if (parsed === null) {
      failWithUsage(
        `--expires-in-days must be a whole number, got \`${values['expires-in-days']}\`.`,
        USAGE,
      );
      return;
    }

    expiresInDays = parsed;
  }

  const input: CreateTokenInput = { name: values.name, expiresInDays };
  const created = await createToken(input);

  if (!created) {
    // A token may still have been minted server-side with its one-time
    // secret in the response the CLI just discarded; that secret is now
    // unrecoverable, so point at how to recover deliberately rather than
    // letting a blind retry orphan a token. Mirrors createSourceCommand's
    // equivalent failure message in commands/sources.ts.
    console.error(
      chalk.redBright(
        'Failed to create token. Run `markpost tokens list` to check whether it was created anyway — if it was, its one-time secret is unrecoverable, so revoke it and run `tokens create` again to mint a new one.',
      ),
    );
    return;
  }

  const { token: secret, ...tokenFields } = created;

  // The mint response's whole point is the one-time reveal (see
  // CreatedToken); a response that omits it means the token was created but
  // is now unrecoverable. Fail before printing any success line, so stdout
  // never ends on "Created ..." for an unusable token — mirrors
  // rotateSecretForSource's equivalent guard in commands/sources.ts.
  if (!secret) {
    failWithMessage(
      'The token was created but the server did not return its secret — it is now unrecoverable. Run `markpost tokens revoke <id>` then `tokens create` again to mint one you can copy.',
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

const revokeTokenCommand = async (rest: string[]): Promise<void> => {
  const [id] = rest;

  if (!id) {
    failWithUsage(
      '`tokens revoke` requires an id: `markpost tokens revoke <id>`.',
      USAGE,
    );
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
// member. Every handler takes the same `(rest, json)` shape even though only
// `list` reads `json`, so dispatch below is a single call with no
// per-subcommand branch.
const TOKENS_HANDLERS = new Map<
  string,
  (rest: string[], json: boolean) => Promise<void>
>([
  [LIST_SUBCOMMAND, (_rest, json) => listTokens(json)],
  [CREATE_SUBCOMMAND, (rest) => createTokenCommand(rest)],
  [REVOKE_SUBCOMMAND, (rest) => revokeTokenCommand(rest)],
]);

export const runTokensCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);
  const [subcommand, ...rest] = args;
  const handler = TOKENS_HANDLERS.get(subcommand);

  // Validate before the config check so a bad subcommand fails on usage
  // alone, without needing a configured account.
  if (!handler) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  // Only `list` renders JSON; reject it elsewhere rather than silently
  // ignoring it — `tokens create --json` would otherwise "succeed" with
  // human text on stdout, losing the one-time secret it was trying to
  // capture (mirrors the same guard on `sources create`).
  if (json && subcommand !== LIST_SUBCOMMAND) {
    failWithUsage(
      `--json is only supported by \`tokens ${LIST_SUBCOMMAND}\`.`,
      USAGE,
      json,
    );
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await handler(rest, json);
  } catch (error) {
    // Sanitize — an error surfaced from a tokens API call can be
    // server-derived and carry a terminal escape.
    failWithMessage(sanitizeForTerminal(String(error)), json);
  }
};
