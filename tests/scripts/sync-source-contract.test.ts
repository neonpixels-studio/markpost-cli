// Unit-tests the pure extraction/validation logic of
// scripts/sync-source-contract.mjs without touching the network. The
// end-to-end guard (the CLI's sourceTypes/webhookSecrets still matching
// markpost's) lives in tests/types/sources.types.test.ts; this only proves
// the self-contained-file and required-exports assertions fail loudly the
// moment they no longer hold.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertFileHasNoImports,
  assertRequiredExportsPresent,
  resolveFilesToSync,
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

  // Regression coverage: `const X = ...; export { X };` is just as valid and
  // verbatim-vendorable as an inline `export const X = ...` — it must not be
  // misreported as a dropped export.
  it('accepts a name exported via a local `export { X }` re-export', () => {
    const localReExport = SOURCE.replace(
      'export const SOURCE_TYPES',
      'const SOURCE_TYPES',
    ).concat('\n    export { SOURCE_TYPES };\n');

    expect(() =>
      assertRequiredExportsPresent(
        parse(localReExport),
        'shared/utils/sourceTypes.ts',
        ['SOURCE_TYPES'],
      ),
    ).not.toThrow();
  });

  it('does not credit a re-export of someone else’s module for a required local export', () => {
    const reExportFromElsewhere = `${SOURCE}\nexport { readFileSync } from "node:fs";\n`;

    expect(() =>
      assertRequiredExportsPresent(
        parse(reExportFromElsewhere),
        'shared/utils/sourceTypes.ts',
        ['readFileSync'],
      ),
    ).toThrow(/no longer exports: readFileSync/);
  });
});

// Exercises the "validate everything before writing anything" guarantee
// resolveFilesToSync exists for (see its comment in sync-source-contract.mjs)
// against a real checkout, rather than the vendor-directory-writing side of
// syncFrom — resolveFilesToSync itself never touches disk, so this doesn't
// risk mutating the real tests/types/vendor/ during a test run.
describe('resolveFilesToSync', () => {
  let checkoutDir: string;

  function runGit(args: string[]) {
    execFileSync('git', args, {
      cwd: checkoutDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
  }

  function writeAndCommit(relativePath: string, contents: string) {
    const absolutePath = join(checkoutDir, relativePath);

    writeFileSync(absolutePath, contents);
    runGit(['add', relativePath]);
    runGit(['commit', '--quiet', '-m', `add ${relativePath}`]);
  }

  beforeEach(() => {
    checkoutDir = mkdtempSync(join(tmpdir(), 'sync-source-contract-fixture-'));
    runGit(['init', '--quiet']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test']);
    execFileSync('mkdir', ['-p', join(checkoutDir, 'shared/utils')]);
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  it('resolves both files when both are valid', () => {
    writeAndCommit(
      'shared/utils/sourceTypes.ts',
      'export const SOURCE_TYPES = ["webhook", "email"] as const;',
    );
    writeAndCommit(
      'shared/utils/webhookSecrets.ts',
      [
        'export const MANUAL_SECRET_PROVIDER_IDS = ["stripe"] as const;',
        'export const SECRET_BACKED_PROVIDER_IDS = ["github"] as const;',
        'export const ROTATABLE_PROVIDER_IDS = ["stripe", "github"] as const;',
      ].join('\n'),
    );

    const resolvedFiles = resolveFilesToSync(checkoutDir);

    expect(resolvedFiles).toHaveLength(2);
    expect(resolvedFiles[0].sourceRelativePath).toBe(
      'shared/utils/sourceTypes.ts',
    );
    expect(resolvedFiles[1].sourceRelativePath).toBe(
      'shared/utils/webhookSecrets.ts',
    );
  });

  it('throws on the second file without returning any partial result', () => {
    writeAndCommit(
      'shared/utils/sourceTypes.ts',
      'export const SOURCE_TYPES = ["webhook", "email"] as const;',
    );
    // Gains an import, which assertFileHasNoImports rejects — this is the
    // "markpost changes the second file" failure mode the atomicity
    // guarantee protects against.
    writeAndCommit(
      'shared/utils/webhookSecrets.ts',
      [
        'import { z } from "zod";',
        'export const MANUAL_SECRET_PROVIDER_IDS = ["stripe"] as const;',
        'export const SECRET_BACKED_PROVIDER_IDS = ["github"] as const;',
        'export const ROTATABLE_PROVIDER_IDS = ["stripe", "github"] as const;',
      ].join('\n'),
    );

    let resolvedFiles;

    expect(() => {
      resolvedFiles = resolveFilesToSync(checkoutDir);
    }).toThrow(/now has an import/);
    expect(resolvedFiles).toBeUndefined();
  });
});
