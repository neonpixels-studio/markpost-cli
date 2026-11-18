import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/libs/config.js', () => ({
  config: { get: vi.fn() },
}));
vi.mock('#src/libs/vault-ledger.js', () => ({
  getLedgerEntries: vi.fn(() => ({})),
  removeLedgerEntries: vi.fn(),
}));

import {
  applyPrune,
  fetchDeletionFeed,
  planPrune,
} from '#src/libs/deletions.js';
import { hashContent } from '#src/libs/markdown.js';
import { removeLedgerEntries } from '#src/libs/vault-ledger.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

const tombstone = (recordUuid: string) => ({
  type: 'recordTombstones',
  id: recordUuid,
  attributes: { recordUuid, filePath: null, deletedAt: '2026-11-01T00:00:00Z' },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const page = (uuids: string[], hasMore: boolean, complete: boolean) =>
  jsonResponse({
    data: uuids.map(tombstone),
    meta: { size: 100, hasMore, complete },
    links: { next: null },
  });

describe('fetchDeletionFeed', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('BASE_URL', 'https://example.com');
    vi.stubEnv('API_TOKEN', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const requestedUrls = (): URL[] =>
    fetchMock.mock.calls.map(([url]) => new URL(String(url)));

  it('sends filter[since] and reports the server-declared completeness', async () => {
    fetchMock.mockResolvedValueOnce(page([UUID_A], false, true));

    const feed = await fetchDeletionFeed('2026-11-10T00:00:00Z');

    expect(feed.complete).toBe(true);
    expect(feed.tombstones.map(({ recordUuid }) => recordUuid)).toEqual([
      UUID_A,
    ]);
    const [url] = requestedUrls();
    expect(url.pathname).toBe('/api/records/deletions');
    expect(url.searchParams.get('filter[since]')).toBe('2026-11-10T00:00:00Z');
    expect(url.searchParams.has('page[after]')).toBe(false);
  });

  it('follows page[after] using the last recordUuid until hasMore is false', async () => {
    fetchMock
      .mockResolvedValueOnce(page([UUID_A, UUID_B], true, true))
      .mockResolvedValueOnce(page([UUID_C], false, true));

    const feed = await fetchDeletionFeed('2026-11-10T00:00:00Z');

    expect(feed.tombstones).toHaveLength(3);
    const urls = requestedUrls();
    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get('page[after]')).toBe(UUID_B);
    expect(urls[1].searchParams.get('filter[since]')).toBe(
      '2026-11-10T00:00:00Z',
    );
  });

  it('is not complete when the server says the window is not covered', async () => {
    fetchMock.mockResolvedValueOnce(page([], false, false));

    const feed = await fetchDeletionFeed();

    expect(feed.complete).toBe(false);
    expect(requestedUrls()[0].searchParams.has('filter[since]')).toBe(false);
  });

  it('treats a missing meta.complete as not complete', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    expect((await fetchDeletionFeed('2026-11-10T00:00:00Z')).complete).toBe(
      false,
    );
  });

  it('throws instead of returning a truncated feed when hasMore has no new cursor', async () => {
    fetchMock.mockResolvedValue(page([], true, true));

    await expect(fetchDeletionFeed('2026-11-10T00:00:00Z')).rejects.toThrow(
      /no new cursor/,
    );
  });

  it('throws when a later page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(page([UUID_A], true, true))
      .mockResolvedValue(
        jsonResponse(
          { errors: [{ status: '400', title: 'x', detail: 'y' }] },
          400,
        ),
      );

    await expect(fetchDeletionFeed('2026-11-10T00:00:00Z')).rejects.toThrow();
  });

  it('surfaces a persistent 5xx rather than an empty feed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { errors: [{ status: '500', title: 'x', detail: 'y' }] },
        500,
      ),
    );

    await expect(fetchDeletionFeed()).rejects.toThrow();
  }, 30_000);
});

