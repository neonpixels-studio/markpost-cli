import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatedToken, Token } from '@/types/tokens.types.js';

vi.mock('@/libs/config.js', () => ({
  checkConfig: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/libs/api.js', () => ({
  getApiToken: vi.fn(),
}));
vi.mock('@/libs/tokens.js', () => ({
  fetchTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
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
  // `tokens revoke` now refuses to prompt without an interactive terminal
  // (both stdin and stdout must be TTYs), so simulate one by default; the
  // non-TTY guards have their own cases below.
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
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
  // every other command, not print red text and exit 0 — covers any
  // subcommand's own API call, not just list's fetchTokens (tested
  // separately below).
  it('exits non-zero when a create call throws', async () => {
    const { createToken } = await import('@/libs/tokens.js');
    vi.mocked(createToken).mockRejectedValue(new Error('boom'));
    const { runTokensCommand } = await import('@/commands/tokens.js');

    await runTokensCommand(['create', '--name', 'CI token']);

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

    it('prints each token, showing the prefix rather than a secret', async () => {
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

    // `list` takes no positionals and no flag besides `--json`; a typo'd
    // flag or a stray argument must fail loud instead of silently running
    // the plain-text path with exit 0 — the same guarantee `create` and
    // `revoke` already have for their own arguments.
    it("fails loudly on a typo'd flag instead of silently listing", async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--jsn']);

      expect(fetchTokens).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('fails loudly on a stray positional instead of silently listing', async () => {
      const { fetchTokens } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', 'foo']);

      expect(fetchTokens).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    // `list` never prompts, so it must stay usable on a non-TTY — this is the
    // primary scripted path (`tokens list --json > file`) the new revoke
    // confirmation guard must not sweep in alongside it. Mirrors the
    // equivalent `sources list` case in sources.test.ts.
    it('still lists on a non-TTY (neither stdin nor stdout is a terminal)', async () => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
      const { fetchTokens } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--json']);

      expect(fetchTokens).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
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
    it('revokes a token by id after the confirmation is accepted', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Revoked token tok-abc-123'),
      );
    });

    // The confirmation is the whole point of the feature: a "no" answer must
    // revoke nothing and report the abort.
    it('aborts without revoking when the confirmation is declined', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(false);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(revokeToken).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Revocation cancelled.');
      expect(process.exitCode).toBeUndefined();
    });

    // The confirm message must name the token being revoked and warn that the
    // action is irreversible so the user knows what they're destroying.
    it('names the token and warns it is irreversible in the confirmation prompt', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      // `default: false` is what makes a bare Enter cancel rather than
      // revoke — asserted alongside the message so this can't regress to
      // `default: true` while every other test here stubs `confirm`'s
      // resolved value directly. Mirrors the equivalent `sources delete`
      // assertion in sources.test.ts.
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('tok-abc-123'),
          default: false,
        }),
      );
      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).toContain('CI token');
      expect(message).toContain('cannot be undone');
    });

    // The stronger warning must fire when the id being revoked maps (via its
    // masked prefix) to the raw secret this CLI is configured with — revoking
    // it would lock the CLI out.
    it('shows a stronger warning when revoking the CLI’s own configured token', async () => {
      const { getApiToken } = await import('@/libs/api.js');
      vi.mocked(getApiToken).mockReturnValue('mp_live_ab12_rest_of_secret');
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).toContain(
        'this is the token this CLI is currently configured with',
      );
    });

    // A token whose prefix is not a prefix of the stored secret is a different
    // token, so the stronger warning must not fire.
    it('does not show the stronger warning for a token that is not the configured one', async () => {
      const { getApiToken } = await import('@/libs/api.js');
      vi.mocked(getApiToken).mockReturnValue('mp_live_zz99_other_secret');
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).not.toContain(
        'this is the token this CLI is currently configured with',
      );
    });

    // The scripting escape hatch: --yes revokes straight away with no prompt
    // and no label lookup (the short-circuit must skip fetchTokens entirely).
    it('skips the confirmation and the label lookup when --yes is passed', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123', '--yes']);

      expect(confirm).not.toHaveBeenCalled();
      expect(fetchTokens).not.toHaveBeenCalled();
      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
    });

    // Without --yes, a non-TTY invocation must fail loud instead of hanging on
    // the unanswerable confirm prompt — same guard shape as `sources delete`.
    it('fails loudly on a non-TTY revoke when --yes is absent instead of hanging', async () => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
      const { checkConfig } = await import('@/libs/config.js');
      const { revokeToken } = await import('@/libs/tokens.js');
      const { confirm } = await import('@inquirer/prompts');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(confirm).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      // Guarded before the config check, so a non-interactive run fails on
      // usage alone without needing a configured account.
      expect(checkConfig).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--yes'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Redirected stdout leaves stdin a TTY but hides the prompt inquirer
    // renders to stdout — same hang, so it must fail the same way.
    it('fails loudly on a redirected-stdout revoke when --yes is absent', async () => {
      process.stdout.isTTY = false;
      const { revokeToken } = await import('@/libs/tokens.js');
      const { confirm } = await import('@inquirer/prompts');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(confirm).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--yes'),
      );
      expect(process.exitCode).toBe(1);
    });

    // The scripting path: --yes with an id revokes on a non-TTY, no prompt.
    it('revokes on a non-TTY when an id and --yes are given', async () => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
      const { revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123', '--yes']);

      expect(confirm).not.toHaveBeenCalled();
      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
    });

    // A Ctrl+C at the confirmation is a deliberate abort: it must revoke
    // nothing, exit 0, and stay quiet — never fall through to the revoke.
    it('aborts cleanly without revoking when the confirmation is Ctrl+C-ed', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      const { confirm } = await import('@inquirer/prompts');
      const exitPromptError = Object.assign(new Error('User force closed'), {
        name: 'ExitPromptError',
      });
      vi.mocked(confirm).mockRejectedValue(exitPromptError);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(revokeToken).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(console.error).not.toHaveBeenCalled();
    });

    // A failed label lookup (fetchTokens throws) must not block the revoke: it
    // falls back to the bare id and still confirms + revokes. Asserts the
    // specific "could not load the list" note (not just the bare id) so this
    // outcome can't be confused with the distinct "no matching token found"
    // case below — the two notes are deliberately worded differently because
    // a failed load must never be mis-reported as a confirmed non-match.
    it('still confirms and revokes when the label lookup fails', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockRejectedValue(new Error('Server error'));
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).toContain('tok-abc-123');
      expect(message).toContain('could not load the list');
      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
    });

    // A resolved (not thrown) list with no matching id is a distinct outcome
    // from a failed lookup — it still confirms and lets `revokeToken` be the
    // source of truth on whether the id is real, but the prompt must say so
    // rather than reusing the "could not load the list" wording.
    it('still confirms with a distinct note when the list resolves with no matching token', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).toContain('tok-abc-123');
      expect(message).toContain('no matching token found');
      expect(message).not.toContain('could not load the list');
      expect(revokeToken).toHaveBeenCalledWith('tok-abc-123');
    });

    // An empty/malformed prefix must never satisfy `startsWith('')`, which is
    // always true — that would falsely flag every token as the one this CLI
    // is configured with.
    it('does not show the stronger warning for a token with an empty prefix', async () => {
      const { getApiToken } = await import('@/libs/api.js');
      vi.mocked(getApiToken).mockReturnValue('mp_live_ab12_rest_of_secret');
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([{ ...mockToken, prefix: '' }]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      const message = vi.mocked(confirm).mock.calls[0][0].message;
      expect(message).not.toContain(
        'this is the token this CLI is currently configured with',
      );
    });

    // `parseArgs` treats everything after a literal `--` as a positional, so
    // an id that happens to be the string "--yes" must still prompt — the
    // flag-detection in the runner has to agree with that, not just the
    // ordinary case where --yes trails a real id.
    it('still confirms when the id is the literal string "--yes" passed after --', async () => {
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', '--', '--yes']);

      expect(confirm).toHaveBeenCalled();
      expect(revokeToken).toHaveBeenCalledWith('--yes');
    });

    // --yes is meaningless outside revoke; it must fail loudly like a misplaced
    // --json rather than appearing to take effect.
    it('rejects --yes on a non-revoke subcommand', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchTokens } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['list', '--yes']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchTokens).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--yes is only supported by `tokens revoke`.'),
      );
      expect(process.exitCode).toBe(1);
    });

    // `--yes` with no id must fail on usage alone, before the config check —
    // otherwise it would reach an interactive prompt of checkConfig's own on
    // an unconfigured, non-interactive run instead of failing loud. Mirrors
    // `sources delete`'s equivalent `--yes requires a uuid` guard.
    it('rejects --yes with no id before the config check', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { revokeToken } = await import('@/libs/tokens.js');
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', '--yes']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(revokeToken).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--yes requires an id'),
      );
      expect(process.exitCode).toBe(1);
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
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([mockToken]);
      vi.mocked(revokeToken).mockResolvedValue(false);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
      const { runTokensCommand } = await import('@/commands/tokens.js');

      await runTokensCommand(['revoke', 'tok-abc-123']);

      expect(console.error).toHaveBeenCalledWith('Failed to revoke token.');
      expect(process.exitCode).toBe(1);
    });

    it('sanitizes the id before printing it back', async () => {
      const control = String.fromCharCode(0x1b);
      const { fetchTokens, revokeToken } = await import('@/libs/tokens.js');
      vi.mocked(fetchTokens).mockResolvedValue([]);
      vi.mocked(revokeToken).mockResolvedValue(true);
      const { confirm } = await import('@inquirer/prompts');
      vi.mocked(confirm).mockResolvedValue(true);
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
