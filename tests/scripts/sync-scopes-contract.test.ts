// Unit-tests the pure extraction logic of scripts/sync-scopes-contract.mjs
// without touching the network.
import { describe, expect, it } from 'vitest';

import {
  extractScopeNames,
  renderScopesFile,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-scopes-contract.mjs';

const SCOPES_SOURCE = `
type Scope = { name: string; description: string };

export const SCOPES = [
  { name: "records:read", description: "Read records." },
  { name: "tokens:write", description: "Mint tokens." },
] as const satisfies readonly Scope[];

export type ScopeName = (typeof SCOPES)[number]["name"];
`;

describe('extractScopeNames', () => {
  it('pulls each entry name in order', () => {
    expect(extractScopeNames(SCOPES_SOURCE)).toEqual([
      'records:read',
      'tokens:write',
    ]);
  });

  it('accepts a quoted name key', () => {
    expect(
      extractScopeNames('export const SCOPES = [{ "name": "a:read" }];'),
    ).toEqual(['a:read']);
  });

  it('fails loudly when SCOPES is gone', () => {
    expect(() => extractScopeNames('export const OTHER = [];')).toThrow(
      /no longer declares SCOPES/,
    );
  });

  it('fails loudly when an entry has no string-literal name', () => {
    expect(() =>
      extractScopeNames('export const SCOPES = [{ name: someVar }];'),
    ).toThrow(/without a string-literal/);
  });

  it('fails loudly on a duplicated scope name', () => {
    expect(() =>
      extractScopeNames(
        'export const SCOPES = [{ name: "a:read" }, { name: "a:read" }];',
      ),
    ).toThrow(/twice/);
  });

  it('fails loudly on an empty catalog', () => {
    expect(() => extractScopeNames('export const SCOPES = [];')).toThrow(
      /empty/,
    );
  });
});

describe('renderScopesFile', () => {
  it('renders the names as a const tuple plus a ScopeName union', () => {
    const rendered = renderScopesFile(['a:read', 'b:write']);

    expect(rendered).toContain('"a:read",');
    expect(rendered).toContain('] as const;');
    expect(rendered).toContain(
      'export type ScopeName = (typeof SCOPE_NAMES)[number];',
    );
  });
});
