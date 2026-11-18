import Conf from 'conf';
import { dirname } from 'node:path';
import { getConfigPath } from '#src/libs/config.js';

// What the CLI knows about a note it left in the vault: where it landed
// (vault-relative, forward slashes) and a hash of the exact bytes written, so a
// later prune can tell an untouched file from one the user edited.
export type LedgerEntry = {
  path: string;
  contentHash: string;
};

type LedgerStore = {
  entries: { [uuid: string]: LedgerEntry };
  // ISO timestamp of the last fully applied deletion-feed pass; the next pass
  // asks the server for tombstones since then.
  lastDeletionSync?: string;
};

// Lives next to the main config file but in its own store, so the apiToken
// store's schema and `config` command stay untouched.
const LEDGER_FILE_MODE = 0o600;
let ledgerStore: Conf<LedgerStore> | undefined;

// Opened lazily so merely importing this module (index.ts does) never touches
// the config directory.
const openLedger = (): Conf<LedgerStore> => {
  ledgerStore ??= new Conf<LedgerStore>({
    cwd: dirname(getConfigPath()),
    configName: 'vault-ledger',
    configFileMode: LEDGER_FILE_MODE,
    defaults: { entries: {} },
  });

  return ledgerStore;
};

// Thin seams over the store (like config.ts) so callers mock them in isolation.
export const getLedgerEntries = (): LedgerStore['entries'] => {
  return openLedger().get('entries');
};

export const recordLedgerEntries = (newEntries: {
  [uuid: string]: LedgerEntry;
}): void => {
  openLedger().set('entries', { ...getLedgerEntries(), ...newEntries });
};

export const removeLedgerEntries = (uuids: string[]): void => {
  const remaining = { ...getLedgerEntries() };

  uuids.forEach((uuid) => {
    delete remaining[uuid];
  });
  openLedger().set('entries', remaining);
};

export const getLastDeletionSync = (): string | undefined => {
  return openLedger().get('lastDeletionSync');
};

export const setLastDeletionSync = (isoTimestamp: string): void => {
  openLedger().set('lastDeletionSync', isoTimestamp);
};
