// Guards the CLI's hand-mirrored ingest-endpoint constants
// (src/commands/sources.ts's WEBHOOK_INGEST_BASE and EMAIL_DOMAIN) against
// silent drift from markpost's real `app/composables/useSources.ts`. These
// are the exact webhook/email URLs a user configures their provider against,
// so a mismatch here means the CLI prints a dead endpoint with no test
// failing to catch it.
//
// Like the frontmatter-serialization drift guard, this never hits the
// network: the vendored constants are refreshed by hand via
// `npm run sync:source-endpoints` and reviewed like any other diff (see
// README.md#source-endpoint-sync).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_DOMAIN as cliEmailDomain,
  WEBHOOK_INGEST_BASE as cliWebhookIngestBase,
} from '@/commands/sources.js';

import {
  EMAIL_DOMAIN as markpostEmailDomain,
  WEBHOOK_INGEST_BASE as markpostWebhookIngestBase,
} from './vendor/markpost-source-endpoints.generated.js';
import manifest from './vendor/markpost-source-endpoints.manifest.json' with { type: 'json' };

const VENDOR_FILE_PATH = fileURLToPath(
  new URL('./vendor/markpost-source-endpoints.generated.ts', import.meta.url),
);

// The two names scripts/sync-source-endpoints.mjs's REQUIRED_CONSTANT_NAMES
// vendors. Kept independent of the manifest (which only records provenance,
// not the expected export list, since it now uses the shared
// scripts/lib/markpost-checkout.mjs#writeManifest schema) so the two checks
// below each have their own source of truth to compare against instead of
// both deriving from the same value.
const EXPECTED_EXPORTS = ['WEBHOOK_INGEST_BASE', 'EMAIL_DOMAIN'];

describe('source endpoint drift', () => {
  it('the vendored markpost constants are present and record their provenance', () => {
    expect(existsSync(VENDOR_FILE_PATH)).toBe(true);
    expect(manifest.sourceFiles).toHaveLength(1);
    expect(manifest.sourceFiles[0].path).toBe('app/composables/useSources.ts');
    expect(manifest.sourceFiles[0].sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the generated file exports exactly the expected constants', async () => {
    // Catches a sync that leaves a stale extra export in the generated file
    // (or drops one) — the static imports below only prove the *named*
    // constants this test file expects still exist, not that nothing else
    // (or fewer) got vendored.
    const generatedModule =
      await import('./vendor/markpost-source-endpoints.generated.js');

    expect(Object.keys(generatedModule).sort()).toEqual(
      [...EXPECTED_EXPORTS].sort(),
    );
  });

  it('WEBHOOK_INGEST_BASE matches markpost byte-for-byte', () => {
    expect(cliWebhookIngestBase).toBe(markpostWebhookIngestBase);
  });

  it('EMAIL_DOMAIN matches markpost byte-for-byte', () => {
    expect(cliEmailDomain).toBe(markpostEmailDomain);
  });
});
