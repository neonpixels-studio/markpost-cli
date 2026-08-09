import { describe, expect, it } from 'vitest';

import {
  assembleMarkdownDocument,
  buildRecordDocument,
  serializeFrontmatter,
  stripFrontmatterDocument,
} from '@/libs/frontmatter.js';
import { Frontmatter, Record } from '@/types/records.types.js';

const frontmatter: Frontmatter = {
  title: 'Production deploy succeeded',
  source: 'webhook/github',
  created: '2026-06-14T09:41:02Z',
  tags: ['ci', 'deploy', 'incoming'],
};

const recordWithFrontmatter: Record = {
  uuid: 'abc-123',
  createdAt: '2026-06-14T09:41:02Z',
  title: 'Production deploy succeeded',
  content: 'Commit a1f9c20 shipped to prod.',
  source: 'webhook/github',
  tags: ['ci', 'deploy', 'incoming'],
  frontmatter,
};

// Byte-for-byte match against markpost's serializeFrontmatter output
// (tests/server/utils/markdown.test.ts). If the mirror drifts, this fails.
describe('serializeFrontmatter', () => {
  it('serializes a frontmatter object to a YAML block matching markpost', () => {
    expect(serializeFrontmatter(frontmatter)).toBe(
      '---\ntitle: Production deploy succeeded\nsource: webhook/github\ncreated: 2026-06-14T09:41:02Z\ntags: [ci, deploy, incoming]\n---',
    );
  });

  it('serializes empty tags as an empty array', () => {
    const result = serializeFrontmatter({ ...frontmatter, tags: [] });
    expect(result).toContain('tags: []');
  });

  it('quotes a title containing a colon to prevent YAML parsing errors', () => {
    const result = serializeFrontmatter({
      ...frontmatter,
      title: 'Deploy: success',
      tags: [],
    });
    expect(result).toContain('title: "Deploy: success"');
  });

  it('escapes a newline in a title so it cannot inject a new frontmatter key', () => {
    const result = serializeFrontmatter({
      ...frontmatter,
      title: 'title\nmalicious: true',
      tags: [],
    });

    expect(result).toContain('\\n');
    const lines = result.split('\n');
    expect(lines.every((line) => !line.startsWith('malicious:'))).toBe(true);
  });

  it('quotes a tag containing a comma', () => {
    const result = serializeFrontmatter({ ...frontmatter, tags: ['a,b'] });
    expect(result).toContain('"a,b"');
  });

  it('quotes a tag containing a closing bracket', () => {
    const result = serializeFrontmatter({ ...frontmatter, tags: ['a]b'] });
    expect(result).toContain('"a]b"');
  });

  it('quotes a value with trailing whitespace so YAML does not strip it', () => {
    const result = serializeFrontmatter({
      ...frontmatter,
      title: 'trailing space ',
      tags: [],
    });
    expect(result).toContain('"trailing space "');
  });
});

describe('assembleMarkdownDocument', () => {
  it('places the frontmatter block before the title heading, then the body', () => {
    const result = assembleMarkdownDocument({
      title: 'My Note',
      body: 'Content here.',
      frontmatter: { ...frontmatter, title: 'My Note', tags: [] },
    });

    const frontmatterEnd = result.indexOf('---\n\n');
    expect(frontmatterEnd).toBeGreaterThan(-1);
    expect(result.indexOf('# My Note')).toBeGreaterThan(frontmatterEnd);
    expect(result.indexOf('Content here.')).toBeGreaterThan(
      result.indexOf('# My Note'),
    );
  });

  it('produces the exact document markpost would write', () => {
    const result = assembleMarkdownDocument({
      title: 'Production deploy succeeded',
      body: 'Commit a1f9c20 shipped to prod.',
      frontmatter,
    });

    expect(result).toBe(
      '---\n' +
        'title: Production deploy succeeded\n' +
        'source: webhook/github\n' +
        'created: 2026-06-14T09:41:02Z\n' +
        'tags: [ci, deploy, incoming]\n' +
        '---\n\n' +
        '# Production deploy succeeded\n\n' +
        'Commit a1f9c20 shipped to prod.',
    );
  });
});

