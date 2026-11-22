// The dependency-audit job must go through the allowlist-aware script, and
// every allowlisted advisory must stay pinned to one install path.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_URL = new URL(
  "../../.github/workflows/security.yml",
  import.meta.url,
);
const ENTRY_PATTERN = /^\s+"(GHSA-[\w-]+@node_modules\/[^"]+)"/gm;
const REPO_ROOT_URL = new URL("../../", import.meta.url);
const SCRIPT_PATH = ".github/scripts/audit.sh";
const SCRIPT_URL = new URL(SCRIPT_PATH, REPO_ROOT_URL);
const GIT_EXECUTABLE_MODE = "100755";

describe("dependency-audit gate", () => {
  it("runs the allowlist-aware script in the workflow", () => {
    const workflow = readFileSync(WORKFLOW_URL, "utf8");

    expect(workflow).toContain("run: .github/scripts/audit.sh");
    expect(workflow).not.toMatch(/run:\s*npm audit --audit-level=high/);
  });

  it("keeps the script executable", () => {
    // The git index mode is platform independent; Windows checkouts have no fs exec bit.
    const indexEntry = execFileSync(
      "git",
      ["ls-files", "-s", "--error-unmatch", SCRIPT_PATH],
      {
        cwd: fileURLToPath(REPO_ROOT_URL),
        encoding: "utf8",
      },
    );

    expect(indexEntry.split(" ")[0]).toBe(GIT_EXECUTABLE_MODE);
  });

  it("only allowlists picomatch GHSA-fc5q at its single install path", () => {
    const script = readFileSync(SCRIPT_URL, "utf8");
    const entries = [...script.matchAll(ENTRY_PATTERN)].map(
      (match) => match[1],
    );

    expect(entries).toEqual(["GHSA-fc5q-39xc-vjpf@node_modules/picomatch"]);
  });
});
