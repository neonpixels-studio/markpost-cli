// Unit-tests the pure extraction logic of scripts/sync-settings-contract.mjs
// without touching the network. The end-to-end guard (the CLI's settings
// contract still matching markpost's) lives in
// tests/types/settings.types.test.ts; this only proves the extractor pulls
// the right declaration/defaults and fails loudly when markpost renames or
// drops one.
import { describe, expect, it } from 'vitest';

import {
  extractConflictStrategiesDeclaration,
  extractUserSettingsDefaults,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/sync-settings-contract.mjs';

const RESPONSE_SOURCE = `
import type { ApiResourceObject, ApiResponse } from "../types/api.types";

export const CONFLICT_STRATEGIES = ["suffix", "overwrite", "skip"] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

type RecordAttributes = {
  uuid: string;
};
`;

// A trimmed stand-in for markpost's schema.ts: the userSettings table with
// the columns the sync script cares about, wrapped in the surrounding table
// definitions and unrelated columns it must ignore.
const SCHEMA_SOURCE = `
export const users = pgTable("users", {
  userId: text("user_id").primaryKey(),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  vaultDir: text("vault_dir").notNull().default("~/Documents/Vault"),
  autoSync: boolean("auto_sync").notNull().default(true),
  autoDelete: boolean("auto_delete").notNull().default(true),
  frontmatter: boolean("frontmatter").notNull().default(true),
  conflictStrategy: text("conflict_strategy").notNull().default("suffix"),
  theme: text("theme").notNull().default("system"),
});
`;

describe('extractConflictStrategiesDeclaration', () => {
  it('pulls the CONFLICT_STRATEGIES declaration verbatim', () => {
    const declaration = extractConflictStrategiesDeclaration(RESPONSE_SOURCE);

    expect(declaration).toContain(
      'export const CONFLICT_STRATEGIES = ["suffix", "overwrite", "skip"] as const;',
    );
  });

  it('leaves the unrelated RecordAttributes type behind', () => {
    const declaration = extractConflictStrategiesDeclaration(RESPONSE_SOURCE);

    expect(declaration).not.toContain('RecordAttributes');
  });

  it('exports the declaration even if markpost stops exporting it', () => {
    const withoutExport = RESPONSE_SOURCE.replace(
      'export const CONFLICT_STRATEGIES',
      'const CONFLICT_STRATEGIES',
    );

    expect(extractConflictStrategiesDeclaration(withoutExport)).toContain(
      'export const CONFLICT_STRATEGIES',
    );
  });

  it('throws loudly when markpost renames or removes CONFLICT_STRATEGIES', () => {
    const renamed = RESPONSE_SOURCE.replace(
      'CONFLICT_STRATEGIES',
      'SYNC_CONFLICT_STRATEGIES',
    );

    expect(() => extractConflictStrategiesDeclaration(renamed)).toThrow(
      /CONFLICT_STRATEGIES/,
    );
  });
});

describe('extractUserSettingsDefaults', () => {
  it('extracts the boolean and string defaults for the tracked columns', () => {
    expect(extractUserSettingsDefaults(SCHEMA_SOURCE)).toEqual({
      autoSync: true,
      autoDelete: true,
      frontmatter: true,
      conflictStrategy: 'suffix',
    });
  });

  it('ignores untracked columns (vaultDir, theme) and other tables (users)', () => {
    const defaults = extractUserSettingsDefaults(SCHEMA_SOURCE);

    expect(defaults).not.toHaveProperty('vaultDir');
    expect(defaults).not.toHaveProperty('theme');
  });

  it('throws loudly when the userSettings table is missing', () => {
    const withoutTable = SCHEMA_SOURCE.replace(
      'export const userSettings = pgTable("user_settings", {',
      'export const renamedSettings = pgTable("user_settings", {',
    );

    expect(() => extractUserSettingsDefaults(withoutTable)).toThrow(
      /userSettings = pgTable/,
    );
  });

  it('throws loudly when a tracked column loses its default', () => {
    const withoutDefault = SCHEMA_SOURCE.replace(
      'autoSync: boolean("auto_sync").notNull().default(true),',
      'autoSync: boolean("auto_sync").notNull(),',
    );

    expect(() => extractUserSettingsDefaults(withoutDefault)).toThrow(
      /autoSync/,
    );
  });

  it('throws loudly when a tracked column is removed entirely', () => {
    const withoutColumn = SCHEMA_SOURCE.replace(
      'conflictStrategy: text("conflict_strategy").notNull().default("suffix"),',
      '',
    );

    expect(() => extractUserSettingsDefaults(withoutColumn)).toThrow(
      /conflictStrategy/,
    );
  });

  // Regression coverage: drizzle accepts modifier calls in either order
  // (`.default(...).notNull()` as well as `.notNull().default(...)`) — the
  // extractor's recursive walk must find `.default(...)` regardless of which
  // side of `.notNull()` it lands on.
  it('finds the default when .default(...) comes before .notNull()', () => {
    const reordered = SCHEMA_SOURCE.replace(
      'autoSync: boolean("auto_sync").notNull().default(true),',
      'autoSync: boolean("auto_sync").default(true).notNull(),',
    );

    expect(extractUserSettingsDefaults(reordered).autoSync).toBe(true);
  });

  it('throws loudly when a tracked column has a non-literal default', () => {
    const nonLiteralDefault = SCHEMA_SOURCE.replace(
      'conflictStrategy: text("conflict_strategy").notNull().default("suffix"),',
      'conflictStrategy: text("conflict_strategy").notNull().default(DEFAULT_STRATEGY),',
    );

    expect(() => extractUserSettingsDefaults(nonLiteralDefault)).toThrow(
      /conflictStrategy/,
    );
  });
});
