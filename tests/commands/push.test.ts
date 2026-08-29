import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Record } from '@/types/records.types.js';

vi.mock('@/libs/config.js', () => ({
  checkConfig: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/libs/records.js', () => ({ createRecord: vi.fn() }));
vi.mock('@/libs/markdown.js', () => ({ readMarkdown: vi.fn() }));
vi.mock('@/libs/files.js', () => ({ resolveMarkdownInputs: vi.fn() }));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
    dim: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
  },
}));

const mockRecord: Record = {
  uuid: 'abc-123',
  title: 'Test Title',
  content: 'Test Content',
  createdAt: '2024-01-01T00:00:00Z',
};

const recordFor = (title: string, uuid: string): Record => ({
  ...mockRecord,
  title,
  uuid,
});

describe('runPushCommand', () => {
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

  it('errors to stderr and exits 1 when no path is given', async () => {
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No path given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost push'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('does not check config when no path is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand([]);

    expect(checkConfig).not.toHaveBeenCalled();
  });

  it('errors to stderr, exits 1, and skips config for an empty-string argument', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No path given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost push'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reads the markdown file and creates a record from a single file', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['./notes/test-title.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown).mockReturnValue({
      title: 'Test Title',
      content: 'Test Content',
    });
    vi.mocked(createRecord).mockResolvedValue(mockRecord);
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./notes/test-title.md']);

    expect(checkConfig).toHaveBeenCalled();
    expect(readMarkdown).toHaveBeenCalledWith('./notes/test-title.md');
    expect(createRecord).toHaveBeenCalledWith('Test Title', 'Test Content');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "Test Title" (abc-123)'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  // checkConfig signals failure by resolving false rather than terminating the
  // process, so push must short-circuit before resolving inputs or creating a
  // record.
  it('does not resolve inputs or create a record when checkConfig resolves false', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValueOnce(false);
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { createRecord } = await import('@/libs/records.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./notes/test-title.md']);

    expect(resolveMarkdownInputs).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
    // checkConfig owns the diagnostic on the false path, so push emits nothing
    // — which also distinguishes a false return from a thrown checkConfig.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('pushes every file when given multiple', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(recordFor('A', 'uuid-a'))
      .mockResolvedValueOnce(recordFor('B', 'uuid-b'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md']);

    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "A" (uuid-a)'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "B" (uuid-b)'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed 2/2 file(s) successfully.'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('pushes files sequentially rather than in parallel', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });

    let releaseFirst: () => void = () => {};
    const firstPending = new Promise<Record>((resolvePromise) => {
      releaseFirst = () => resolvePromise(recordFor('A', 'uuid-a'));
    });
    vi.mocked(createRecord)
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce(recordFor('B', 'uuid-b'));
    const { runPushCommand } = await import('@/commands/push.js');

    const run = runPushCommand(['a.md', 'b.md']);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(createRecord).toHaveBeenCalledTimes(1);

    releaseFirst();
    await run;

    expect(createRecord).toHaveBeenCalledTimes(2);
  });

  it('continues pushing after one file fails and sets a failure exit code', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md', 'c.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' })
      .mockReturnValueOnce({ title: 'C', content: 'Content C' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(recordFor('A', 'uuid-a'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(recordFor('C', 'uuid-c'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md', 'c.md']);

    expect(createRecord).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "A" (uuid-a)'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to push "b.md".'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "C" (uuid-c)'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed 2/3 file(s) successfully.'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('continues after a file read throws instead of aborting the batch', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['bad.md', 'good.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockImplementationOnce(() => {
        throw Error('boom');
      })
      .mockReturnValueOnce({ title: 'Good', content: 'Content' });
    vi.mocked(createRecord).mockResolvedValue(recordFor('Good', 'uuid-good'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['bad.md', 'good.md']);

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to push "bad.md"'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "Good" (uuid-good)'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A timeout must abort the whole batch immediately, not be caught per-file
  // and retried on the next — otherwise a hung server stalls once per file.
  it('aborts the batch on a timeout instead of retrying the next file', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    // Import from the same (reset) module instance push.js will resolve, so
    // `instanceof ApiTimeoutError` in rethrowIfTimeout matches this error.
    const { ApiTimeoutError } = await import('@/libs/api.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });
    vi.mocked(createRecord).mockRejectedValueOnce(
      new ApiTimeoutError('https://example.com/api/records'),
    );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md']);

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('errors when no inputs resolve to any file', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: [],
      missing: ['./missing/*.md'],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./missing/*.md']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No markdown files found for "./missing/*.md".'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No markdown files to push.'),
    );
    expect(createRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('pushes resolved files but flags a partially-missing input set', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['real.md'],
      missing: ['ghost.md'],
      skipped: [],
    });
    vi.mocked(readMarkdown).mockReturnValue({
      title: 'Real',
      content: 'Content',
    });
    vi.mocked(createRecord).mockResolvedValue(recordFor('Real', 'uuid-real'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['real.md', 'ghost.md']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No markdown files found for "ghost.md".'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "Real" (uuid-real)'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports unreadable skipped paths and fails when nothing is left to push', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: [],
      missing: [],
      skipped: ['./vault/locked'],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./vault']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Skipped unreadable path "./vault/locked".'),
    );
    expect(createRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('pushes resolved files but still fails when a path was skipped', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['ok.md'],
      missing: [],
      skipped: ['./vault/locked'],
    });
    vi.mocked(readMarkdown).mockReturnValue({
      title: 'Ok',
      content: 'Content',
    });
    vi.mocked(createRecord).mockResolvedValue(recordFor('Ok', 'uuid-ok'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['ok.md', './vault']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Skipped unreadable path "./vault/locked".'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "Ok" (uuid-ok)'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('aborts the batch on a systemic auth failure without attempting later files', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md', 'c.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' })
      .mockReturnValueOnce({ title: 'C', content: 'Content C' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(recordFor('A', 'uuid-a'))
      .mockRejectedValueOnce(
        new ApiRequestError('Invalid or missing token', 401),
      );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md', 'c.md']);

    // The third file is never sent — the run stops after the systemic failure.
    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aborted on "b.md": Authentication failed (HTTP 401): Invalid or missing token. 1 file(s) not attempted.',
      ),
    );
    // The denominator stays the full resolved count (3), not the attempted
    // count, so an aborted run doesn't misreport how many files there were.
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed 1/3 file(s) successfully.'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('aborts on the very first file when the token is already expired', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md', 'c.md'],
      missing: [],
      skipped: [],
    });
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(readMarkdown).mockReturnValue({ title: 'A', content: 'Content' });
    vi.mocked(createRecord).mockRejectedValue(
      new ApiRequestError('Invalid or missing token', 401),
    );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md', 'c.md']);

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aborted on "a.md": Authentication failed (HTTP 401): Invalid or missing token. 2 file(s) not attempted.',
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  // A rate-limit (429) is systemic too: keep firing and it only gets worse.
  it('aborts the batch on a 429 rate-limit response', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown).mockReturnValue({ title: 'A', content: 'Content' });
    vi.mocked(createRecord).mockRejectedValue(
      new ApiRequestError('Too many requests', 429),
    );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md']);

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aborted on "a.md": Rate limited (HTTP 429): Too many requests. 1 file(s) not attempted.',
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  it('aborts the batch on a systemic 5xx server failure', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md', 'c.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(recordFor('A', 'uuid-a'))
      .mockRejectedValueOnce(
        new ApiRequestError('Unknown error occurred', 503),
      );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md', 'c.md']);

    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aborted on "b.md": Server error (HTTP 503): Unknown error occurred. 1 file(s) not attempted.',
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  // When the abort lands on the final file there's nothing left to skip, so the
  // "N file(s) not attempted" clause is dropped rather than reading "0 file(s)".
  it('omits the not-attempted clause when the last file aborts', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(recordFor('A', 'uuid-a'))
      .mockRejectedValueOnce(new ApiRequestError('Server fell over', 500));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aborted on "b.md": Server error (HTTP 500): Server fell over.',
      ),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('not attempted'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A per-file failure surfaces from createRecord as a null return (that's its
  // real contract post-fix — it only throws for systemic failures), so the
  // batch logs it and keeps going rather than aborting.
  it('does not abort on a per-file failure — it keeps pushing the rest', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown)
      .mockReturnValueOnce({ title: 'A', content: 'Content A' })
      .mockReturnValueOnce({ title: 'B', content: 'Content B' });
    vi.mocked(createRecord)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(recordFor('B', 'uuid-b'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md']);

    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to push "a.md".'),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Aborted on'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "B" (uuid-b)'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('previews the resolved files without creating any records on --dry-run', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md', 'b.md'],
      missing: [],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', 'b.md', '--dry-run']);

    // The whole point: no record-creation path is touched on a dry run.
    expect(createRecord).not.toHaveBeenCalled();
    expect(readMarkdown).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dry run — previewing 2 file(s); nothing will be pushed.',
      ),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would push 2 file(s):'),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('a.md'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('b.md'));
    expect(process.exitCode).toBeUndefined();
  });

  // A mistyped --dry-run must fail loud, never fall through to the real push and
  // create records the user only meant to preview.
  it('rejects a mistyped dry-run flag without resolving inputs or pushing', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', '--dryrun']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected arguments: --dryrun'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(resolveMarkdownInputs).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A dry run makes no network calls, so it must not gate on a configured token.
  it('does not check config on a dry run', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md'],
      missing: [],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', '--dry-run']);

    expect(checkConfig).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would push 1 file(s):'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  // A dry run walks directories, so a previewed path can carry a filename the
  // user never typed; a control character in it must be stripped before print.
  it('strips control characters from a previewed path', async () => {
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['notes/\u001b[2Jgotcha.md'],
      missing: [],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['notes', '--dry-run']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('notes/ [2Jgotcha.md'),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('\u001b'),
    );
  });

  // A file whose name starts with dashes is pushable via the POSIX `--`
  // end-of-options separator, so a glob that expands to one isn't rejected.
  it('treats args after -- as literal paths even when dash-leading', async () => {
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['--notes.md'],
      missing: [],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['--dry-run', '--', '--notes.md']);

    expect(resolveMarkdownInputs).toHaveBeenCalledWith(['--notes.md']);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Unexpected arguments'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would push 1 file(s):'),
    );
  });

  // An unexpected flag is rejected even alongside --dry-run: the guard runs
  // before the preview, so a typo can't ride in on a valid dry run.
  it('rejects an unexpected flag even when --dry-run is present', async () => {
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { createRecord } = await import('@/libs/records.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md', '--dry-run', '--verbose']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected arguments: --verbose'),
    );
    expect(resolveMarkdownInputs).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A record title is server-controlled and untrusted; a control character in
  // it must be stripped before the success line reaches the terminal.
  it('strips control characters from a pushed record title', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { readMarkdown } = await import('@/libs/markdown.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md'],
      missing: [],
      skipped: [],
    });
    vi.mocked(readMarkdown).mockReturnValue({ title: 'A', content: 'Content' });
    vi.mocked(createRecord).mockResolvedValue(
      recordFor('Sneaky\u001b[2KTitle', 'uuid-a'),
    );
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['a.md']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pushed "Sneaky [2KTitle" (uuid-a)'),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('\u001b'),
    );
  });

  it('excludes the --dry-run flag from the resolved input paths', async () => {
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['a.md'],
      missing: [],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['--dry-run', 'a.md']);

    // The flag must never reach resolveMarkdownInputs as if it were a path.
    expect(resolveMarkdownInputs).toHaveBeenCalledWith(['a.md']);
  });

  it('fails with usage when --dry-run is the only argument', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['--dry-run']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No path given.'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(resolveMarkdownInputs).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports missing inputs and exits 1 on a dry run without pushing', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['real.md'],
      missing: ['ghost.md'],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['real.md', 'ghost.md', '--dry-run']);

    expect(createRecord).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No markdown files found for "ghost.md".'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would push 1 file(s):'),
    );
    // A wrong glob is exactly what --dry-run exists to catch, so it stays honest
    // and exits non-zero like the real run would.
    expect(process.exitCode).toBe(1);
  });

  it('reports skipped unreadable inputs and exits 1 on a dry run without pushing', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: ['real.md'],
      missing: [],
      skipped: ['./vault/locked'],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['real.md', './vault', '--dry-run']);

    expect(createRecord).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Skipped unreadable path "./vault/locked".'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would push 1 file(s):'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on a dry run when no inputs resolve to any file', async () => {
    const { createRecord } = await import('@/libs/records.js');
    const { resolveMarkdownInputs } = await import('@/libs/files.js');
    vi.mocked(resolveMarkdownInputs).mockReturnValue({
      files: [],
      missing: ['./missing/*.md'],
      skipped: [],
    });
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./missing/*.md', '--dry-run']);

    expect(createRecord).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No markdown files to push.'),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Would push'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('catches and logs an unexpected error from config setup', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValue(Error('config blew up'));
    const { runPushCommand } = await import('@/commands/push.js');

    await runPushCommand(['./missing.md']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
