import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatedSource, Source } from '@/types/sources.types.js';

vi.mock('@/libs/config.js', () => ({
  checkConfig: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/libs/sources.js', () => ({
  fetchSources: vi.fn(),
  createSource: vi.fn(),
  updateSource: vi.fn(),
  deleteSource: vi.fn(),
  rotateSourceSecret: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
    yellowBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const webhookSource: Source = {
  uuid: 'abc-123',
  createdAt: '2024-01-01T00:00:00Z',
  type: 'webhook',
  name: 'Webhook Source',
  provider: null,
  endpointSlug: 'wh_abc12345',
  routeFolder: '99-incoming/',
  lastHitAt: null,
  recordCount: 3,
};

const emailSource: Source = {
  uuid: 'def-456',
  createdAt: '2024-01-02T00:00:00Z',
  type: 'email',
  name: 'Email Source',
  provider: null,
  endpointSlug: 'clip-ab12',
  routeFolder: '98-incoming/',
  lastHitAt: '2024-02-01T00:00:00Z',
  recordCount: 1,
};

// A secret-backed provider (github/zapier/shortcuts): markpost's create
// response reveals the one-time plaintext `providerSecret` here and nowhere
// else.
const githubSource: CreatedSource = {
  uuid: 'ghi-789',
  createdAt: '2024-01-03T00:00:00Z',
  type: 'github',
  name: 'GitHub Source',
  provider: 'github',
  providerSecret: 'whsec_one_time_plaintext',
  endpointSlug: 'gh_789xyz',
  routeFolder: '97-incoming/',
  lastHitAt: null,
  recordCount: 0,
};

// A manual-secret provider (stripe): markpost issues the secret, so rotation
// prompts the user to paste the new value and the response reveals nothing.
const stripeSource: Source = {
  uuid: 'str-123',
  createdAt: '2024-01-04T00:00:00Z',
  type: 'stripe',
  name: 'Stripe Source',
  provider: 'stripe',
  endpointSlug: 'st_123abc',
  routeFolder: '96-incoming/',
  lastHitAt: null,
  recordCount: 0,
};

// Collapses every argument of every console.log AND console.error call into
// one searchable string, so a leak assertion can't be dodged by the secret
// landing in a second argument, a later call, or the other stream.
const loggedText = (): string =>
  [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((value) => String(value))
    .join('\n');

describe('buildEndpointUrl', () => {
  it('builds a webhook ingest URL for non-email source types', async () => {
    const { buildEndpointUrl } = await import('@/commands/sources.js');
    expect(buildEndpointUrl('webhook', 'wh_abc12345')).toBe(
      'https://ingest.markpost.io/v1/hooks/wh_abc12345',
    );
  });

  it('builds an email-in address for email source types', async () => {
    const { buildEndpointUrl } = await import('@/commands/sources.js');
    expect(buildEndpointUrl('email', 'clip-ab12')).toBe(
      'clip-ab12@in.markpost.io',
    );
  });
});

describe('runSourcesCommand', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('always checks config before dispatching', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchSources } = await import('@/libs/sources.js');
    vi.mocked(fetchSources).mockResolvedValue([]);
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(checkConfig).toHaveBeenCalledWith(false);
  });

  it('errors to stderr and exits 1 when no subcommand is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No subcommand given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost sources'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 for an unknown subcommand', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['bogus']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand: bogus'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost sources'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A propagated failure (e.g. a request timeout, which the sources lib now
  // re-throws) must exit non-zero like every other command, not print red
  // text and exit 0.
  it('exits non-zero when a sources call throws', async () => {
    const { fetchSources } = await import('@/libs/sources.js');
    vi.mocked(fetchSources).mockRejectedValue(new Error('boom'));
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(process.exitCode).toBe(1);
  });

  // A Ctrl+C at a prompt throws @inquirer's `ExitPromptError` — a deliberate
  // user abort, not a failure. It must exit 0 (exitCode left unset) and print
  // nothing, so the swallow branch can't silently convert a real failure that
  // happens to share the name into a clean exit without a test noticing.
  it('exits zero and stays quiet when a prompt is aborted with Ctrl+C', async () => {
    const { fetchSources } = await import('@/libs/sources.js');
    const exitPromptError = Object.assign(new Error('User force closed'), {
      name: 'ExitPromptError',
    });
    vi.mocked(fetchSources).mockRejectedValue(exitPromptError);
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  describe('list', () => {
    it('prints "No sources found." when there are none', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      expect(console.log).toHaveBeenCalledWith('No sources found.');
    });

    it('prints each source, including its computed endpoint URL', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource, emailSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://ingest.markpost.io/v1/hooks/wh_abc12345',
        ),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('clip-ab12@in.markpost.io'),
      );
    });

    // The one-time secret must only ever surface from `create`; a source
    // object that somehow still carries one must not leak it on list.
    it('never prints a providerSecret carried on a listed source', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      expect(loggedText()).not.toContain('whsec_one_time_plaintext');
    });

    it('strips control characters from untrusted source fields before printing', async () => {
      // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
      const control = String.fromCharCode(0x1b);
      const evilSource: Source = {
        ...webhookSource,
        name: `Evil${control}Source`,
        endpointSlug: `wh_${control}slug`,
        routeFolder: `99${control}incoming/`,
      };
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([evilSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith('Evil Source');
      // The endpoint URL is built from the untrusted endpointSlug, and the
      // route folder is untrusted too — assert each renders sanitized so a
      // regression on either specific line is caught, not just by the scan.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('wh_ slug'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('99 incoming/'),
      );
    });

    it('sanitizes a hostile non-string recordCount from a malformed response', async () => {
      // The type says number, but the server is untrusted: a string carrying an
      // escape must still be coerced and stripped, not printed or thrown on.
      const control = String.fromCharCode(0x1b);
      const evilSource = {
        ...webhookSource,
        recordCount: `3${control}[2J` as unknown as number,
      };
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([evilSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('3 [2J'),
      );
    });

    it('prints the sources as a parseable JSON array with computed endpoints when --json is passed', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource, emailSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list', '--json']);

      // --json must reach checkConfig so it fails loud instead of prompting on
      // stdout on an unconfigured machine.
      expect(checkConfig).toHaveBeenCalledWith(true);
      // Exactly one stdout write, so a future stray console.log before the
      // payload breaks the test instead of hiding in earlier calls.
      expect(console.log).toHaveBeenCalledTimes(1);
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({
        uuid: 'abc-123',
        name: 'Webhook Source',
        endpoint: 'https://ingest.markpost.io/v1/hooks/wh_abc12345',
      });
      expect(parsed[1]).toMatchObject({
        uuid: 'def-456',
        endpoint: 'clip-ab12@in.markpost.io',
      });
    });

    it('prints an empty JSON array (not "No sources found.") for --json with no sources', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list', '--json']);

      expect(console.log).not.toHaveBeenCalledWith('No sources found.');
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toEqual([]);
    });

    // The JSON path enumerates the Source contract fields rather than spreading
    // the object, so a one-time providerSecret riding on a malformed list
    // response can never surface — same invariant the pretty path holds.
    it('never leaks a providerSecret carried on a listed source in --json mode', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list', '--json']);

      expect(loggedText()).not.toContain('whsec_one_time_plaintext');
    });

    // --json is parsed as a flag (never the uuid slot) and rejected on the
    // subcommands that don't render JSON, so `sources delete --json` neither
    // fires a DELETE for a source named "--json" nor silently ignores the flag.
    it('rejects --json on delete rather than treating it as a uuid or ignoring it', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchSources, deleteSource } = await import('@/libs/sources.js');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete', '--json']);

      expect(deleteSource).not.toHaveBeenCalled();
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchSources).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--json is only supported by `sources list`.'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A script doing `sources create --json | jq` must fail loudly, not exit 0
    // with human text — losing the one-time signing secret it meant to capture.
    it('rejects --json on create before prompting or calling the API', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { createSource } = await import('@/libs/sources.js');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create', '--json']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(createSource).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('rejects --json on update before prompting or calling the API', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', '--json']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchSources).not.toHaveBeenCalled();
      expect(updateSource).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('exits 1 on a mistyped flag instead of silently printing human text', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchSources } = await import('@/libs/sources.js');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list', '--jsonn']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchSources).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('renders "never hit" for an empty lastHitAt', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([
        { ...webhookSource, lastHitAt: '' },
      ]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('never hit'),
      );
    });
  });

  describe('create', () => {
    it('prompts for source details and creates the source', async () => {
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('webhook');
      vi.mocked(input)
        .mockResolvedValueOnce('Webhook Source')
        .mockResolvedValueOnce('99-incoming/')
        .mockResolvedValueOnce('');
      vi.mocked(createSource).mockResolvedValue(webhookSource);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      expect(createSource).toHaveBeenCalledWith({
        type: 'webhook',
        name: 'Webhook Source',
        routeFolder: '99-incoming/',
        provider: undefined,
      });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created source "Webhook Source"'),
      );
    });

    it('surfaces the one-time providerSecret once when the create response carries one', async () => {
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('github');
      vi.mocked(input)
        .mockResolvedValueOnce('GitHub Source')
        .mockResolvedValueOnce('97-incoming/')
        .mockResolvedValueOnce('github');
      vi.mocked(createSource).mockResolvedValue(githubSource);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      const secretMentions = loggedText()
        .split('\n')
        .filter((line) => line.includes('whsec_one_time_plaintext'));
      expect(secretMentions).toHaveLength(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('shown once'),
      );
    });

    it('strips control characters from a hostile providerSecret before printing', async () => {
      // The secret is untrusted API output like every other printed field, so a
      // response carrying an escape must be sanitized, not written raw over the
      // "copy it now" warning.
      const control = String.fromCharCode(0x1b);
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('github');
      vi.mocked(input)
        .mockResolvedValueOnce('GitHub Source')
        .mockResolvedValueOnce('97-incoming/')
        .mockResolvedValueOnce('github');
      vi.mocked(createSource).mockResolvedValue({
        ...githubSource,
        providerSecret: `whsec_${control}[2J`,
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('whsec_ [2J'),
      );
    });

    it('prints nothing extra when the create response has providerSecret: null', async () => {
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('webhook');
      vi.mocked(input)
        .mockResolvedValueOnce('Webhook Source')
        .mockResolvedValueOnce('99-incoming/')
        .mockResolvedValueOnce('');
      vi.mocked(createSource).mockResolvedValue({
        ...webhookSource,
        providerSecret: null,
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('shown once'),
      );
    });

    // The realistic non-secret-provider shape omits the key entirely, not
    // `null`; the `!providerSecret` guard must handle both.
    it('prints nothing extra when the create response omits providerSecret', async () => {
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('webhook');
      vi.mocked(input)
        .mockResolvedValueOnce('Webhook Source')
        .mockResolvedValueOnce('99-incoming/')
        .mockResolvedValueOnce('');
      vi.mocked(createSource).mockResolvedValue(webhookSource);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('shown once'),
      );
    });

    it('reports an error when creation fails', async () => {
      const { input, select } = await import('@inquirer/prompts');
      const { createSource } = await import('@/libs/sources.js');
      vi.mocked(select).mockResolvedValue('webhook');
      vi.mocked(input)
        .mockResolvedValueOnce('Webhook Source')
        .mockResolvedValueOnce('99-incoming/')
        .mockResolvedValueOnce('');
      vi.mocked(createSource).mockResolvedValue(null);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['create']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create source.'),
      );
    });
  });

  describe('update', () => {
    it('updates directly by uuid when one is provided', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input, select } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(input).mockResolvedValueOnce('00-fixed/');
      vi.mocked(updateSource).mockResolvedValue({
        ...webhookSource,
        routeFolder: '00-fixed/',
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'abc-123']);

      expect(select).not.toHaveBeenCalled();
      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({ default: '99-incoming/' }),
      );
      expect(updateSource).toHaveBeenCalledWith('abc-123', {
        routeFolder: '00-fixed/',
      });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Updated source "Webhook Source"'),
      );
    });

    it('prompts to pick a source when no uuid is given', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input, select } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(select).mockResolvedValue('abc-123');
      vi.mocked(input).mockResolvedValueOnce('00-fixed/');
      vi.mocked(updateSource).mockResolvedValue({
        ...webhookSource,
        routeFolder: '00-fixed/',
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update']);

      expect(updateSource).toHaveBeenCalledWith('abc-123', {
        routeFolder: '00-fixed/',
      });
    });

    it('sanitizes the source name in the interactive picker choices', async () => {
      // The select label is composed from the untrusted source name, so a name
      // carrying an escape must be stripped before it reaches the picker.
      const control = String.fromCharCode(0x1b);
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input, select } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([
        { ...webhookSource, name: `Evil${control}Source` },
      ]);
      vi.mocked(select).mockResolvedValue('abc-123');
      vi.mocked(input).mockResolvedValueOnce('00-fixed/');
      vi.mocked(updateSource).mockResolvedValue(webhookSource);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update']);

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [expect.objectContaining({ name: 'Evil Source (webhook)' })],
        }),
      );
    });

    it('reports not-found when the uuid does not match any source', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'unknown-uuid']);

      expect(updateSource).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        'Source not found, or the source list could not be loaded.',
      );
    });

    it('reports an error and does not call updateSource when the route folder is cleared', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(input).mockResolvedValueOnce('   ');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'abc-123']);

      expect(updateSource).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        'Route folder cannot be empty.',
      );
    });

    it('does not call updateSource when the prefilled value is accepted unchanged', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(input).mockResolvedValueOnce(webhookSource.routeFolder);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'abc-123']);

      expect(updateSource).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Route folder unchanged.');
    });

    it('does nothing when there are no sources to update and no uuid is given', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update']);

      expect(updateSource).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('No sources to update.');
      // Guards against re-reporting the same empty-list case as a second,
      // contradictory "not found" error.
      expect(console.error).not.toHaveBeenCalled();
    });

    it('never prints a providerSecret carried on an updated source', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      vi.mocked(input).mockResolvedValueOnce('00-fixed/');
      vi.mocked(updateSource).mockResolvedValue({
        ...githubSource,
        routeFolder: '00-fixed/',
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'ghi-789']);

      expect(loggedText()).not.toContain('whsec_one_time_plaintext');
    });

    it('reports an error when the update fails', async () => {
      const { fetchSources, updateSource } = await import('@/libs/sources.js');
      const { input } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(input).mockResolvedValueOnce('00-fixed/');
      vi.mocked(updateSource).mockResolvedValue(null);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['update', 'abc-123']);

      expect(console.error).toHaveBeenCalledWith('Failed to update source.');
    });
  });

  describe('delete', () => {
    it('deletes directly by uuid when one is provided', async () => {
      const { deleteSource } = await import('@/libs/sources.js');
      vi.mocked(deleteSource).mockResolvedValue({ deleted: 1 });
      const { select } = await import('@inquirer/prompts');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete', 'abc-123']);

      expect(deleteSource).toHaveBeenCalledWith('abc-123');
      expect(select).not.toHaveBeenCalled();
    });

    it('prompts to pick a source when no uuid is given', async () => {
      const { fetchSources, deleteSource } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      vi.mocked(deleteSource).mockResolvedValue({ deleted: 1 });
      const { select } = await import('@inquirer/prompts');
      vi.mocked(select).mockResolvedValue('abc-123');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete']);

      expect(deleteSource).toHaveBeenCalledWith('abc-123');
    });

    it('does nothing when there are no sources to pick from', async () => {
      const { fetchSources, deleteSource } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete']);

      expect(deleteSource).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('No sources to delete.');
    });

    it('reports an error when deletion fails', async () => {
      const { deleteSource } = await import('@/libs/sources.js');
      vi.mocked(deleteSource).mockResolvedValue(null);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete', 'abc-123']);

      expect(console.error).toHaveBeenCalledWith('Failed to delete source.');
    });
  });

  describe('rotate-secret', () => {
    it('rotates by uuid for a generated provider and reveals the new secret once', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...githubSource,
        providerSecret: 'whsec_rotated_value',
      });
      const { select, password } = await import('@inquirer/prompts');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'ghi-789']);

      // Generated providers send no attributes; markpost mints the secret.
      expect(rotateSourceSecret).toHaveBeenCalledWith('ghi-789', {});
      // No picker and no secret prompt for a generated provider.
      expect(select).not.toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Rotated signing secret for "GitHub Source"'),
      );
      const secretMentions = loggedText()
        .split('\n')
        .filter((line) => line.includes('whsec_rotated_value'));
      expect(secretMentions).toHaveLength(1);
    });

    it('prompts (masked) for the new secret and sends it for a manual-secret provider', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      const { password } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([stripeSource]);
      vi.mocked(password).mockResolvedValueOnce('whsec_pasted_stripe');
      // A hostile/off-contract server that echoes the pasted secret back must
      // still never have it printed — the manual-provider early return skips the
      // reveal entirely, and the secret is peeled off before printSource.
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...stripeSource,
        providerSecret: 'whsec_echoed_by_server',
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'str-123']);

      // A masked prompt keeps the pasted secret out of terminal scrollback.
      expect(password).toHaveBeenCalledWith(
        expect.objectContaining({ mask: true }),
      );
      expect(rotateSourceSecret).toHaveBeenCalledWith('str-123', {
        providerSecret: 'whsec_pasted_stripe',
      });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Rotated signing secret for "Stripe Source"'),
      );
      // Nothing to reveal for a manual provider — the user already has it — and
      // an echoed value must not surface anywhere on stdout/stderr.
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('shown once'),
      );
      expect(loggedText()).not.toContain('whsec_echoed_by_server');
    });

    it('does not raise the missing-secret alarm for a manual provider (its response has none)', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      const { password } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([stripeSource]);
      vi.mocked(password).mockResolvedValueOnce('whsec_pasted_stripe');
      // markpost never echoes a manual secret back, so the response omits it —
      // and that omission must not be treated as the "server did not return it"
      // failure that applies only to generated providers.
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...stripeSource,
        providerSecret: null,
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'str-123']);

      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('did not return it'),
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('aborts without calling the API when a manual secret is left blank', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      const { password } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([stripeSource]);
      vi.mocked(password).mockResolvedValueOnce('   ');
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'str-123']);

      expect(rotateSourceSecret).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        'Signing secret cannot be empty.',
      );
    });

    it('refuses a source with no rotatable secret and skips the API call', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([webhookSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'abc-123']);

      expect(rotateSourceSecret).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('has no rotatable secret'),
      );
    });

    it('reports not-found when the uuid does not match any source', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'unknown-uuid']);

      expect(rotateSourceSecret).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        'Source not found, or the source list could not be loaded.',
      );
    });

    it('offers only rotatable sources in the interactive picker', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      const { select } = await import('@inquirer/prompts');
      vi.mocked(fetchSources).mockResolvedValue([
        webhookSource,
        emailSource,
        githubSource,
      ]);
      vi.mocked(select).mockResolvedValue('ghi-789');
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...githubSource,
        providerSecret: 'whsec_rotated_value',
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret']);

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [
            expect.objectContaining({ value: 'ghi-789' }),
          ],
        }),
      );
      expect(rotateSourceSecret).toHaveBeenCalledWith('ghi-789', {});
    });

    it('explains rotate-secret needs a provider source when only non-rotatable sources exist', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([webhookSource, emailSource]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret']);

      expect(rotateSourceSecret).not.toHaveBeenCalled();
      // Not the bare "No sources..." line: the user has sources, just none
      // with a rotatable secret.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('None of your sources have a rotatable secret'),
      );
    });

    it('falls back to the plain empty message when there are no sources at all', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockResolvedValue([]);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret']);

      expect(console.log).toHaveBeenCalledWith(
        'No sources to rotate the secret for.',
      );
    });

    it('warns when a generated rotation succeeds but the response omits the secret', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      // Server rotated the secret (old one now dead) but returned no plaintext.
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...githubSource,
        providerSecret: null,
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'ghi-789']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('did not return it'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('reports an error when the rotation fails', async () => {
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      vi.mocked(rotateSourceSecret).mockResolvedValue(null);
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'ghi-789']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to rotate source secret.'),
      );
      // A failed rotation must exit non-zero so a wrapper never reads it as
      // success (the previous secret may already be dead).
      expect(process.exitCode).toBe(1);
    });

    it('strips control characters from a hostile rotated secret before printing', async () => {
      const control = String.fromCharCode(0x1b);
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      vi.mocked(fetchSources).mockResolvedValue([githubSource]);
      vi.mocked(rotateSourceSecret).mockResolvedValue({
        ...githubSource,
        providerSecret: `whsec_${control}[2J`,
      });
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', 'ghi-789']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('whsec_ [2J'),
      );
    });

    // rotate-secret reveals a one-time secret, so like `create` it must reject
    // --json before doing anything — a `| jq` pipeline would lose the secret.
    it('rejects --json on rotate-secret before prompting or calling the API', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchSources, rotateSourceSecret } = await import(
        '@/libs/sources.js'
      );
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['rotate-secret', '--json']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchSources).not.toHaveBeenCalled();
      expect(rotateSourceSecret).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it('catches and logs unexpected errors (e.g. checkConfig failing)', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    // Once so the rejection can't leak into later tests — clearAllMocks clears
    // call history but not implementations, which would otherwise make the
    // fetch_failed test below throw at checkConfig instead of at the fetch.
    vi.mocked(checkConfig).mockRejectedValueOnce(new Error('boom'));
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // checkConfig signals failure by resolving false rather than terminating the
  // process, so the command must short-circuit before dispatching to the
  // handler that would hit the network.
  it('does not reach the handler when checkConfig resolves false', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValueOnce(false);
    const { fetchSources } = await import('@/libs/sources.js');
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(fetchSources).not.toHaveBeenCalled();
    // checkConfig owns the diagnostic on the false path, so the command emits
    // nothing — distinguishing a false return from a thrown checkConfig.
    expect(console.error).not.toHaveBeenCalled();
  });

  // The unified --json failure contract: rejecting --json on a non-list
  // subcommand and a thrown fetch failure on `list --json` both surface as one
  // parseable { error, message } shape on stderr.
  describe('--json failure contract', () => {
    it('emits a usage-coded JSON error when --json is rejected on delete', async () => {
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['delete', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed).toEqual({
        error: 'usage',
        message: '--json is only supported by `sources list`.',
      });
      expect(process.exitCode).toBe(1);
    });

    it('emits a fetch_failed JSON error on stderr for a thrown fetch failure', async () => {
      const { fetchSources } = await import('@/libs/sources.js');
      vi.mocked(fetchSources).mockRejectedValue(new Error('boom'));
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await runSourcesCommand(['list', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.message).toContain('boom');
      expect(process.exitCode).toBe(1);
    });
  });
});
