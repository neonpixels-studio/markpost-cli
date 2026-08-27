import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { confirm, input, select } from '@inquirer/prompts';
import {
  createSource,
  deleteSource,
  fetchSources,
  updateSource,
} from '@/libs/sources.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage } from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage, failWithUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
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
  delete [uuid]  Delete a source; prompts to pick one if uuid is omitted. Asks to confirm first; pass a uuid with --yes to skip the prompt (for scripts)`;

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
// Only `list` renders JSON; the other subcommands are interactive or emit a
// one-off result, so --json means nothing to them.
const LIST_SUBCOMMAND = 'list';
// `delete` is the only subcommand `--yes` applies to, so it's named for the
// guard that rejects the flag elsewhere as well as its handler-map key.
const DELETE_SUBCOMMAND = 'delete';

const SOURCES_HANDLERS = new Map<
  string,
  (
    uuid: string | undefined,
    json: boolean,
    skipConfirm: boolean,
  ) => Promise<void>
>([
  [LIST_SUBCOMMAND, (_uuid, json) => listSources(json)],
  ['create', () => createSourceCommand()],
  ['update', (uuid) => updateSourceCommand(uuid)],
  [
    DELETE_SUBCOMMAND,
    (uuid, _json, skipConfirm) => deleteSourceCommand(uuid, skipConfirm),
  ],
]);

// The invocation-level usage checks that all fail the same way (one usage
// message, non-zero exit). Returns the message to show, or null when the
// invocation is valid. Kept in one place so their ordering is a single unit
// rather than four near-identical guard blocks in the runner.
const usageErrorFor = (
  subcommand: string,
  uuid: string | undefined,
  json: boolean,
  skipConfirm: boolean,
  isInteractive: boolean,
): string | null => {
  // Reject --json where it does nothing rather than silently ignoring it:
  // `sources create --json | jq` would otherwise "succeed" with human text on
  // stdout, losing the one-time signing secret it was trying to capture.
  if (json && subcommand !== LIST_SUBCOMMAND) {
    return `--json is only supported by \`sources ${LIST_SUBCOMMAND}\`.`;
  }

  // --yes only skips the delete confirmation; reject it elsewhere so a
  // misplaced flag fails loudly instead of appearing to take effect.
  if (skipConfirm && subcommand !== DELETE_SUBCOMMAND) {
    return `--yes is only supported by \`sources ${DELETE_SUBCOMMAND}\`.`;
  }

  // --yes promises a non-interactive delete, so it needs an explicit uuid —
  // without one the picker still opens and a script blocks on it forever.
  if (skipConfirm && !uuid) {
    return `--yes requires a uuid: \`markpost sources ${DELETE_SUBCOMMAND} <uuid> --yes\`.`;
  }

  // The confirmation prompt can't be answered without an interactive terminal:
  // inquirer renders to stdout and reads stdin, and its EOF abort is swallowed
  // as a Ctrl+C below — so a redirected/non-interactive `sources delete` would
  // hang or delete nothing yet still exit 0. Fail loud and point scripts at
  // --yes. Only delete is guarded here because it's the irreversible one;
  // `create`/`update` also prompt, but that predates this change and their
  // non-TTY behavior is out of scope for the delete-confirmation work.
  if (subcommand === DELETE_SUBCOMMAND && !skipConfirm && !isInteractive) {
    return '`sources delete` needs an interactive terminal to confirm; pass --yes to delete without a prompt.';
  }

  return null;
};

