// Unit-tests the pure extraction logic of
// scripts/sync-markdown-serialization.mjs without touching the network. The
// end-to-end guard (the CLI's output still matching markpost's) lives in
// tests/libs/frontmatter-drift.test.ts; this only proves the extractor pulls
// the right slice and fails loudly when markpost drops part of it.
import { describe, expect, it } from 'vitest';

import {
  extractSerializationSlice,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-markdown-serialization.mjs';

// A trimmed stand-in for markpost's markdown.ts: the serialization slice the
// extractor must pull, wrapped in the surrounding server-only noise it must
// ignore (a turndown import, an unrelated exported function).
const MARKPOST_SOURCE = `
import TurndownService from "turndown";

const turndown = new TurndownService({});

export type FrontmatterObject = {
  title: string;
  source: string;
  created: string;
  tags: string[];
};

export type ParsedPayload = {
  title: string;
  body: string;
  frontmatter: FrontmatterObject;
  tags: string[];
  filePath: string;
};

export function convertHtmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

function quoteYamlScalar(value: string): string {
  return value.trim() === value ? value : '"' + value + '"';
}

function serializeTagsLine(tags: string[]): string {
  return tags.length === 0 ? "tags: []" : "tags: [" + tags.join(", ") + "]";
}

export function serializeFrontmatter(frontmatter: FrontmatterObject): string {
  return ["---", serializeTagsLine(frontmatter.tags), "---"].join("\\n");
}

export function assembleMarkdownDocument(parsedPayload: ParsedPayload): string {
  return serializeFrontmatter(parsedPayload.frontmatter);
}
`;

describe('extractSerializationSlice', () => {
  it('pulls the serialization functions and their types', () => {
    const slice = extractSerializationSlice(MARKPOST_SOURCE);

    expect(slice).toContain('function quoteYamlScalar');
    expect(slice).toContain('function serializeTagsLine');
    expect(slice).toContain('export function serializeFrontmatter');
    expect(slice).toContain('export function assembleMarkdownDocument');
    expect(slice).toContain('type FrontmatterObject');
    expect(slice).toContain('type ParsedPayload');
  });

  it('leaves the turndown-dependent server code behind', () => {
    const slice = extractSerializationSlice(MARKPOST_SOURCE);

    expect(slice).not.toContain('TurndownService');
    expect(slice).not.toContain('convertHtmlToMarkdown');
  });

  it('exports serializeFrontmatter even if markpost stops exporting it', () => {
    const withoutExport = MARKPOST_SOURCE.replace(
      'export function serializeFrontmatter',
      'function serializeFrontmatter',
    );

    const slice = extractSerializationSlice(withoutExport);

    expect(slice).toContain('export function serializeFrontmatter');
  });

  it('throws loudly when markpost drops a serialization function', () => {
    const withoutQuoter = MARKPOST_SOURCE.replace(
      'function quoteYamlScalar',
      'function renamedQuoter',
    );

    expect(() => extractSerializationSlice(withoutQuoter)).toThrow(
      /quoteYamlScalar/,
    );
  });
});
