import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXPORT_TRUNCATED_HEADER,
  ExportFileExistsError,
  fetchRecordExport,
  writeExportFile,
} from '@/libs/export.js';
import { ApiRequestError, ApiTimeoutError } from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import { RecordExportRow } from '@/types/records.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store as soon as it's loaded. Mock it so loading api.js
// doesn't pull in that side effect (see tests/libs/settings.test.ts).
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

vi.mock('@/libs/errors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/errors.js')>()),
  logErrorMessage: vi.fn(),
}));

// Drive the external-service seams (base URL, token) through the env vars the
// real `getBaseUrl`/`getApiToken` read, mirroring tests/libs/settings.test.ts.
beforeEach(() => {
  vi.stubEnv('BASE_URL', 'https://example.com');
  vi.stubEnv('API_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const exportRow: RecordExportRow = {
  uuid: 'abc-123',
  createdAt: '2024-01-01T00:00:00Z',
  title: 'First Record',
  content: 'First record content',
  source: 'webhook',
  sourceId: 'source-1',
  status: 'synced',
  filePath: '/vault/first-record.md',
  tags: ['a', 'b'],
  frontmatter: null,
  syncedAt: '2024-01-02T00:00:00Z',
  errorMessage: null,
};

function mockFetch(
  responseBody: unknown,
  {
    ok = true,
    truncatedHeader,
  }: { ok?: boolean; truncatedHeader?: string } = {},
) {
  const headers = new Headers();

  if (truncatedHeader !== undefined) {
    headers.set(EXPORT_TRUNCATED_HEADER, truncatedHeader);
  }

  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    headers,
    json: () => Promise.resolve(responseBody),
  });
}

describe('fetchRecordExport', () => {
  beforeEach(() => {
    vi.mocked(logErrorMessage).mockClear();
  });

  it('returns every row and truncated:false when the header says "false"', async () => {
    mockFetch([exportRow], { truncatedHeader: 'false' });

    await expect(fetchRecordExport()).resolves.toEqual({
      ok: true,
      rows: [exportRow],
      truncated: false,
      skippedCount: 0,
    });
  });

  it('returns truncated:true when the header says "true"', async () => {
    mockFetch([exportRow], { truncatedHeader: 'true' });

    const result = await fetchRecordExport();

    expect(result).toMatchObject({ ok: true, truncated: true });
  });

  // Fail closed like markpost's own web export client: an absent header can't
  // prove the export is whole, so treat it as truncated rather than silently
  // claiming completeness.
  it('fails closed to truncated:true when the header is absent', async () => {
    mockFetch([exportRow]);

    const result = await fetchRecordExport();

    expect(result).toMatchObject({ ok: true, truncated: true });
  });

  it('normalizes the header value case-insensitively', async () => {
    mockFetch([exportRow], { truncatedHeader: 'TRUE' });

    const result = await fetchRecordExport();

    expect(result).toMatchObject({ truncated: true });
  });

  it('returns an empty array (not ok:false) for a genuinely empty account', async () => {
    mockFetch([], { truncatedHeader: 'false' });

    await expect(fetchRecordExport()).resolves.toEqual({
      ok: true,
      rows: [],
      truncated: false,
      skippedCount: 0,
    });
  });

  // Regression: a bare `Array.isArray` check followed by a cast would let a
  // malformed element (null, or an object missing the fields the CLI reads
  // on every row) reach the printer/written backup unvalidated. Malformed
  // rows are dropped and logged instead, mirroring
  // `unwrapResourceCollection`'s attributes-present check.
  it('drops a malformed row and logs the skip, keeping the well-formed ones', async () => {
    mockFetch([exportRow, null, { uuid: 'no-title-or-status' }], {
      truncatedHeader: 'false',
    });

    const result = await fetchRecordExport();

    expect(result).toEqual({
      ok: true,
      rows: [exportRow],
      truncated: false,
      skippedCount: 2,
    });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchRecordExport',
      'Skipped 2 malformed export row(s)',
    );
  });

  // Regression: the guard originally checked only uuid/title/status, so a row
  // missing a field the CLI still reads or persists on every row (createdAt,
  // content) would pass validation, then crash the printer or land silently
  // in a written backup with no body.
  it('drops a row missing createdAt or content, even though uuid/title/status are present', async () => {
    const missingCreatedAt = { ...exportRow, createdAt: undefined };
    const missingContent = { ...exportRow, content: undefined };
    mockFetch([exportRow, missingCreatedAt, missingContent], {
      truncatedHeader: 'false',
    });

    const result = await fetchRecordExport();

    expect(result).toEqual({
      ok: true,
      rows: [exportRow],
      truncated: false,
      skippedCount: 2,
    });
  });

  // The optional fields (source, sourceId, filePath, syncedAt, errorMessage)
  // are `string | null` on the wire; a non-string, non-null value (an
  // off-contract number, say) must not reach `sanitizeForTerminal` unchecked.
  it('drops a row whose optional field is neither a string nor null', async () => {
    const badSource = { ...exportRow, source: 123 };
    mockFetch([exportRow, badSource], { truncatedHeader: 'false' });

    const result = await fetchRecordExport();

    expect(result).toEqual({
      ok: true,
      rows: [exportRow],
      truncated: false,
      skippedCount: 1,
    });
  });

  it('logs and returns ok:false when the response body is not an array', async () => {
    mockFetch({ data: [] }, { truncatedHeader: 'false' });

    await expect(fetchRecordExport()).resolves.toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchRecordExport',
      expect.stringContaining('Unexpected response shape'),
    );
  });

  it('logs and returns ok:false for a non-systemic failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          data: {
            errors: [{ status: '404', title: 'Not found', detail: 'x' }],
          },
        }),
    });

    await expect(fetchRecordExport()).resolves.toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalled();
  });

  // A systemic auth/5xx failure dooms the whole export, so it must re-throw
  // (mirroring fetchRecord/fetchAllRecords) rather than collapse to ok:false —
  // the caller surfaces the classified message with a non-zero exit instead of
  // reporting an empty backup.
  it('re-throws a systemic auth failure instead of returning ok:false', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () => Promise.resolve({}),
    });

    await expect(fetchRecordExport()).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('propagates a timeout instead of returning ok:false', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(fetchRecordExport()).rejects.toBeInstanceOf(ApiTimeoutError);
  });
});

