import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatedSource, Source } from '@/types/sources.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/sources.js', () => ({
  fetchSources: vi.fn(),
  createSource: vi.fn(),
  updateSource: vi.fn(),
  deleteSource: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ input: vi.fn(), select: vi.fn() }));
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

// Collapses every argument of every console.log AND console.error call into
// one searchable string, so a leak assertion can't be dodged by the secret
// landing in a second argument, a later call, or the other stream.
const loggedText = (): string =>
  [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
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
    expect(buildEndpointUrl('email', 'clip-ab12')).toBe('clip-ab12@in.markpost.io');
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

    expect(checkConfig).toHaveBeenCalled();
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
        expect.stringContaining('https://ingest.markpost.io/v1/hooks/wh_abc12345'),
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
      expect(console.error).toHaveBeenCalledWith('Route folder cannot be empty.');
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

  it('catches and logs unexpected errors (e.g. checkConfig failing)', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValue(new Error('boom'));
    const { runSourcesCommand } = await import('@/commands/sources.js');

    await runSourcesCommand(['list']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
