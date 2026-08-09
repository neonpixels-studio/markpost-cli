import {
  authedRequest,
  logApiFailure,
  unwrapResourceAttributes,
} from '@/libs/api.js';
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
