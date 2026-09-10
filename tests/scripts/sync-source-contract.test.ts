// Unit-tests the pure extraction/validation logic of
// scripts/sync-source-contract.mjs without touching the network. The
// end-to-end guard (the CLI's sourceTypes/webhookSecrets still matching
// markpost's) lives in tests/types/sources.types.test.ts; this only proves
// the self-contained-file and required-exports assertions fail loudly the
// moment they no longer hold.
import { describe, expect, it } from 'vitest';

import {
  assertFileHasNoImports,
  assertRequiredExportsPresent,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-source-contract.mjs';
import {
  parseTypeScriptSource,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/lib/markpost-checkout.mjs';

describe('assertFileHasNoImports', () => {
  it('accepts a file with no import statements', () => {
    const sourceFile = parseTypeScriptSource(
      'shared/utils/sourceTypes.ts',
      `export const SOURCE_TYPES = ["webhook", "email"] as const;`,
    );

    expect(() =>
      assertFileHasNoImports(sourceFile, 'shared/utils/sourceTypes.ts'),
    ).not.toThrow();
  });

  it('throws when the file has gained an import', () => {
    const sourceFile = parseTypeScriptSource(
      'shared/utils/sourceTypes.ts',
      `import { z } from "zod";\nexport const SOURCE_TYPES = ["webhook"] as const;`,
    );

    expect(() =>
      assertFileHasNoImports(sourceFile, 'shared/utils/sourceTypes.ts'),
    ).toThrow(/now has an import/);
  });

  it('throws even for a type-only import', () => {
    const sourceFile = parseTypeScriptSource(
      'shared/utils/webhookSecrets.ts',
      `import type { Foo } from "./foo";\nexport const SOURCE_TYPES = ["webhook"] as const;`,
    );

    expect(() =>
      assertFileHasNoImports(sourceFile, 'shared/utils/webhookSecrets.ts'),
    ).toThrow(/now has an import/);
  });

  it('includes the offending file path in the error', () => {
    const sourceFile = parseTypeScriptSource(
      'shared/utils/webhookSecrets.ts',
      `import "side-effect";`,
    );

    expect(() =>
      assertFileHasNoImports(sourceFile, 'shared/utils/webhookSecrets.ts'),
    ).toThrow(/shared\/utils\/webhookSecrets\.ts/);
  });
});

describe('assertRequiredExportsPresent', () => {
  const SOURCE = `
    export const SOURCE_TYPES = ["webhook", "email"] as const;
    export type SourceType = (typeof SOURCE_TYPES)[number];
    export function isSourceType(value: string): boolean {
      return true;
    }
  `;

  function parse(source: string) {
    return parseTypeScriptSource('shared/utils/sourceTypes.ts', source);
  }

  it('accepts a file that exports every required name', () => {
    expect(() =>
      assertRequiredExportsPresent(
        parse(SOURCE),
        'shared/utils/sourceTypes.ts',
        ['SOURCE_TYPES'],
      ),
    ).not.toThrow();
  });

  it('accepts an exported function or type alias, not just const', () => {
    expect(() =>
      assertRequiredExportsPresent(
        parse(SOURCE),
        'shared/utils/sourceTypes.ts',
        ['SourceType', 'isSourceType'],
      ),
    ).not.toThrow();
  });

  it('throws loudly when a required export is renamed or removed', () => {
    const renamed = SOURCE.replace('SOURCE_TYPES', 'SUPPORTED_SOURCE_TYPES');

    expect(() =>
      assertRequiredExportsPresent(
        parse(renamed),
        'shared/utils/sourceTypes.ts',
        ['SOURCE_TYPES'],
      ),
    ).toThrow(/no longer exports: SOURCE_TYPES/);
  });

  it('names every missing export, not just the first', () => {
    expect(() =>
      assertRequiredExportsPresent(
        parse(SOURCE),
        'shared/utils/webhookSecrets.ts',
        ['MANUAL_SECRET_PROVIDER_IDS', 'ROTATABLE_PROVIDER_IDS'],
      ),
    ).toThrow(/MANUAL_SECRET_PROVIDER_IDS, ROTATABLE_PROVIDER_IDS/);
  });

  it('ignores an export that is not exported (no export keyword)', () => {
    const notExported = SOURCE.replace(
      'export const SOURCE_TYPES',
      'const SOURCE_TYPES',
    );

    expect(() =>
      assertRequiredExportsPresent(
        parse(notExported),
        'shared/utils/sourceTypes.ts',
        ['SOURCE_TYPES'],
      ),
    ).toThrow(/no longer exports: SOURCE_TYPES/);
  });
});
