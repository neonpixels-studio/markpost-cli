// GENERATED FILE — do not hand-edit.
//
// This is a copy of the two ingest-endpoint constants' string values from
// markpost's `app/composables/useSources.ts` (`WEBHOOK_INGEST_BASE`,
// `EMAIL_DOMAIN`). markpost is the source of truth; the CLI's
// `src/commands/sources.ts` hand-mirrors them, so the drift test at
// `tests/libs/source-endpoints-drift.test.ts` compares this copy against the
// mirror and fails if they stop matching.
//
// It lives under `tests/` so it never ships in the published `dist/`.
//
// Regenerate with `npm run sync:source-endpoints`
// (see README.md#source-endpoint-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ app/composables/useSources.ts
// See markpost-source-endpoints.manifest.json for the exact commit.

/* eslint-disable */

export const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";

export const EMAIL_DOMAIN = "in.markpost.io";
