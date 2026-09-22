import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatedToken, Token } from '@/types/tokens.types.js';

vi.mock('@/libs/config.js', () => ({
  checkConfig: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/libs/tokens.js', () => ({
  fetchTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
    yellowBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const mockToken: Token = {
  id: 'tok-abc-123',
  name: 'CI token',
  prefix: 'mp_live_ab12',
  createdAt: '2024-01-01T00:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  scopes: null,
};

const scopedToken: Token = {
  id: 'tok-def-456',
  name: 'Read-only token',
  prefix: 'mp_live_cd34',
  createdAt: '2024-01-02T00:00:00Z',
  lastUsedAt: '2024-02-01T00:00:00Z',
  expiresAt: '2024-06-01T00:00:00Z',
  scopes: ['records:read'],
};

// The one-time raw secret markpost's mint response reveals — present here and
// nowhere else.
const mintedToken: CreatedToken = {
  ...mockToken,
  token: 'mp_live_one_time_plaintext',
};

// Collapses every argument of every console.log AND console.error call into
// one searchable string, so a leak assertion can't be dodged by the secret
// landing in a second argument, a later call, or the other stream.
const loggedText = (): string =>
  [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((value) => String(value))
    .join('\n');

describe('runTokensCommand', () => {
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
    const { fetchTokens } = await import('@/libs/tokens.js');
    vi.mocked(fetchTokens).mockResolvedValue([]);
    const { runTokensCommand } = await import('@/commands/tokens.js');

    await runTokensCommand(['list']);

    expect(checkConfig).toHaveBeenCalledWith(false);
  });

  it('errors to stderr and exits 1 when no subcommand is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runTokensCommand } = await import('@/commands/tokens.js');

    await runTokensCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No subcommand given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost tokens'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 for an unknown subcommand', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runTokensCommand } = await import('@/commands/tokens.js');

    await runTokensCommand(['bogus']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand: bogus'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A propagated failure (e.g. a request timeout) must exit non-zero like
  // every other command, not print red text and exit 0.
  it('exits non-zero when a tokens call throws', async () => {
    const { fetchTokens } = await import('@/libs/tokens.js');
    vi.mocked(fetchTokens).mockRejectedValue(new Error('boom'));
    const { runTokensCommand } = await import('@/commands/tokens.js');

    await runTokensCommand(['list']);

    expect(process.exitCode).toBe(1);
  });

  describe('list', () => {
    it('prints "No API tokens found." when there are none', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      expect(console.log).toHaveBeenCalledWith('No API tokens found.');
    });

    it('prints each token, showing the masked prefix rather than a secret', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken, scopedToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('mp_live_ab12'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('mp_live_cd34'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('records:read'),
      );
    });

    it('renders "never" and "never used" for null expiresAt/lastUsedAt', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      // Anchored to the full line (not a bare `stringContaining('never')`,
      // which "never used" would also satisfy even if the expires branch
      // regressed to printing something else).
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('expires:    never'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('last used:  never used'),
      );
    });

    // fetchTokens deliberately propagates a failed fetch (see libs/tokens.ts)
    // instead of swallowing it to `[]`, so a fetch failure must not print
    // "No API tokens found." and exit 0 — that would misreport an error as
    // an empty account.
    it('exits non-zero and prints nothing to stdout when the fetch fails', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockRejectedValue(new Error('Server error'));
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      expect(console.log).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('exits non-zero and prints nothing to stdout in --json mode when the fetch fails', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockRejectedValue(new Error('Server error'));
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--json']);

      expect(console.log).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('renders "full access" for a null scopes list', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('full access'),
      );
    });

    // The one-time raw secret must only ever surface from `create`; a token
    // object that somehow still carries one on a list response must never
    // leak it.
    it('never prints a raw token secret carried on a listed token', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mintedToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      expect(loggedText()).not.toContain('mp_live_one_time_plaintext');
    });

    it('strips control characters from untrusted token fields before printing', async () => {
      const control = String.fromCharCode(0x1b);
      const evilToken: Token = {
        ...mockToken,
        name: `Evil${control}Token`,
        prefix: `mp_${control}live`,
      };
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([evilToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith('Evil Token');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('mp_ live'),
      );
    });

    it('prints the tokens as a parseable JSON array when --json is passed', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken, scopedToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--json']);

      expect(checkConfig).toHaveBeenCalledWith(true);
      expect(console.log).toHaveBeenCalledTimes(1);
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: 'tok-abc-123', name: 'CI token' });
      expect(parsed[1]).toMatchObject({
        id: 'tok-def-456',
        scopes: ['records:read'],
      });
    });

    it('prints an empty JSON array (not "No API tokens found.") for --json with no tokens', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--json']);

      expect(console.log).not.toHaveBeenCalledWith('No API tokens found.');
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toEqual([]);
    });

    // The JSON path enumerates the Token contract fields rather than
    // spreading the object, so a one-time raw secret riding on a malformed
    // list response can never surface — same invariant the pretty path holds.
    it('never leaks a raw token secret carried on a listed token in --json mode', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mintedToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--json']);

      expect(loggedText()).not.toContain('mp_live_one_time_plaintext');
    });

    // --json is rejected on subcommands that don't render JSON so a script
    // doing `tokens create --json | jq` fails loudly instead of losing the
    // one-time secret to human-formatted text.
    it('rejects --json on create rather than prompting or calling the API', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { createToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create', '--json', '--name', 'x']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(createToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--json is only supported by `tokens list`.'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects --json on revoke before dispatching', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { revokeToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123', '--json']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe('create', () => {
    it('mints a token from --name and prints it with the revealed secret', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue(mintedToken);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create', '--name', 'CI token']);

      expect(createToken).toHaveBeenCalledWith({
        name: 'CI token',
        expiresInDays: undefined,
      });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created token "CI token"'),
      );
      const secretMentions = loggedText()
        .split('\n')
        .filter((line) => line.includes('mp_live_one_time_plaintext'));
      expect(secretMentions).toHaveLength(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('shown once'),
      );
    });

    it('passes --expires-in-days through as a number', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue(mintedToken);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand([
        'create',
        '--name',
        'CI token',
        '--expires-in-days',
        '90',
      ]);

      expect(createToken).toHaveBeenCalledWith({
        name: 'CI token',
        expiresInDays: 90,
      });
    });

    // `create` declares no secret-accepting flag, so an attempt to pass one
    // (e.g. a caller assuming it works like some other CLI's token import)
    // is rejected outright by parseArgs's strict mode rather than being
    // silently accepted or ignored — there is no way to hand the CLI a raw
    // secret as a shell argument.
    it('rejects an attempt to pass a raw secret as a flag instead of silently accepting it', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand([
        'create',
        '--name',
        'CI token',
        '--token',
        'mp_live_shouldnotbeaccepted',
      ]);

      expect(createToken).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('fails with usage when --name is missing', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create']);

      expect(createToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('requires --name'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('fails with usage when --expires-in-days is not a whole number', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand([
        'create',
        '--name',
        'CI token',
        '--expires-in-days',
        'soon',
      ]);

      expect(createToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('must be a whole number'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Plain `Number()` + `Number.isInteger()` would accept both of these
    // (`Number('0x10')` is 16, `Number('1e2')` is 100), silently minting a
    // token with a surprising expiry instead of rejecting the malformed flag.
    it.each(['0x10', '1e2', '', '   '])(
      'rejects an unparseable --expires-in-days value (%j) rather than silently accepting it',
      async (value) => {
        const { createToken } = await import('@/libs/tokens.js');
        const { runTokensCommand } = await import('@/commands/tokens.js');

        await runTokensCommand([
          'create',
          '--name',
          'CI token',
          '--expires-in-days',
          value,
        ]);

        expect(createToken).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('must be a whole number'),
        );
        expect(process.exitCode).toBe(1);
      },
    );

    // resolveExpiresInDays trims before matching the whole-number pattern, so
    // surrounding whitespace must not be rejected as malformed.
    it('trims surrounding whitespace from a valid --expires-in-days value', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue(mintedToken);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand([
        'create',
        '--name',
        'CI token',
        '--expires-in-days',
        ' 90 ',
      ]);

      expect(createToken).toHaveBeenCalledWith({
        name: 'CI token',
        expiresInDays: 90,
      });
    });

    it('reports an error and exits non-zero when creation fails', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue(null);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create', '--name', 'CI token']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create token.'),
      );
      // A scripted `tokens create ... || alert` must see the failure via the
      // exit code, not just red text on stderr.
      expect(process.exitCode).toBe(1);
    });

    // The mint response's whole point is the one-time reveal; a response
    // that omits `token` must fail loud rather than silently succeed with an
    // unusable token — mirrors the equivalent generated-provider guard in
    // commands/sources.ts.
    it('fails when the create response omits the token secret', async () => {
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue(mockToken);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create', '--name', 'CI token']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('did not return its secret'),
      );
      // Points straight at the id already in hand rather than sending the
      // user through `tokens list` to find it.
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(`tokens revoke ${mockToken.id}`),
      );
      expect(process.exitCode).toBe(1);
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Created token'),
      );
    });

    it('strips control characters from a hostile token secret before printing', async () => {
      const control = String.fromCharCode(0x1b);
      const { createToken } = await import('@/libs/tokens.js');
      vi.mocked(createToken).mockResolvedValue({
        ...mintedToken,
        token: `mp_live_${control}[2J`,
      });
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['create', '--name', 'CI token']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('mp_live_ [2J'),
      );
    });
  });

  describe('revoke', () => {
    it('revokes a token by id', async () => {
      const { revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Revoked token tok-abc-123'),
      );
    });

    it('fails with usage when no id is given', async () => {
      const { revokeToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke']);

      expect(revokeToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('exactly one id'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A second positional must not be silently dropped: without this guard
    // `revoke a b` would revoke only `a` and still exit 0, so a script
    // expecting both ids revoked would misread it as fully done.
    it('fails with usage instead of silently dropping a second id', async () => {
      const { revokeToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-a', 'tok-b']);

      expect(revokeToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('exactly one id'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Parsed (not a bare positional destructure), so an unrecognized flag
    // is rejected by parseArgs's strict mode rather than being sent to the
    // API as a literal token id.
    it('fails loudly instead of treating an unrecognized flag as a literal id', async () => {
      const { revokeToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', '--help']);

      expect(revokeToken).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('exits non-zero when revocation fails', async () => {
      const { revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(revokeToken).mockResolvedValue(false);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(console.error).toHaveBeenCalledWith('Failed to revoke token.');
      expect(process.exitCode).toBe(1);
    });

    it('sanitizes the id before printing it back', async () => {
      const control = String.fromCharCode(0x1b);
      const { revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', `tok${control}123`]);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('tok 123'),
      );
    });
  });
});
