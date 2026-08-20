// Guards the CLI's hand-mirrored frontmatter serialization
// (src/libs/frontmatter.ts) against silent drift from markpost's real
// `server/utils/markdown.ts`. Unlike frontmatter.test.ts, whose expected
// strings are hand-transcribed (and would drift right alongside the mirror if
// markpost changed), this runs markpost's *actual* serialization functions —
// vendored verbatim into markpost-markdown-serialization.generated.ts by
// `npm run sync:markdown-serialization` — against the CLI's copy over a shared
// battery of inputs and fails the moment the two produce different bytes.
//
// It never hits the network: the vendored slice is refreshed by hand and
// reviewed like any other diff (see README.md#markdown-serialization-sync).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assembleMarkdownDocument as cliAssembleMarkdownDocument,
  serializeFrontmatter as cliSerializeFrontmatter,
} from '@/libs/frontmatter.js';
import { Frontmatter } from '@/types/records.types.js';

import {
  assembleMarkdownDocument as markpostAssembleMarkdownDocument,
  serializeFrontmatter as markpostSerializeFrontmatter,
  FrontmatterObject,
} from './vendor/markpost-markdown-serialization.generated.js';
import manifest from './vendor/markpost-markdown-serialization.manifest.json' with { type: 'json' };

const VENDOR_SLICE_PATH = fileURLToPath(
  new URL('./vendor/markpost-markdown-serialization.generated.ts', import.meta.url),
);

// The CLI's `Frontmatter` and markpost's `FrontmatterObject` are structurally
// identical; this alias just documents that a single case object feeds both
// implementations, so a divergence can only come from the serialization, never
// from the inputs being subtly different.
type SerializationCase = {
  name: string;
  frontmatter: Frontmatter & FrontmatterObject;
  body: string;
};

const BASE_CREATED = '2026-06-14T09:41:02Z';

// Each case pins one behavior of `quoteYamlScalar` / `serializeTagsLine`: the
// no-quote path, empty vs many tags, every YAML metacharacter that forces
// quoting, whitespace trimming, and backslash/quote/newline escaping. A change
// to markpost's quoting rules moves at least one of these and trips the test.
const SERIALIZATION_CASES: SerializationCase[] = [
  {
    name: 'plain values need no quoting',
    frontmatter: {
      title: 'Production deploy succeeded',
      source: 'webhook/github',
      created: BASE_CREATED,
      tags: ['ci', 'deploy', 'incoming'],
    },
    body: 'Commit a1f9c20 shipped to prod.',
  },
  {
    name: 'empty tags serialize as an empty array',
    frontmatter: {
      title: 'No tags here',
      source: 'webhook',
      created: BASE_CREATED,
      tags: [],
    },
    body: 'Body without tags.',
  },
  {
    name: 'a colon in the title forces quoting',
    frontmatter: {
      title: 'Deploy: success',
      source: 'webhook',
      created: BASE_CREATED,
      tags: [],
    },
    body: 'Colon in title.',
  },
  {
    name: 'each YAML metacharacter forces quoting',
    frontmatter: {
      title: 'chars #[]{}&!|>%@`, and more',
      source: "single ' and double \" quote",
      created: BASE_CREATED,
      tags: ['a,b', 'a]b', 'c#d'],
    },
    body: 'Special characters everywhere.',
  },
  {
    name: 'leading and trailing whitespace forces quoting',
    frontmatter: {
      title: ' leading and trailing ',
      source: 'webhook',
      created: BASE_CREATED,
      tags: ['  padded  '],
    },
    body: 'Whitespace preserved via quoting.',
  },
  {
    name: 'backslash, quote, and newline are escaped',
    frontmatter: {
      title: 'path C:\\temp and a "quote"\nmalicious: true',
      source: 'webhook',
      created: BASE_CREATED,
      tags: ['tag\nwith newline'],
    },
    body: 'Escaping keeps the block a single logical line.',
  },
  {
    name: 'a multi-line body is placed verbatim after the heading',
    frontmatter: {
      title: 'Multi-line body',
      source: 'webhook',
      created: BASE_CREATED,
      tags: ['notes'],
    },
    body: 'First paragraph.\n\nSecond paragraph.\n\n- item one\n- item two',
  },
  {
    name: 'an empty body still produces the heading block',
    frontmatter: {
      title: 'Empty body',
      source: 'webhook',
      created: BASE_CREATED,
      tags: [],
    },
    body: '',
  },
];

// markpost's `assembleMarkdownDocument` takes a full `ParsedPayload`; the CLI's
// takes only the fields it needs. Build each from the same case so the only
// thing that can differ is the serialization itself.
function markpostDocument(serializationCase: SerializationCase): string {
  return markpostAssembleMarkdownDocument({
    title: serializationCase.frontmatter.title,
    body: serializationCase.body,
    frontmatter: serializationCase.frontmatter,
    tags: serializationCase.frontmatter.tags,
    filePath: 'ignored-by-assembly',
  });
}

function cliDocument(serializationCase: SerializationCase): string {
  return cliAssembleMarkdownDocument({
    title: serializationCase.frontmatter.title,
    body: serializationCase.body,
    frontmatter: serializationCase.frontmatter,
  });
}

describe('frontmatter serialization drift', () => {
  it('the vendored markpost slice is present and records its provenance', () => {
    expect(existsSync(VENDOR_SLICE_PATH)).toBe(true);
    expect(manifest.sourceFile).toBe('server/utils/markdown.ts');
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(SERIALIZATION_CASES)(
    'serializeFrontmatter matches markpost byte-for-byte: $name',
    (serializationCase) => {
      const cliOutput = cliSerializeFrontmatter(serializationCase.frontmatter);
      const markpostOutput = markpostSerializeFrontmatter(
        serializationCase.frontmatter,
      );

      expect(cliOutput).toBe(markpostOutput);
    },
  );

  it.each(SERIALIZATION_CASES)(
    'assembleMarkdownDocument matches markpost byte-for-byte: $name',
    (serializationCase) => {
      expect(cliDocument(serializationCase)).toBe(
        markpostDocument(serializationCase),
      );
    },
  );
});
