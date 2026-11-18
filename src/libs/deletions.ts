import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { authedRequest } from '#src/libs/api.js';
import { resolveWithinVault } from '#src/libs/filePathSafety.js';
import { hashContent } from '#src/libs/markdown.js';
import {
  getLedgerEntries,
  LedgerEntry,
  removeLedgerEntries,
} from '#src/libs/vault-ledger.js';
import {
  RecordDeletion,
  RecordDeletionList,
} from '#src/types/records.types.js';
import type { RecordDeletionListQuery } from '#src/types/vendor/markpost-api.types.js';

const DELETIONS_PATH = '/api/records/deletions';
const DELETIONS_PAGE_SIZE = 100;

// Typed against the vendored `RecordDeletionListQuery`, so a renamed or removed
// server query param fails the build (and the drift test) instead of silently
// sending a param the server ignores.
export const DELETIONS_QUERY_KEYS = {
  size: 'page[size]',
  after: 'page[after]',
  since: 'filter[since]',
} as const satisfies { [name: string]: keyof RecordDeletionListQuery };

export type DeletionFeed = {
  tombstones: RecordDeletion[];
  // False when the server could not vouch for the whole window: no `since`
  // was given, or it predates the tombstone retention window (30 days).
  complete: boolean;
};

const buildDeletionsQuery = (since?: string, after?: string): string => {
  const params = new URLSearchParams({
    [DELETIONS_QUERY_KEYS.size]: String(DELETIONS_PAGE_SIZE),
  });

  if (since) {
    params.set(DELETIONS_QUERY_KEYS.since, since);
  }

  if (after) {
    params.set(DELETIONS_QUERY_KEYS.after, after);
  }

  return params.toString();
};

// A row without a usable uuid cannot be matched to a file, and dropping it
// would let the feed look complete, so it fails the whole read instead.
const readTombstones = (page: RecordDeletionList): RecordDeletion[] => {
  return (page.data ?? []).map((resource) => {
    const attributes = resource?.attributes;

    if (typeof attributes?.recordUuid !== 'string') {
      throw new Error(
        'The deletions feed returned an entry without a recordUuid; refusing to treat the feed as complete.',
      );
    }

    return attributes;
  });
};

// The server pages by the last `recordUuid` returned. A page that claims more
// but yields no new cursor would loop forever or silently truncate, so it
// throws instead.
const nextCursor = (
  page: RecordDeletionList,
  pageTombstones: RecordDeletion[],
  seenCursors: Set<string>,
): string | undefined => {
  if (!page.meta?.hasMore) {
    return undefined;
  }

  const cursor = pageTombstones.at(-1)?.recordUuid;

  if (!cursor || seenCursors.has(cursor)) {
    throw new Error(
      'The deletions feed reports more pages but gave no new cursor; refusing to treat it as complete.',
    );
  }

  seenCursors.add(cursor);

  return cursor;
};

// Pages through the whole feed or throws: a truncated feed must never be
// mistaken for "nothing else was deleted", so there is no partial result.
export const fetchDeletionFeed = async (
  since?: string,
): Promise<DeletionFeed> => {
  const tombstones: RecordDeletion[] = [];
  const seenCursors = new Set<string>();
  let complete: boolean;
  let after: string | undefined;

  do {
    const page = (await authedRequest(
      `${DELETIONS_PATH}?${buildDeletionsQuery(since, after)}`,
    )) as RecordDeletionList;
    const pageTombstones = readTombstones(page);

    complete = page.meta?.complete === true;
    tombstones.push(...pageTombstones);
    after = nextCursor(page, pageTombstones, seenCursors);
  } while (after);

  return { tombstones, complete };
};

export type PruneOutcome =
  | 'remove' // tracked, untouched since the CLI wrote it
  | 'missing' // tracked, but the file is already gone
  | 'modified' // tracked, but edited since the CLI wrote it: left alone
  | 'unsafe'; // tracked, but not a plain file inside the vault: left alone

export type PruneItem = {
  uuid: string;
  path: string;
  outcome: PruneOutcome;
};

export type PrunePlan = {
  items: PruneItem[];
  // Tombstones for records the CLI has no file for (never synced here, or
  // deleted by autoDelete); never touched.
  untrackedCount: number;
};

const classifyTrackedFile = (
  vault: string,
  entry: LedgerEntry,
): PruneOutcome => {
  let absolutePath: string;

  try {
    absolutePath = resolveWithinVault(vault, entry.path);
  } catch {
    return 'unsafe';
  }

  const stats = lstatSync(absolutePath, { throwIfNoEntry: false });

  if (!stats) {
    return 'missing';
  }

  if (!stats.isFile()) {
    return 'unsafe';
  }

  const unchanged =
    hashContent(readFileSync(absolutePath, 'utf-8')) === entry.contentHash;

  return unchanged ? 'remove' : 'modified';
};

// Only uuids present in the ledger (files this CLI wrote and left on the
// server) are ever considered; a tombstone's own `filePath` is deliberately
// ignored because it is server-supplied and could name any vault file.
export const planPrune = (
  tombstones: RecordDeletion[],
  vault: string,
  entries: { [uuid: string]: LedgerEntry } = getLedgerEntries(),
): PrunePlan => {
  const items: PruneItem[] = [];
  let untrackedCount = 0;

  for (const { recordUuid } of tombstones) {
    const entry = Object.hasOwn(entries, recordUuid)
      ? entries[recordUuid]
      : undefined;

    if (!entry) {
      untrackedCount += 1;
      continue;
    }

    items.push({
      uuid: recordUuid,
      path: entry.path,
      outcome: classifyTrackedFile(vault, entry),
    });
  }

  return { items, untrackedCount };
};

// `unsafe` entries stay in the ledger so they keep showing up for a human;
// everything else is settled (removed, already gone, or user-owned now).
const isMissingFileError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';

const removeFile = (vault: string, path: string): void => {
  try {
    unlinkSync(resolveWithinVault(vault, path));
  } catch (error) {
    // Vanished between planning and applying: the goal is met.
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
};

// Entries are settled one by one and the ledger is updated even when a later
// file fails, so a partial run never leaves removed files tracked. Failures
// are reported together after everything else was attempted.
export const applyPrune = (plan: PrunePlan, vault: string): void => {
  const settled: string[] = [];
  const failures: string[] = [];

  for (const item of plan.items) {
    if (item.outcome === 'unsafe') {
      continue;
    }

    try {
      if (item.outcome === 'remove') {
        removeFile(vault, item.path);
      }

      settled.push(item.uuid);
    } catch (error) {
      failures.push(`${item.path} (${(error as Error).message})`);
    }
  }

  removeLedgerEntries(settled);

  if (failures.length > 0) {
    throw new Error(
      `Removed ${settled.length} file(s) but could not remove: ${failures.join('; ')}`,
    );
  }
};