describe('buildRecordDocument', () => {
  it('assembles frontmatter, title, and source metadata for a synced record', () => {
    const result = buildRecordDocument(recordWithFrontmatter);

    expect(result).toContain('title: Production deploy succeeded');
    expect(result).toContain('source: webhook/github');
    expect(result).toContain('# Production deploy succeeded');
    expect(result).toContain('Commit a1f9c20 shipped to prod.');
  });

  it('includes tags from the frontmatter object', () => {
    const result = buildRecordDocument(recordWithFrontmatter);
    expect(result).toContain('tags: [ci, deploy, incoming]');
  });

  it('omits the frontmatter block and returns bare content when frontmatter is disabled', () => {
    const result = buildRecordDocument(recordWithFrontmatter, false);

    expect(result).toBe('Commit a1f9c20 shipped to prod.');
    expect(result).not.toContain('---');
    expect(result).not.toContain('title: Production deploy succeeded');
    expect(result).not.toContain('# Production deploy succeeded');
  });

  it('includes the frontmatter block when frontmatter is enabled explicitly', () => {
    const result = buildRecordDocument(recordWithFrontmatter, true);

    expect(result).toContain('title: Production deploy succeeded');
    expect(result).toContain('# Production deploy succeeded');
  });

  it('returns bare content when the record has no frontmatter metadata', () => {
    const bareRecord: Record = {
      uuid: 'abc-123',
      createdAt: '2026-06-14T09:41:02Z',
      title: 'Pushed note',
      content: 'Just some text.',
    };

    expect(buildRecordDocument(bareRecord)).toBe('Just some text.');
  });

  it('falls back to the record title and createdAt when frontmatter fields are missing', () => {
    const partialRecord = {
      uuid: 'abc-123',
      createdAt: '2026-01-01T00:00:00Z',
      title: 'Fallback Title',
      content: 'Body.',
      frontmatter: { source: 'webhook' },
    } as unknown as Record;

    const result = buildRecordDocument(partialRecord);

    expect(result).toContain('title: Fallback Title');
    expect(result).toContain('created: 2026-01-01T00:00:00Z');
    expect(result).toContain('tags: []');
    expect(result).toContain('# Fallback Title');
  });

  it('uses the frontmatter title for the heading when it differs from the record title', () => {
    const renamedRecord: Record = {
      ...recordWithFrontmatter,
      title: 'stale-column-title',
      frontmatter: { ...frontmatter, title: 'Canonical Title' },
    };

    const result = buildRecordDocument(renamedRecord);

    expect(result).toContain('title: Canonical Title');
    expect(result).toContain('# Canonical Title');
    expect(result).not.toContain('stale-column-title');
  });

  it('falls back to createdAt and never injects keys from a malformed created value', () => {
    const injectedRecord = {
      uuid: 'abc-123',
      createdAt: '2026-01-01T00:00:00Z',
      title: 'Note',
      content: 'Body.',
      frontmatter: { ...frontmatter, created: 'x\nmalicious: true' },
    } as unknown as Record;

    const result = buildRecordDocument(injectedRecord);

    expect(result).toContain('created: 2026-01-01T00:00:00Z');
    const lines = result.split('\n');
    expect(lines.every((line) => !line.startsWith('malicious:'))).toBe(true);
  });

  it('drops non-string tag elements rather than writing them into the YAML array', () => {
    const mixedTagsRecord = {
      ...recordWithFrontmatter,
      frontmatter: { ...frontmatter, tags: ['ci', 42, 'deploy'] },
    } as unknown as Record;

    expect(buildRecordDocument(mixedTagsRecord)).toContain('tags: [ci, deploy]');
  });

  it('treats a non-object frontmatter value as no metadata', () => {
    const malformedRecord = {
      uuid: 'abc-123',
      createdAt: '2026-01-01T00:00:00Z',
      title: 'Note',
      content: 'Raw body.',
      frontmatter: 'not-an-object',
    } as unknown as Record;

    expect(buildRecordDocument(malformedRecord)).toBe('Raw body.');
  });
});