export const runSourcesCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);

  try {
    // `parseArgs` keeps --json out of the uuid slot (so `sources delete --json`
    // still prompts rather than trying to delete a source named "--json") and
    // rejects an unknown/mistyped flag. Only `list` reads json.
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        yes: { type: 'boolean' },
      },
    });
    const [subcommand, uuid] = positionals;
    const skipConfirm = Boolean(values.yes);
    const handler = SOURCES_HANDLERS.get(subcommand);

    // Validate before the config check so a bad subcommand fails on usage
    // alone, without needing a configured account. The bad-subcommand case
    // fails differently (it prints the subcommand), so it stays here; the rest
    // share one usage-error shape and live in `usageErrorFor`.
    if (!handler) {
      failWithSubcommandUsage(subcommand, USAGE, json);
      return;
    }

    // A prompt needs both streams to be a terminal: inquirer reads stdin and
    // renders to stdout, so a redirect on either makes the confirmation
    // unanswerable.
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const usageError = usageErrorFor(
      subcommand,
      uuid,
      json,
      skipConfirm,
      isInteractive,
    );

    if (usageError) {
      failWithUsage(usageError, USAGE, json);
      return;
    }

    if (!(await checkConfig(json))) {
      return;
    }

    await handler(uuid, json, skipConfirm);
  } catch (error) {
    // A deliberate Ctrl+C at a prompt throws @inquirer's `ExitPromptError`;
    // that's a user abort, not a command failure, so don't flag it non-zero.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    // Sanitize — an error surfaced from a sources API call can be
    // server-derived and carry a terminal escape.
    failWithMessage(sanitizeForTerminal(String(error)), json);
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
// `Required<Source> & { endpoint: string }` return type makes a future Source
// field — required or optional — fail the build here until it is deliberately
// included or excluded.
const serializeSourceForJson = (
  source: Source,
): Required<Source> & { endpoint: string } => ({
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

// Fetch the source list and pick one out by uuid, or null if none matches.
// fetchSources() swallows transport errors (except a timeout, which
// propagates) into [], so a missing uuid is indistinguishable here from a
// failed load. Shared by the reporting `findSourceByUuid` and the best-effort
// delete label so the fetch+find isn't written three ways.
const lookupSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const sources = await fetchSources();
  return sources.find((candidate) => candidate.uuid === uuid) ?? null;
};

const findSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const source = await lookupSourceByUuid(uuid);

  if (source) {
    return source;
  }

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

// Deleting a source is irreversible: it drops the ingest config and the
// one-time signing secret, which can never be retrieved again. The label is
// sanitized because it may have come from an untrusted API response via the
// interactive picker. Defaults to "no" so a bare Enter cancels rather than
// deletes. Isolated here so the delete flow stays unit-testable by mocking the
// prompt.
const confirmDeletion = async (label: string): Promise<boolean> =>
  confirm({
    message: `Delete source ${sanitizeForTerminal(
      label,
    )}? This drops its ingest config and one-time signing secret and cannot be undone.`,
    default: false,
  });

const NO_SOURCE_FOUND_NOTE = 'no source found with this uuid';

// Build the confirmation label. The interactive pick already carries the
// Source; a bare-uuid delete looks the source up so the prompt names it —
// surfacing a wrong-but-valid (or non-existent) copy-pasted uuid before it
// destroys anything, rather than echoing back the exact string the user typed.
// The lookup is purely cosmetic, so it's best-effort: any failure (including a
// timeout, which fetchSources re-throws) falls back to the bare uuid rather
// than blocking a delete that would otherwise succeed. A miss is called out in
// the label so it isn't mistaken for a successful match.
const deleteConfirmationLabel = async (
  picked: Source | null | undefined,
  targetUuid: string,
): Promise<string> => {
  if (picked) {
    return `${picked.name} (${targetUuid})`;
  }

  const source = await lookupSourceByUuid(targetUuid).catch(() => null);

  return source
    ? `${source.name} (${targetUuid})`
    : `${targetUuid} (${NO_SOURCE_FOUND_NOTE})`;
};

// Build the label, then prompt. Kept separate from the runner so the `--yes`
// short-circuit skips the label lookup (and its fetch) entirely.
const confirmSourceDeletion = async (
  picked: Source | null | undefined,
  targetUuid: string,
): Promise<boolean> =>
  confirmDeletion(await deleteConfirmationLabel(picked, targetUuid));

const deleteSourceCommand = async (
  uuid: string | undefined,
  skipConfirm: boolean,
): Promise<void> => {
  const picked = uuid ? undefined : await promptForSource('delete');
  const targetUuid = uuid ?? picked?.uuid;

  if (!targetUuid) {
    return;
  }

  const confirmed =
    skipConfirm || (await confirmSourceDeletion(picked, targetUuid));

  if (!confirmed) {
    console.log('Deletion cancelled.');
    return;
  }

  const meta = await deleteSource(targetUuid);

  if (!meta) {
    console.error(chalk.redBright('Failed to delete source.'));
    return;
  }

  console.log(chalk.greenBright(`Deleted ${meta.deleted} source(s).`));
};
