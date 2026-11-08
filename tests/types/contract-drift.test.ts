// Guards against the vendored markpost contract
// (src/types/vendor/markpost-api.types.ts) silently drifting from what the
// CLI actually depends on. This intentionally never hits the network — the
// vendored file is refreshed by hand via `npm run sync:contract` (see
// README.md#contract-sync) and reviewed like any other diff; this test only
// checks that the *currently committed* vendored copy still exports what the
// CLI expects, and that the CLI's own source compiles against it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  assertContractIsTypeOnly,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-contract.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSCONFIG_PATH = fileURLToPath(
  new URL('../../tsconfig.json', import.meta.url),
);
const VENDOR_CONTRACT_PATH = fileURLToPath(
  new URL('../../src/types/vendor/markpost-api.types.ts', import.meta.url),
);

// The exact set of type names the CLI's own types (records.types.ts,
// sources.types.ts, api.types.ts) import from the vendored contract
// (`ApiRequest` is intentionally excluded — see the comment in
// src/types/api.types.ts). This is a fast, specific check; the full-project
// compile below is what actually proves the CLI's usage still works,
// including cases (a renamed export becoming an interface, a re-export)
// this name list wouldn't catch on its own.
const EXPECTED_VENDORED_EXPORTS = [
  'ApiError',
  'ApiResourceObject',
  'ApiResponse',
];

// Covers both `export type Foo = ...` and `export interface Foo { ... }` —
// markpost could reasonably switch between the two without changing the
// CLI's usage at all, and this check shouldn't raise a false alarm if it does.
function exportedTypeNames(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'markpost-api.types.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  const names: string[] = [];

  sourceFile.forEachChild((node) => {
    if (isExportedTypeAlias(node) || isExportedInterface(node)) {
      names.push(node.name.text);
    }
  });

  return names;
}

function isExported(node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): boolean {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function isExportedTypeAlias(node: ts.Node): node is ts.TypeAliasDeclaration {
  return ts.isTypeAliasDeclaration(node) && isExported(node);
}

function isExportedInterface(node: ts.Node): node is ts.InterfaceDeclaration {
  return ts.isInterfaceDeclaration(node) && isExported(node);
}

function parseProjectConfig(): ts.ParsedCommandLine {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);

  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    REPO_ROOT,
  );

  if (parsedConfig.errors.length > 0) {
    throw new Error(formatDiagnostics(parsedConfig.errors));
  }

  // A tsconfig whose `include` stops matching anything (directory rename,
  // `rootDir` change) would make `ts.createProgram([])` report zero
  // diagnostics and this test would pass having checked nothing — exactly
  // the failure mode this check exists to prevent.
  if (parsedConfig.fileNames.length === 0) {
    throw new Error(
      `${TSCONFIG_PATH} matched no files — the drift check would pass vacuously`,
    );
  }

  return parsedConfig;
}

// Compiles the CLI's actual `src/` — the same file set `npm run build`
// compiles — rather than a hand-written stand-in fixture, so this test
// fails on exactly the same drift a real build would catch, without
// depending on running a full build.
function compileProjectDiagnostics(): readonly ts.Diagnostic[] {
  const parsedConfig = parseProjectConfig();
  const program = ts.createProgram(parsedConfig.fileNames, {
    ...parsedConfig.options,
    noEmit: true,
  });

  return ts.getPreEmitDiagnostics(program);
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => '\n',
  });
}

describe('markpost contract drift', () => {
  it('the vendored contract still exports what the CLI depends on', () => {
    const vendorSource = readFileSync(VENDOR_CONTRACT_PATH, 'utf-8');
    const actualExports = exportedTypeNames(vendorSource);

    expect(actualExports).toEqual(
      expect.arrayContaining(EXPECTED_VENDORED_EXPORTS),
    );
  });

  // `assertContractIsTypeOnly` only actually guards the CLI's shipped `dist`
  // if it's checked against the file that ships, not just synthetic strings
  // in tests/scripts/sync-contract.test.ts — a hand-edit, a bad merge, or a
  // copy vendored before this guard existed would otherwise put executable
  // code into the published CLI with only a human diff read to catch it.
  it('the committed vendored contract contains no runtime statements', () => {
    const vendorSource = readFileSync(VENDOR_CONTRACT_PATH, 'utf-8');

    expect(() => assertContractIsTypeOnly(vendorSource)).not.toThrow();
  });

  // A full-project compile is slower than vitest's 5s default test timeout,
  // especially on a cold CI runner; give it real headroom instead of an
  // intermittent timeout failure.
  const COMPILE_TEST_TIMEOUT_MS = 30_000;

  it(
    "the CLI's own source compiles against the vendored contract",
    () => {
      const diagnostics = compileProjectDiagnostics();

      expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
    },
    COMPILE_TEST_TIMEOUT_MS,
  );
});
