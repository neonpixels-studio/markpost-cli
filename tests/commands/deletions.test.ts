import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/libs/config.js", () => ({ checkConfig: vi.fn() }));
vi.mock("#src/libs/deletions.js", () => ({
  fetchDeletionFeed: vi.fn(),
  planPrune: vi.fn(),
  applyPrune: vi.fn(),
}));
vi.mock("#src/libs/markdown.js", () => ({
  ensureOutputDirectory: vi.fn(() => "/vault"),
}));
vi.mock("#src/libs/vault-ledger.js", () => ({
  getLastDeletionSync: vi.fn(),
  setLastDeletionSync: vi.fn(),
}));
vi.mock("chalk", () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
  },
}));

const USAGE = "Usage: markpost records ...";
const NOW = new Date("2026-11-18T12:00:00Z");
const ONE_MINUTE_BEFORE_NOW = "2026-11-18T11:59:00.000Z";

const planWithOneRemoval = {
  items: [{ uuid: "u1", path: "inbox/a.md", outcome: "remove" as const }],
  untrackedCount: 2,
};

describe("records deletions", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;

    const { checkConfig } = await import("#src/libs/config.js");
    const { fetchDeletionFeed, planPrune } =
      await import("#src/libs/deletions.js");
    vi.mocked(checkConfig).mockResolvedValue(true);
    vi.mocked(fetchDeletionFeed).mockResolvedValue({
      tombstones: [
        { recordUuid: "u1", filePath: null, deletedAt: "2026-11-17T00:00:00Z" },
      ],
      complete: true,
    });
    vi.mocked(planPrune).mockReturnValue(planWithOneRemoval);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const run = async (...args: string[]) => {
    const { runDeletionsCommand } = await import("#src/commands/deletions.js");
    const json = args.includes("--json");

    await runDeletionsCommand(["deletions", ...args], json, USAGE);
  };

  it("is a dry run by default: reports, removes nothing, keeps the baseline", async () => {
    const { applyPrune } = await import("#src/libs/deletions.js");
    const { setLastDeletionSync } = await import("#src/libs/vault-ledger.js");

    await run();

    expect(applyPrune).not.toHaveBeenCalled();
    expect(setLastDeletionSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Would remove: inbox/a.md"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("re-run with --apply"),
    );
  });

  it("--apply removes the planned files and advances the baseline", async () => {
    const { applyPrune, planPrune } = await import("#src/libs/deletions.js");
    const { setLastDeletionSync } = await import("#src/libs/vault-ledger.js");

    await run("--apply");

    expect(applyPrune).toHaveBeenCalledWith(planWithOneRemoval, "/vault");
    expect(planPrune).toHaveBeenCalledWith(expect.any(Array), "/vault");
    expect(setLastDeletionSync).toHaveBeenCalledWith(ONE_MINUTE_BEFORE_NOW);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Removed: inbox/a.md"),
    );
  });

  it("does not move the baseline when --since skips past the stored one", async () => {
    const { setLastDeletionSync, getLastDeletionSync } =
      await import("#src/libs/vault-ledger.js");
    vi.mocked(getLastDeletionSync).mockReturnValue("2026-11-08T00:00:00.000Z");

    await run("--apply", "--since", "2026-11-17T00:00:00Z");

    expect(setLastDeletionSync).not.toHaveBeenCalled();
  });

  it("does not record a baseline from an explicit --since on a first run", async () => {
    const { setLastDeletionSync } = await import("#src/libs/vault-ledger.js");

    await run("--apply", "--since", "2026-11-17T00:00:00Z");

    expect(setLastDeletionSync).not.toHaveBeenCalled();
  });

  it("still advances the baseline when --since is earlier than the stored one", async () => {
    const { setLastDeletionSync, getLastDeletionSync } =
      await import("#src/libs/vault-ledger.js");
    vi.mocked(getLastDeletionSync).mockReturnValue("2026-11-08T00:00:00.000Z");

    await run("--apply", "--since", "2026-11-01T00:00:00Z");

    expect(setLastDeletionSync).toHaveBeenCalledWith(ONE_MINUTE_BEFORE_NOW);
  });

  it("rejects an impossible --since date and extra arguments", async () => {
    const { fetchDeletionFeed } = await import("#src/libs/deletions.js");

    await run("--since", "2026-13-45T99:99:00Z");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await run("stray");
    expect(process.exitCode).toBe(1);

    expect(fetchDeletionFeed).not.toHaveBeenCalled();
  });

  it("reads deletions since the last applied sync", async () => {
    const { fetchDeletionFeed } = await import("#src/libs/deletions.js");
    const { getLastDeletionSync } = await import("#src/libs/vault-ledger.js");
    vi.mocked(getLastDeletionSync).mockReturnValue("2026-11-10T00:00:00.000Z");

    await run();

    expect(fetchDeletionFeed).toHaveBeenCalledWith("2026-11-10T00:00:00.000Z");
  });

  it("--since overrides the stored baseline", async () => {
    const { fetchDeletionFeed } = await import("#src/libs/deletions.js");
    const { getLastDeletionSync } = await import("#src/libs/vault-ledger.js");
    vi.mocked(getLastDeletionSync).mockReturnValue("2026-11-10T00:00:00.000Z");

    await run("--since", "2026-11-15T00:00:00Z");

    expect(fetchDeletionFeed).toHaveBeenCalledWith("2026-11-15T00:00:00Z");
  });

  it("warns that the vault may hold stale notes when the feed is incomplete", async () => {
    const { fetchDeletionFeed } = await import("#src/libs/deletions.js");
    vi.mocked(fetchDeletionFeed).mockResolvedValue({
      tombstones: [],
      complete: false,
    });

    await run();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Deletion history is not complete"),
    );
  });

  it("does not warn when the feed is complete", async () => {
    await run();

    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not touch anything and fails loudly when the feed cannot be read", async () => {
    const { fetchDeletionFeed, applyPrune } =
      await import("#src/libs/deletions.js");
    const { setLastDeletionSync } = await import("#src/libs/vault-ledger.js");
    vi.mocked(fetchDeletionFeed).mockRejectedValue(new Error("boom"));

    await run("--apply");

    expect(applyPrune).not.toHaveBeenCalled();
    expect(setLastDeletionSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a malformed --since before any request", async () => {
    const { fetchDeletionFeed } = await import("#src/libs/deletions.js");

    await run("--since", "yesterday");

    expect(fetchDeletionFeed).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not advance the baseline when applying the prune fails", async () => {
    const { applyPrune } = await import("#src/libs/deletions.js");
    const { setLastDeletionSync } = await import("#src/libs/vault-ledger.js");
    vi.mocked(applyPrune).mockImplementation(() => {
      throw new Error("Removed 0 file(s) but could not remove: a.md");
    });

    await run("--apply");

    expect(setLastDeletionSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("--json prints the plan and completeness", async () => {
    await run("--json");

    const printed = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);

    expect(printed).toMatchObject({
      applied: false,
      complete: true,
      deletedOnServer: 1,
      untracked: 2,
      files: [{ uuid: "u1", path: "inbox/a.md", outcome: "remove" }],
    });
  });
});
