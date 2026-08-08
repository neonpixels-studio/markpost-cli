import { authedRequest, unwrapResourceAttributes } from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import {
  UserSettings,
  UserSettingsApiResponse,
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
// error parsing) and reports the outcome as a discriminated result. On any
// failure it logs and returns `{ ok: false }` so the caller can fall back
// conservatively instead of crashing the sync — the same resilient shape
// `fetchSources` uses.
export const fetchSettings = async (): Promise<SettingsReadResult> => {
  try {
    const body = (await authedRequest(
      '/api/settings',
    )) as UserSettingsApiResponse;

    return { ok: true, settings: unwrapResourceAttributes(body) };
  } catch (error) {
    logErrorMessage(
      'fetchSettings',
      error instanceof Error ? error.message : String(error),
    );

    return { ok: false };
  }
};
