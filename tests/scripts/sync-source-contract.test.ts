// Unit-tests the pure extraction/validation logic of
// scripts/sync-source-contract.mjs without touching the network. The
// end-to-end guard (the CLI's sourceTypes/webhookSecrets still matching
// markpost's) lives in tests/types/sources.types.test.ts; this only proves
// the self-contained-file assertion fails loudly the moment it no longer
// holds.
import { describe, expect, it } from 'vitest';

import {
  assertFileHasNoImports,
  assertRequiredExportsPresent,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-source-contract.mjs';

describe('assertFileHasNoImports', () => {
  it('accepts a file with no import statements', () => {
    expect(() =>
      assertFileHasNoImports(
        `export const SOURCE_TYPES = ["webhook", "email"] as const;`,
        'shared/utils/sourceTypes.ts',
      ),
    ).not.toThrow();
  });

  it('throws when the file has gained an import', () => {
    expect(() =>
      assertFileHasNoImports(
        `import { z } from "zod";\nexport const SOURCE_TYPES = ["webhook"] as const;`,
        'shared/utils/sourceTypes.ts',
      ),
    ).toThrow(/now has an import/);
  });

  it('throws even for a type-only import', () => {
    expect(() =>
      assertFileHasNoImports(
        `import type { Foo } from "./foo";\nexport const SOURCE_TYPES = ["webhook"] as const;`,
        'shared/utils/webhookSecrets.ts',
      ),
    ).toThrow(/now has an import/);
  });

  it('includes the offending file path in the error', () => {
    expect(() =>
      assertFileHasNoImports(
        `import "side-effect";`,
        'shared/utils/webhookSecrets.ts',
      ),
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

  it('accepts a file that exports every required name', () => {
    expect(() =>
      assertRequiredExportsPresent(SOURCE, 'shared/utils/sourceTypes.ts', [
        'SOURCE_TYPES',
      ]),
    ).not.toThrow();
  });

  it('accepts an exported function or type alias, not just const', () => {
    expect(() =>
      assertRequiredExportsPresent(SOURCE, 'shared/utils/sourceTypes.ts', [
        'SourceType',
        'isSourceType',
      ]),
    ).not.toThrow();
  });

  it('throws loudly when a required export is renamed or removed', () => {
    const renamed = SOURCE.replace('SOURCE_TYPES', 'SUPPORTED_SOURCE_TYPES');

    expect(() =>
      assertRequiredExportsPresent(renamed, 'shared/utils/sourceTypes.ts', [
        'SOURCE_TYPES',
      ]),
    ).toThrow(/no longer exports: SOURCE_TYPES/);
  });

  it('names every missing export, not just the first', () => {
    expect(() =>
      assertRequiredExportsPresent(SOURCE, 'shared/utils/webhookSecrets.ts', [
        'MANUAL_SECRET_PROVIDER_IDS',
        'ROTATABLE_PROVIDER_IDS',
      ]),
    ).toThrow(/MANUAL_SECRET_PROVIDER_IDS, ROTATABLE_PROVIDER_IDS/);
  });

  it('ignores an export that is not exported (no export keyword)', () => {
    const notExported = SOURCE.replace(
      'export const SOURCE_TYPES',
      'const SOURCE_TYPES',
    );

    expect(() =>
      assertRequiredExportsPresent(notExported, 'shared/utils/sourceTypes.ts', [
        'SOURCE_TYPES',
      ]),
    ).toThrow(/no longer exports: SOURCE_TYPES/);
  });
});