describe('stripFrontmatterDocument', () => {
  it('strips the frontmatter block and mirrored heading, leaving only the body', () => {
    const document = assembleMarkdownDocument({
      title: 'Production deploy succeeded',
      body: 'Commit a1f9c20 shipped to prod.',
      frontmatter,
    });

    expect(stripFrontmatterDocument(document)).toBe(
      'Commit a1f9c20 shipped to prod.',
    );
  });

  it('round-trips a synced record so pushing it back sends only the body (no double-wrap)', () => {
    const document = buildRecordDocument(recordWithFrontmatter);

    expect(stripFrontmatterDocument(document)).toBe(
      recordWithFrontmatter.content,
    );
  });

  it('preserves a body that itself contains blank lines and a horizontal rule', () => {
    const body = 'First paragraph.\n\nSecond paragraph.\n\n---\n\nAfter a rule.';
    const document = assembleMarkdownDocument({
      title: 'My Note',
      body,
      frontmatter: { ...frontmatter, title: 'My Note' },
    });

    expect(stripFrontmatterDocument(document)).toBe(body);
  });

  it('returns bare content with no frontmatter unchanged', () => {
    expect(stripFrontmatterDocument('Just some text.')).toBe('Just some text.');
  });

  it('leaves a user note that starts with a heading but has no frontmatter untouched', () => {
    const note = '# A real heading\n\nBody the user wrote themselves.';

    expect(stripFrontmatterDocument(note)).toBe(note);
  });

  it('returns content unchanged when the frontmatter block is never closed', () => {
    const malformed = '---\ntitle: Broken\nno closing delimiter here';

    expect(stripFrontmatterDocument(malformed)).toBe(malformed);
  });

  it('still strips a CRLF-re-saved pulled file, returning the body LF-normalized', () => {
    const document = assembleMarkdownDocument({
      title: 'Deploy',
      body: 'First line.\n\nSecond line.',
      frontmatter: { ...frontmatter, title: 'Deploy' },
    }).replace(/\n/g, '\r\n');

    // Only the exact markpost structure is reversed; a stripped body comes
    // back LF-normalized (the file was a markpost LF document to begin with).
    expect(stripFrontmatterDocument(document)).toBe(
      'First line.\n\nSecond line.',
    );
  });

  it('still strips when the pulled file carries a leading UTF-8 BOM', () => {
    const document =
      '\uFEFF' +
      assembleMarkdownDocument({
        title: 'Deploy',
        body: 'Commit shipped.',
        frontmatter: { ...frontmatter, title: 'Deploy' },
      });

    expect(stripFrontmatterDocument(document)).toBe('Commit shipped.');
  });

  it('leaves a prose file whose opening looks like a thematic break untouched', () => {
    const prose = '---\nJust an opening line, not YAML.\n---\n\nReal body.';

    expect(stripFrontmatterDocument(prose)).toBe(prose);
  });

  it('leaves the whole note untouched when the heading is not the mirrored title', () => {
    const document =
      '---\n' +
      'title: Runbook\n' +
      'source: manual\n' +
      'created: 2026-06-14T09:41:02Z\n' +
      'tags: []\n' +
      '---\n\n' +
      '# Prerequisites\n\n' +
      'Install the CLI first.';

    // Block keys match, but the heading is the user's own section title, not
    // the record title — so this is not a markpost-composed document and the
    // block must not be stripped (leave it whole rather than lose metadata).
    expect(stripFrontmatterDocument(document)).toBe(document);
  });

  it('strips the mirrored heading even when the title needs YAML quoting', () => {
    const quotedTitleRecord: Record = {
      ...recordWithFrontmatter,
      title: 'Deploy: prod #2',
      content: 'Body intact.',
      frontmatter: { ...frontmatter, title: 'Deploy: prod #2' },
    };
    const document = buildRecordDocument(quotedTitleRecord);

    expect(stripFrontmatterDocument(document)).toBe('Body intact.');
  });

  it('returns an empty body when a synced record had no content', () => {
    const document = assembleMarkdownDocument({
      title: 'Heading only',
      body: '',
      frontmatter: { ...frontmatter, title: 'Heading only' },
    });

    expect(stripFrontmatterDocument(document)).toBe('');
  });

  it('leaves an empty (non-markpost) frontmatter block untouched', () => {
    const document = '---\n---\n\n# Title\n\nBody.';

    expect(stripFrontmatterDocument(document)).toBe(document);
  });

  it('leaves a note whose own frontmatter uses non-markpost keys untouched', () => {
    const note =
      '---\n' +
      'aliases: [x]\n' +
      'author: Jane\n' +
      '---\n\n' +
      '# My heading\n\n' +
      'Body the user wrote.';

    expect(stripFrontmatterDocument(note)).toBe(note);
  });

  it('strips a mirrored heading with no blank line after it (editor-trimmed empty body)', () => {
    const document =
      '---\n' +
      'title: Heading only\n' +
      'source: webhook/github\n' +
      'created: 2026-06-14T09:41:02Z\n' +
      'tags: []\n' +
      '---\n\n' +
      '# Heading only';

    expect(stripFrontmatterDocument(document)).toBe('');
  });

  it('strips the mirrored heading when the title spans multiple lines', () => {
    const multilineTitleRecord: Record = {
      ...recordWithFrontmatter,
      title: 'Deploy\nprod',
      content: 'Body intact.',
      frontmatter: { ...frontmatter, title: 'Deploy\nprod' },
    };
    const document = buildRecordDocument(multilineTitleRecord);

    expect(stripFrontmatterDocument(document)).toBe('Body intact.');
  });

  it('leaves the note untouched when the heading only starts with the record title', () => {
    const document =
      '---\n' +
      'title: Deploy\n' +
      'source: webhook/github\n' +
      'created: 2026-06-14T09:41:02Z\n' +
      'tags: []\n' +
      '---\n\n' +
      '# Deployment notes\n\n' +
      'Body.';

    // `# Deployment notes` is not the `# Deploy` heading markpost would write,
    // so the document is left whole rather than stripped.
    expect(stripFrontmatterDocument(document)).toBe(document);
  });

  it('leaves a hand-authored block with the markpost keys but a typed date untouched', () => {
    const note =
      '---\n' +
      'title: My note\n' +
      'source: personal\n' +
      'created: yesterday\n' +
      'tags: []\n' +
      '---\n\n' +
      '# My note\n\n' +
      'Body.';

    expect(stripFrontmatterDocument(note)).toBe(note);
  });

  it('strips the mirrored heading when the title contains a carriage return', () => {
    const carriageReturnTitleRecord: Record = {
      ...recordWithFrontmatter,
      title: 'Deploy\r\nprod',
      content: 'Body intact.',
      frontmatter: { ...frontmatter, title: 'Deploy\r\nprod' },
    };
    const document = buildRecordDocument(carriageReturnTitleRecord);

    expect(stripFrontmatterDocument(document)).toBe('Body intact.');
  });
});
