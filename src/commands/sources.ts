import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';
import {
  createSource,
  deleteSource,
  fetchSources,
  updateSource,
} from '@/libs/sources.js';
import { checkConfig } from '@/libs/config.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage } from '@/libs/usage.js';
import { printJson } from '@/libs/output.js';
import { Source, SOURCE_TYPES, SourceType } from '@/types/sources.types.js';

// Mirror the endpoint constants markpost's web app uses in
// app/composables/useSources.ts so the CLI shows the same URL a user would
// see there.
const WEBHOOK_INGEST_BASE = 'https://ingest.markpost.io/v1/hooks';
const EMAIL_DOMAIN = 'in.markpost.io';

export const USAGE = `Usage: markpost sources <list|create|update|delete> [uuid]

  list           List all sources (pass --json for machine-readable output)
  create         Create a new source (prompts for details)
  update [uuid]  Update a source's route folder; prompts to pick one if uuid is omitted
  delete [uuid]  Delete a source; prompts to pick one if uuid is omitted`;

export const buildEndpointUrl = (
  sourceType: SourceType,
  endpointSlug: string,
): string => {
  if (sourceType === 'email') {
    return `${endpointSlug}@${EMAIL_DOMAIN}`;
  }

  return `${WEBHOOK_INGEST_BASE}/${endpointSlug}`;
};

// Membership check and handler come from the same Map, so a subcommand can
// never pass the guard without a handler (which would otherwise risk falling
// through to the destructive delete). A Map (not an object) keeps a subcommand
// named "toString" from resolving to a prototype member.
const SOURCES_HANDLERS = new Map<
  string,
  (uuid: string | undefined, json: boolean) => Promise<void>
>([
  ['list', (_uuid, json) => listSources(json)],
  ['create', () => createSourceCommand()],
  ['update', (uuid) => updateSourceCommand(uuid)],
  ['delete', (uuid) => deleteSourceCommand(uuid)],
]);

export const runSourcesCommand = async (args: string[]): Promise<void> => {
  try {
    // `parseArgs` keeps --json out of the uuid slot (so `sources delete --json`
    // still prompts rather than trying to delete a source named "--json") and
    // rejects an unknown/mistyped flag, matching how `get` and `records list`
    // parse. Only `list` reads json; the other handlers ignore the argument.
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
      },
    });
    const [subcommand, uuid] = positionals;
    const handler = SOURCES_HANDLERS.get(subcommand);

    // Validate before the config check so a bad subcommand fails on usage
    // alone, without needing a configured account.
    if (!handler) {
      failWithSubcommandUsage(subcommand, USAGE);
      return;
    }

    await checkConfig();
    await handler(uuid, values.json ?? false);
  } catch (error) {
    // A deliberate Ctrl+C at a prompt throws @inquirer's `ExitPromptError`;
    // that's a user abort, not a command failure, so don't flag it non-zero.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    console.error(chalk.redBright(error));
    process.exitCode = 1;
  }
};

const PROVIDER_SECRET_NOTICE =
  'Signing secret (shown once — copy it now, it cannot be retrieved later):';

// markpost reveals the generated signing secret exactly once — in the create
// response for a secret-backed provider (github/zapier/shortcuts). It is null
// everywhere else, so this only surfaces a non-empty value, and only from
// `create` (never list/update, which is why it lives outside `printSource`).
const printProviderSecret = (
  providerSecret: string | null | undefined,
): void => {
  if (!providerSecret) {
    return;
  }

  console.log('');
  console.log(chalk.yellowBright(`  ${PROVIDER_SECRET_NOTICE}`));
  // The secret is untrusted API output like every other field printSource
  // handles, so it's sanitized too — lossless for a real signing secret, which
  // never carries control bytes, but it stops a hostile response overwriting
  // the "copy it now" warning above with a CSI payload.
  console.log(chalk.bold(`  ${sanitizeForTerminal(providerSecret)}`));
};

// Every field here comes from the untrusted API response, so each is stripped
// of control/ANSI escapes before printing (see terminal.ts): name, uuid, type,
// endpoint (built from endpointSlug), routeFolder, recordCount, and lastHitAt.
// recordCount is typed as a number but the type is only a compile-time claim
// over parsed JSON — a hostile server could return a string carrying an escape,
// so it goes through the sanitizer too (which coerces non-strings). The
// 'never hit' fallback is a local literal, so only the untrusted lastHitAt
// branch is sanitized.
const printSource = (source: Source): void => {
  console.log(chalk.bold(sanitizeForTerminal(source.name)));
  console.log(`  uuid:      ${sanitizeForTerminal(source.uuid)}`);
  console.log(`  type:      ${sanitizeForTerminal(source.type)}`);
  console.log(
    `  endpoint:  ${sanitizeForTerminal(
      buildEndpointUrl(source.type, source.endpointSlug),
    )}`,
  );
  console.log(`  folder:    ${sanitizeForTerminal(source.routeFolder)}`);
  console.log(`  records:   ${sanitizeForTerminal(source.recordCount)}`);
  console.log(
    `  last hit:  ${source.lastHitAt ? sanitizeForTerminal(source.lastHitAt) : 'never hit'}`,
  );
};

