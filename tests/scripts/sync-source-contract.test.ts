// Unit-tests the pure extraction/validation logic of
// scripts/sync-source-contract.mjs without touching the network. The
// end-to-end guard (the CLI's sourceTypes/webhookSecrets still matching
// markpost's) lives in tests/types/sources.types.test.ts; this only proves
// the self-contained-file assertion fails loudly the moment it no longer
// holds.
import { describe, expect, it } from 'vitest';

import {
  assertFileHasNoImports,
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
