import {
  authedRequest,
  logApiFailure,
  unwrapResourceAttributes,
} from '@/libs/api.js';
import {
  ConflictStrategy,
  DEFAULT_CONFLICT_STRATEGY,
  DEFAULT_FRONTMATTER_ENABLED,
  normalizeAutoDelete,
  normalizeAutoSync,
  normalizeConflictStrategy,
  normalizeFrontmatterEnabled,
  UpdateSettingsInput,
  UserSettings,
  UserSettingsApiResponse,
  USER_SETTINGS_RESOURCE_TYPE,
} from '@/types/settings.types.js';

// A read either succeeded (`ok: true`) or failed. On success `settings` may
// still be `null` — a valid `{ data: null }` body for an account with no
// saved settings row yet, which means "use defaults", NOT "read failed".
// Overloading a bare `null` for both would make a transient failure
// indistinguishable from an untouched account; the caller must treat those
// differently (a failure must not enable the irreversible auto-delete).
export type SettingsReadResult =
  { ok: true; settings: UserSettings | null } | { ok: false };

// Reads the settings API through the shared `authedRequest` seam (auth +
// error parsing + request timeout) and reports the outcome as a discriminated
// result. On any failure except a request timeout it logs and returns
// `{ ok: false }` so the caller can fall back conservatively instead of
// crashing the sync — the same resilient shape `fetchSources` uses. A timeout
// propagates (see `logApiFailure`) rather than being collapsed to
// `{ ok: false }` here, so the caller can tell a stalled read apart from an
// ordinary failure and decide how to handle it (the sync caller degrades it
// non-fatally — see `runDefaultSync`).
export const fetchSettings = async (): Promise<SettingsReadResult> => {
  try {
    const body = (await authedRequest(
      '/api/settings',
    )) as UserSettingsApiResponse;

    return {
      ok: true,
      settings: unwrapResourceAttributes(body),
    };
  } catch (error) {
    logApiFailure('fetchSettings', error);

    return { ok: false };
  }
};

// Writes one or more settings through the same `authedRequest` seam as the
// read (auth + error parsing + request timeout), mirroring the JSON:API
// PUT body markpost's `PUT /api/settings` expects. Returns the server's
// updated attributes, or `null` on any failure — the resilient shape
// `updateSource` uses, so a command can report the failure without a crash.
// A timeout still propagates via `logApiFailure` (fail loud) rather than
// collapsing to `null`. The caller validates field names/values before
// calling, so the payload only ever carries contract-valid attributes.
export const updateSettings = async (
  input: UpdateSettingsInput,
): Promise<UserSettings | null> => {
  try {
    const body = (await authedRequest('/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: USER_SETTINGS_RESOURCE_TYPE,
          attributes: input,
        },
      }),
    })) as UserSettingsApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
    logApiFailure('updateSettings', error);

    return null;
  }
};

// The subset of settings the default sync acts on, already resolved to safe
// values.
export type ResolvedSyncSettings = {
  conflictStrategy: ConflictStrategy;
  autoDelete: boolean;
  autoSync: boolean;
  includeFrontmatter: boolean;
};

// Collapses the "trust each field only if the read succeeded" decision into one
// place. A failed read is deliberately conservative: no auto-delete and no
// self-scheduling daemon without confirmed settings, but writes still happen
// with the safe suffix strategy and frontmatter on. A successful read defers
// each field to its normalizer, which falls back to markpost's schema default
// on a malformed value.
export const resolveSyncSettings = (
  result: SettingsReadResult,
): ResolvedSyncSettings => {
  if (!result.ok) {
    return {
      conflictStrategy: DEFAULT_CONFLICT_STRATEGY,
      autoDelete: false,
      autoSync: false,
      includeFrontmatter: DEFAULT_FRONTMATTER_ENABLED,
    };
  }

  return {
    conflictStrategy: normalizeConflictStrategy(
      result.settings?.conflictStrategy,
    ),
    autoDelete: normalizeAutoDelete(result.settings?.autoDelete),
    autoSync: normalizeAutoSync(result.settings?.autoSync),
    includeFrontmatter: normalizeFrontmatterEnabled(
      result.settings?.frontmatter,
    ),
  };
};