describe('writeExportFile', () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'markpost-export-test-'));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('writes the rows as indented JSON to the given path', () => {
    const targetPath = join(tempDirectory, 'backup.json');

    const resolvedPath = writeExportFile(targetPath, [exportRow]);

    expect(resolvedPath).toBe(targetPath);
    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual([exportRow]);
  });

  // A full-account export holds every record's private title/content — as
  // sensitive as the API token — so the file must not be left
  // group/world-readable, matching config.ts's `configFileMode: 0o600`.
  it('creates the file owner-readable only (0o600)', () => {
    const targetPath = join(tempDirectory, 'backup.json');

    writeExportFile(targetPath, [exportRow]);

    const mode = statSync(targetPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates missing parent directories', () => {
    const targetPath = join(tempDirectory, 'nested', 'deeper', 'backup.json');

    writeExportFile(targetPath, []);

    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual([]);
  });

  // Refuses to clobber an existing file by default — a mistyped `--out` path
  // must not silently destroy whatever was already there.
  it('refuses to overwrite an existing file unless force is set', () => {
    const targetPath = join(tempDirectory, 'backup.json');
    writeFileSync(targetPath, 'previous backup contents');

    expect(() => writeExportFile(targetPath, [exportRow])).toThrow(
      ExportFileExistsError,
    );
    // The refusal must not touch the existing file at all.
    expect(readFileSync(targetPath, 'utf-8')).toBe('previous backup contents');
  });

  it('overwrites an existing file when force is true', () => {
    const targetPath = join(tempDirectory, 'backup.json');
    writeFileSync(targetPath, 'previous backup contents');

    writeExportFile(targetPath, [exportRow], true);

    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual([exportRow]);
  });

  // The new content always lands in a freshly created inode (temp file +
  // rename), so `force` overwriting a file some other process left
  // world-readable still ends up 0o600 rather than inheriting the old mode.
  it('applies 0o600 even when force-overwriting a file with a looser mode', () => {
    const targetPath = join(tempDirectory, 'backup.json');
    writeFileSync(targetPath, 'previous backup contents', { mode: 0o644 });

    writeExportFile(targetPath, [exportRow], true);

    const mode = statSync(targetPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Writes via a sibling temp file + rename (atomic on POSIX) rather than
  // truncating the target directly, so a mid-write failure can't leave a
  // corrupt backup where a good one used to be. No leftover temp file should
  // survive a successful write.
  it('leaves no temp file behind after a successful write', () => {
    const targetPath = join(tempDirectory, 'backup.json');

    writeExportFile(targetPath, [exportRow]);

    const entries = readdirSync(tempDirectory);
    expect(entries).toEqual(['backup.json']);
  });

  it('expands a leading ~ against the home directory', () => {
    // Point HOME at the temp dir so the expansion is verifiable without
    // touching the real home directory.
    vi.stubEnv('HOME', tempDirectory);

    const resolvedPath = writeExportFile('~/backup.json', [exportRow]);

    expect(resolvedPath).toBe(join(tempDirectory, 'backup.json'));
    expect(JSON.parse(readFileSync(resolvedPath, 'utf-8'))).toEqual([
      exportRow,
    ]);

    vi.unstubAllEnvs();
  });
});
