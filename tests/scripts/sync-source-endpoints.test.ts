// Unit-tests the pure extraction logic of
// scripts/sync-source-endpoints.mjs without touching the network. The
// end-to-end guard (the CLI's constants still matching markpost's) lives in
// tests/libs/source-endpoints-drift.test.ts; this only proves the extractor
// pulls the right constants — and refuses to silently vendor something it
// can't — while ignoring everything around them.
import { describe, expect, it } from 'vitest';

import {
  extractEndpointConstants,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-source-endpoints.mjs';

// A trimmed stand-in for markpost's useSources.ts: the two ingest-endpoint
// constants the extractor must pull, wrapped in the surrounding
// composable-only noise it must ignore (an unrelated import, an unrelated
// exported function).
const MARKPOST_SOURCE = `
import { computeElapsedBuckets } from "../utils/timeBuckets";

const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";
const EMAIL_DOMAIN = "in.markpost.io";

export function buildEndpointUrl(sourceType: string, endpointSlug: string): string {
  if (sourceType === "email") {
    return \`\${endpointSlug}@\${EMAIL_DOMAIN}\`;
  }

  return \`\${WEBHOOK_INGEST_BASE}/\${endpointSlug}\`;
}

export function formatLastHit(lastHitAt: string | null): string {
  return lastHitAt ? "last hit" : "never hit";
}
`;

// A plain `String.prototype.replace` silently returns the input unchanged
// when `find` isn't present, so a fixture mutation that no longer matches
// (e.g. after MARKPOST_SOURCE is reformatted) would leave the "mutated"
// variant identical to the original — a positive assertion below could then
// stay green without ever exercising the code path it claims to test. This
// fails loudly instead.
function replaceOnce(
  source: string,
  find: string,
  replacement: string,
): string {
  if (!source.includes(find)) {
    throw new Error(`fixture no longer contains: ${find}`);
  }

  return source.replace(find, replacement);
}

describe('extractEndpointConstants', () => {
  it('pulls both ingest-endpoint constants', () => {
    const constants = extractEndpointConstants(MARKPOST_SOURCE);

    expect(constants).toContain(
      'WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks"',
    );
    expect(constants).toContain('EMAIL_DOMAIN = "in.markpost.io"');
  });

  it('exports both constants even if markpost does not export them', () => {
    const constants = extractEndpointConstants(MARKPOST_SOURCE);

    expect(constants).toContain('export const WEBHOOK_INGEST_BASE');
    expect(constants).toContain('export const EMAIL_DOMAIN');
  });

  it('leaves unrelated composable code behind', () => {
    const constants = extractEndpointConstants(MARKPOST_SOURCE);

    expect(constants).not.toContain('buildEndpointUrl');
    expect(constants).not.toContain('formatLastHit');
    expect(constants).not.toContain('computeElapsedBuckets');
  });

  it('does not duplicate an existing export keyword', () => {
    const withExport = replaceOnce(
      MARKPOST_SOURCE,
      'const WEBHOOK_INGEST_BASE',
      'export const WEBHOOK_INGEST_BASE',
    );

    const constants = extractEndpointConstants(withExport);

    expect(constants).not.toContain('export export const WEBHOOK_INGEST_BASE');
    expect(constants).toContain('export const WEBHOOK_INGEST_BASE');
  });

  it('extracts only the matching declarator when both constants share one statement', () => {
    const combinedStatement = replaceOnce(
      MARKPOST_SOURCE,
      'const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";\nconst EMAIL_DOMAIN = "in.markpost.io";',
      'const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks", EMAIL_DOMAIN = "in.markpost.io";',
    );

    const constants = extractEndpointConstants(combinedStatement);

    // Each constant must appear exactly once — a naive whole-statement copy
    // would duplicate the combined declaration for both names and produce
    // two conflicting `WEBHOOK_INGEST_BASE` declarations.
    expect(constants.match(/export const WEBHOOK_INGEST_BASE/g)).toHaveLength(
      1,
    );
    expect(constants.match(/export const EMAIL_DOMAIN/g)).toHaveLength(1);
    expect(constants).toContain(
      'export const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";',
    );
    expect(constants).toContain(
      'export const EMAIL_DOMAIN = "in.markpost.io";',
    );
  });

  it('ignores an unrelated sibling declarator in the same statement', () => {
    const withSibling = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'const EMAIL_DOMAIN = "in.markpost.io", runtimeConfig = useRuntimeConfig();',
    );

    const constants = extractEndpointConstants(withSibling);

    expect(constants).not.toContain('runtimeConfig');
    expect(constants).not.toContain('useRuntimeConfig');
    expect(constants).toContain(
      'export const EMAIL_DOMAIN = "in.markpost.io";',
    );
  });

  it('throws loudly when a constant is not a plain string literal', () => {
    const templated = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'const EMAIL_DOMAIN = `${INGEST_HOST}`;',
    );

    expect(() => extractEndpointConstants(templated)).toThrow(
      /EMAIL_DOMAIN.*not a plain string literal/,
    );
  });

  it('unwraps value-preserving TypeScript wrappers around the string literal', () => {
    const asConst = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'const EMAIL_DOMAIN = "in.markpost.io" as const;',
    );
    const satisfiesModifier = replaceOnce(
      MARKPOST_SOURCE,
      'const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";',
      'const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks" satisfies string;',
    );
    const parenthesized = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'const EMAIL_DOMAIN = ("in.markpost.io");',
    );

    expect(extractEndpointConstants(asConst)).toContain(
      'export const EMAIL_DOMAIN = "in.markpost.io";',
    );
    expect(extractEndpointConstants(satisfiesModifier)).toContain(
      'export const WEBHOOK_INGEST_BASE = "https://ingest.markpost.io/v1/hooks";',
    );
    expect(extractEndpointConstants(parenthesized)).toContain(
      'export const EMAIL_DOMAIN = "in.markpost.io";',
    );
  });

  it('accepts a no-substitution template literal as a plain string value', () => {
    const backtickValue = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'const EMAIL_DOMAIN = `in.markpost.io`;',
    );

    const constants = extractEndpointConstants(backtickValue);

    expect(constants).toContain(
      'export const EMAIL_DOMAIN = "in.markpost.io";',
    );
  });

  it('throws loudly (as a missing constant) when markpost uses a reassignable binding', () => {
    const letBinding = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      'let EMAIL_DOMAIN = "in.markpost.io";',
    );

    // A `let`/`var` binding could hold a different value by the time
    // anything reads it, so it must not be treated as a vendorable constant
    // — this is reported the same way as a fully missing declaration.
    expect(() => extractEndpointConstants(letBinding)).toThrow(/EMAIL_DOMAIN/);
  });

  it('throws loudly when markpost drops one of the constants', () => {
    const withoutEmailDomain = replaceOnce(
      MARKPOST_SOURCE,
      'const EMAIL_DOMAIN = "in.markpost.io";',
      '',
    );

    expect(() => extractEndpointConstants(withoutEmailDomain)).toThrow(
      /EMAIL_DOMAIN/,
    );
  });
});
