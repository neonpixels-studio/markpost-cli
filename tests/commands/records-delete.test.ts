import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('#src/libs/records.js', async () => {
  // Real MAX_DELETE_BATCH_SIZE so the chunking assertions track the lib's cap.
  const { MAX_DELETE_BATCH_SIZE } = await vi.importActual<
    typeof import('#src/libs/records.js')
  >('#src/libs/records.js');

  return {
    MAX_DELETE_BATCH_SIZE,
    ERROR_STATUS: 'error',
    PENDING_STATUS: 'pending',
    fetchAllRecords: vi.fn(),
    updateRecord: vi.fn(),
    deleteRecords: vi.fn(),
  };
});
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const makeUuids = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) =>
      `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
  );

const outcome = (deleted: number) => ({
  meta: { deleted },
  permanentlyFailed: false,
});
const failedOutcome = { meta: null, permanentlyFailed: false };

describe('records delete', () => {
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const { checkConfig } = await import('#src/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = undefined;
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
  });

  const run = async (args: string[]) => {
    const { runRecordsCommand } = await import('#src/commands/records.js');
    await runRecordsCommand(['delete', ...args]);
  };

  it('deletes a single record after confirmation and reports the count', async () => {
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(deleteRecords).mockResolvedValue(outcome(1));

    await run([UUID_A]);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Delete 1 record(s)'),
        default: false,
      }),
    );
    expect(deleteRecords).toHaveBeenCalledTimes(1);
    expect(deleteRecords).toHaveBeenCalledWith([UUID_A]);
    expect(console.log).toHaveBeenCalledWith('Deleted 1 record(s).');
    expect(process.exitCode).toBeUndefined();
  });

  it('dedupes uuids (case-insensitively) and shows the deduped count in the prompt', async () => {
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(deleteRecords).mockResolvedValue(outcome(2));

    await run([UUID_A, UUID_B, UUID_A, UUID_A.toUpperCase()]);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Delete 2 record(s)'),
      }),
    );
    expect(deleteRecords).toHaveBeenCalledWith([UUID_A, UUID_B]);
  });

  it('splits more than 100 uuids into separate chunks and sums the counts', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords)
      .mockResolvedValueOnce(outcome(100))
      .mockResolvedValueOnce(outcome(100))
      .mockResolvedValueOnce(outcome(50));
    const uuids = makeUuids(250);

    await run([...uuids, '--yes']);

    const sentChunks = vi
      .mocked(deleteRecords)
      .mock.calls.map(([chunk]) => chunk);
    expect(sentChunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(sentChunks.flat()).toEqual(uuids);
    expect(console.log).toHaveBeenCalledWith('Deleted 250 record(s).');
  });

  it('rejects an invalid uuid before any config check, prompt, or request', async () => {
    const { checkConfig } = await import('#src/libs/config.js');
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');

    await run([UUID_A, 'not-a-uuid', '--yes']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"not-a-uuid"'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails with usage when no uuid is given', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');

    await run(['--yes']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No uuid given'),
    );
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('deletes nothing and exits 0 when the confirmation is declined', async () => {
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(confirm).mockResolvedValue(false);

    await run([UUID_A]);

    expect(deleteRecords).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Deletion cancelled.');
    expect(process.exitCode).toBeUndefined();
  });

  it('skips the prompt with --yes', async () => {
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords).mockResolvedValue(outcome(1));

    await run([UUID_A, '--yes']);

    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRecords).toHaveBeenCalledWith([UUID_A]);
  });

  it('refuses without --yes when stdin is not a terminal, instead of prompting', async () => {
    process.stdin.isTTY = false;
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');

    await run([UUID_A]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('--yes'),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('refuses without --yes when stdout is redirected', async () => {
    process.stdout.isTTY = false;
    const { confirm } = await import('@inquirer/prompts');

    await run([UUID_A]);

    expect(confirm).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('still deletes non-interactively when --yes is given', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords).mockResolvedValue(outcome(1));

    await run([UUID_A, '--yes']);

    expect(deleteRecords).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('notes uuids that matched no record when the server deleted fewer than requested', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords).mockResolvedValue(outcome(1));

    await run([UUID_A, UUID_B, '--yes']);

    expect(console.log).toHaveBeenCalledWith('Deleted 1 record(s).');
    expect(console.log).toHaveBeenCalledWith(
      '1 of 2 requested uuid(s) matched no record.',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('names the failed chunk, keeps going, and exits non-zero on a plain chunk failure', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords)
      .mockResolvedValueOnce(outcome(100))
      .mockResolvedValueOnce(failedOutcome)
      .mockResolvedValueOnce(outcome(50));

    await run([...makeUuids(250), '--yes']);

    expect(deleteRecords).toHaveBeenCalledTimes(3);
    const message = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(message).toContain('Deleted 150 of 250');
    expect(message).toContain('chunk 2 of 3');
    expect(message).not.toContain('chunk 1 of 3');
    expect(message).not.toContain('chunk 3 of 3');
    expect(process.exitCode).toBe(1);
  });

  it('stops after a systemic failure and reports the remaining chunks as not attempted', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords)
      .mockResolvedValueOnce(outcome(100))
      .mockRejectedValueOnce(new Error('boom'));

    await run([...makeUuids(250), '--yes']);

    expect(deleteRecords).toHaveBeenCalledTimes(2);
    const message = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(message).toContain('Deleted 100 of 250');
    expect(message).toContain('chunk 2 of 3');
    expect(message).toContain('chunk 3 of 3 (not attempted');
    expect(process.exitCode).toBe(1);
  });

  it('reports a thrown API error as a failure and exits non-zero', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords).mockRejectedValue(new Error('server down'));

    await run([UUID_A, '--yes']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Deleted 0 of 1'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('sends lowercased uuids when given uppercase', async () => {
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(deleteRecords).mockResolvedValue(outcome(1));

    await run([UUID_A.toUpperCase(), '--yes']);

    expect(deleteRecords).toHaveBeenCalledWith([UUID_A]);
  });

  it('treats Ctrl+C at the prompt as a quiet abort, deleting nothing', async () => {
    const { confirm } = await import('@inquirer/prompts');
    const { deleteRecords } = await import('#src/libs/records.js');
    vi.mocked(confirm).mockRejectedValue(
      Object.assign(new Error('User force closed'), {
        name: 'ExitPromptError',
      }),
    );

    await run([UUID_A]);

    expect(deleteRecords).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  describe('--json', () => {
    it('refuses --json without --yes rather than prompting on stdout', async () => {
      const { confirm } = await import('@inquirer/prompts');
      const { deleteRecords } = await import('#src/libs/records.js');

      await run([UUID_A, '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(parsed.message).toContain('--yes');
      expect(confirm).not.toHaveBeenCalled();
      expect(deleteRecords).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('prints the deleted and requested counts on success', async () => {
      const { deleteRecords } = await import('#src/libs/records.js');
      vi.mocked(deleteRecords).mockResolvedValue(outcome(2));

      await run([UUID_A, UUID_B, '--yes', '--json']);

      const printed = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
      expect(printed).toEqual({ deleted: 2, requested: 2 });
      expect(process.exitCode).toBeUndefined();
    });

    it('emits the unified error JSON with failedChunks on partial failure', async () => {
      const { deleteRecords } = await import('#src/libs/records.js');
      vi.mocked(deleteRecords)
        .mockResolvedValueOnce(outcome(100))
        .mockResolvedValueOnce(failedOutcome);

      await run([...makeUuids(150), '--yes', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.deleted).toBe(100);
      expect(parsed.requested).toBe(150);
      expect(parsed.failedChunks).toEqual([
        { chunk: 2, reason: 'the request failed' },
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('emits a usage-coded JSON error for an invalid uuid', async () => {
      await run(['nope', '--yes', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(process.exitCode).toBe(1);
    });

    it('emits a usage-coded JSON error for the non-interactive refusal', async () => {
      process.stdin.isTTY = false;

      await run([UUID_A, '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(process.exitCode).toBe(1);
    });
  });
});