describe('planPrune / applyPrune', () => {
  let vault: string;
  let outside: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'markpost-cli-prune-vault-'));
    outside = mkdtempSync(join(tmpdir(), 'markpost-cli-prune-outside-'));
    vi.mocked(removeLedgerEntries).mockClear();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const writeNote = (relativePath: string, content: string): void => {
    const absolutePath = join(vault, relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content);
  };

  const entryFor = (path: string, content: string) => ({
    path,
    contentHash: hashContent(content),
  });

  const tombstones = (...uuids: string[]) =>
    uuids.map((recordUuid) => ({
      recordUuid,
      filePath: null,
      deletedAt: '2026-11-01T00:00:00Z',
    }));

  it('removes only the unmodified, ledgered file', () => {
    writeNote('inbox/a.md', 'alpha');
    const entries = { [UUID_A]: entryFor('inbox/a.md', 'alpha') };

    const plan = planPrune(tombstones(UUID_A), vault, entries);
    applyPrune(plan, vault);

    expect(plan.items).toEqual([
      { uuid: UUID_A, path: 'inbox/a.md', outcome: 'remove' },
    ]);
    expect(existsSync(join(vault, 'inbox/a.md'))).toBe(false);
    expect(removeLedgerEntries).toHaveBeenCalledWith([UUID_A]);
  });

  it('never touches a file for a tombstone the CLI did not write', () => {
    writeNote('keep.md', 'mine');

    const plan = planPrune(tombstones(UUID_A), vault, {});
    applyPrune(plan, vault);

    expect(plan.untrackedCount).toBe(1);
    expect(plan.items).toEqual([]);
    expect(existsSync(join(vault, 'keep.md'))).toBe(true);
  });

  it('ignores the server-supplied filePath on a tombstone', () => {
    writeNote('victim.md', 'precious');
    const hostile = [
      {
        recordUuid: UUID_A,
        filePath: 'victim.md',
        deletedAt: '2026-11-01T00:00:00Z',
      },
    ];

    applyPrune(planPrune(hostile, vault, {}), vault);

    expect(existsSync(join(vault, 'victim.md'))).toBe(true);
  });

  it('keeps a file edited since the CLI wrote it', () => {
    writeNote('a.md', 'edited by hand');
    const entries = { [UUID_A]: entryFor('a.md', 'original') };

    const plan = planPrune(tombstones(UUID_A), vault, entries);
    applyPrune(plan, vault);

    expect(plan.items[0].outcome).toBe('modified');
    expect(existsSync(join(vault, 'a.md'))).toBe(true);
    expect(removeLedgerEntries).toHaveBeenCalledWith([UUID_A]);
  });

  it('reports an already-missing file and clears its ledger entry', () => {
    const entries = { [UUID_A]: entryFor('gone.md', 'x') };

    const plan = planPrune(tombstones(UUID_A), vault, entries);
    applyPrune(plan, vault);

    expect(plan.items[0].outcome).toBe('missing');
    expect(removeLedgerEntries).toHaveBeenCalledWith([UUID_A]);
  });

  it('refuses a ledger path that escapes the vault', () => {
    writeFileSync(join(outside, 'secret.md'), 'secret');
    const entries = {
      [UUID_A]: entryFor(`../${join(outside, 'secret.md')}`, 'secret'),
      [UUID_B]: entryFor('../escape.md', 'secret'),
    };

    const plan = planPrune(tombstones(UUID_A, UUID_B), vault, entries);
    applyPrune(plan, vault);

    expect(plan.items.map(({ outcome }) => outcome)).toEqual([
      'unsafe',
      'unsafe',
    ]);
    expect(existsSync(join(outside, 'secret.md'))).toBe(true);
    expect(removeLedgerEntries).toHaveBeenCalledWith([]);
  });

  it('does not follow or delete through a symlink at the leaf', () => {
    writeFileSync(join(outside, 'target.md'), 'target');
    symlinkSync(join(outside, 'target.md'), join(vault, 'link.md'));
    const entries = { [UUID_A]: entryFor('link.md', 'target') };

    const plan = planPrune(tombstones(UUID_A), vault, entries);
    applyPrune(plan, vault);

    expect(plan.items[0].outcome).toBe('unsafe');
    expect(existsSync(join(outside, 'target.md'))).toBe(true);
  });

  it('does not treat prototype keys as ledger entries', () => {
    const plan = planPrune(tombstones('constructor', '__proto__'), vault, {});

    expect(plan.untrackedCount).toBe(2);
    expect(plan.items).toEqual([]);
  });

  it('plans without changing anything until applyPrune runs', () => {
    writeNote('a.md', 'alpha');
    const entries = { [UUID_A]: entryFor('a.md', 'alpha') };

    planPrune(tombstones(UUID_A), vault, entries);

    expect(existsSync(join(vault, 'a.md'))).toBe(true);
    expect(removeLedgerEntries).not.toHaveBeenCalled();
  });
});