// The JSON view of a source: the Source contract fields plus the computed
// `endpoint` so consumers get the same ingest URL the pretty output shows
// without re-deriving it. Fields are enumerated (not spread) on purpose — a
// spread would carry a `providerSecret` if a malformed/hostile list response
// ever attached one, and list must never surface that one-time secret (only
// `create` does). This whitelist is what keeps the JSON path as safe as the
// pretty printer, which likewise names each field it prints. The record JSON
// paths (`get`, `records list`) intentionally pass the whole record through
// instead: a record carries no secret sibling field, and a faithful passthrough
// keeps new server fields visible rather than silently dropping them. The
// `Source & { endpoint: string }` return type makes a future Source field fail
// the build here until it is deliberately included or excluded.
const serializeSourceForJson = (
  source: Source,
): Source & { endpoint: string } => ({
  uuid: source.uuid,
  createdAt: source.createdAt,
  type: source.type,
  name: source.name,
  provider: source.provider,
  endpointSlug: source.endpointSlug,
  endpoint: buildEndpointUrl(source.type, source.endpointSlug),
  routeFolder: source.routeFolder,
  lastHitAt: source.lastHitAt,
  recordCount: source.recordCount,
});

const listSources = async (json: boolean): Promise<void> => {
  const sources = await fetchSources();

  // JSON mode prints the array (empty included, as `[]`) with no "No sources
  // found." line so the stdout stays valid JSON for `jq`.
  if (json) {
    printJson(sources.map(serializeSourceForJson));
    return;
  }

  if (sources.length === 0) {
    console.log('No sources found.');
    return;
  }

  sources.forEach(printSource);
};

const createSourceCommand = async (): Promise<void> => {
  const type = await select({
    message: 'Source type',
    choices: SOURCE_TYPES.map((sourceType) => ({ value: sourceType })),
  });
  const name = await input({ message: 'Source name' });
  const routeFolder = await input({
    message: 'Route folder (e.g. 99-incoming/)',
  });
  const provider = await input({
    message: 'Provider (optional)',
    default: '',
  });

  const created = await createSource({
    type,
    name,
    routeFolder,
    provider: provider || undefined,
  });

  if (!created) {
    // A secret-backed source may still have been created server-side with its
    // one-time secret in the response the CLI just discarded; that secret is
    // now unrecoverable, so point the user at how to recover deliberately
    // rather than letting a blind retry orphan a source.
    console.error(
      chalk.redBright(
        'Failed to create source. Run `markpost sources list` to check whether it was created anyway — if it was, its one-time signing secret is unrecoverable, so delete and recreate the source to mint a new one.',
      ),
    );
    return;
  }

  // Peel the one-time secret off before handing the rest to the shared
  // `printSource`, so the secret physically isn't on the object any list/update
  // printer ever receives.
  const { providerSecret, ...source } = created;

  console.log(
    chalk.greenBright(`Created source "${sanitizeForTerminal(source.name)}"`),
  );
  printSource(source);
  printProviderSecret(providerSecret);
};

// Shared by update and delete: list existing sources and let the user pick
// one, or report there's nothing to act on.
const promptForSource = async (action: string): Promise<Source | null> => {
  const sources = await fetchSources();

  if (sources.length === 0) {
    console.log(`No sources to ${action}.`);
    return null;
  }

  const selectedUuid = await select({
    message: `Select a source to ${action}`,
    choices: sources.map((source) => ({
      name: sanitizeForTerminal(`${source.name} (${source.type})`),
      value: source.uuid,
    })),
  });

  return sources.find((source) => source.uuid === selectedUuid) ?? null;
};

const findSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const sources = await fetchSources();
  const source = sources.find((candidate) => candidate.uuid === uuid);

  if (source) {
    return source;
  }

  // fetchSources() swallows transport errors (except a timeout, which
  // propagates) and returns [], so a uuid that doesn't match is
  // indistinguishable here from a failed lookup.
  console.error(
    chalk.redBright(
      'Source not found, or the source list could not be loaded.',
    ),
  );

  return null;
};

const promptAndApplyRouteFolder = async (target: Source): Promise<void> => {
  const routeFolder = (
    await input({
      message: 'Route folder (e.g. 99-incoming/)',
      default: target.routeFolder,
    })
  ).trim();

  if (!routeFolder) {
    console.error(chalk.redBright('Route folder cannot be empty.'));
    return;
  }

  if (routeFolder === target.routeFolder) {
    console.log('Route folder unchanged.');
    return;
  }

  const source = await updateSource(target.uuid, { routeFolder });

  if (!source) {
    console.error(chalk.redBright('Failed to update source.'));
    return;
  }

  console.log(
    chalk.greenBright(`Updated source "${sanitizeForTerminal(source.name)}"`),
  );
  printSource(source);
};

const updateSourceCommand = async (uuid?: string): Promise<void> => {
  const target = uuid
    ? await findSourceByUuid(uuid)
    : await promptForSource('update');

  if (!target) {
    return;
  }

  await promptAndApplyRouteFolder(target);
};

const deleteSourceCommand = async (uuid?: string): Promise<void> => {
  const targetUuid = uuid ?? (await promptForSource('delete'))?.uuid;

  if (!targetUuid) {
    return;
  }

  const meta = await deleteSource(targetUuid);

  if (!meta) {
    console.error(chalk.redBright('Failed to delete source.'));
    return;
  }

  console.log(chalk.greenBright(`Deleted ${meta.deleted} source(s).`));
};
