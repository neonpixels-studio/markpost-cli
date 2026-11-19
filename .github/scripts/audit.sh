#!/usr/bin/env bash
# Dependency vulnerability gate for CI.
# Runs `npm audit`, prints a severity summary, and fails the build when there is
# at least one high or critical *advisory* that is not on the accepted allowlist
# below. Moderate and low are reported but never fail the build.
# Dev dependencies are intentionally in scope: build/test tooling runs in CI
# and on developer machines, so its advisories matter here.
#
# Blocking is measured per distinct advisory (GHSA id), not per affected package.
# npm's package-level counts inflate a single root advisory into every package
# that pulls it in transitively. Counting advisories keeps the gate honest about
# how many real, un-remediated flaws exist.
#
# ALLOWLIST POLICY: only advisories with no upstream fix belong here, each with a
# justification and a trigger to remove it. This is NOT a way to silence fixable
# findings — prefer `npm update <pkg>` (or an `overrides` bump if the parent's
# declared range excludes the patched version) every time a fix is available.
#
# Entries are keyed "<GHSA-id>@<node_modules path>" so an exemption only covers
# the exact install location it was justified for.
set -euo pipefail

# High/critical advisories accepted because no patched version exists upstream.
# Remove an entry the moment its package ships a fix.
ALLOWLISTED_ADVISORIES=(
  # picomatch <=4.0.7: ReDoS via single-branch repeated extglobs. No patched
  # release exists (4.0.7 is the latest on npm), so an `overrides` bump cannot fix
  # it. `npm ls picomatch --omit=dev` is empty: it is pulled in only by dev
  # tooling (vitest, vite, tinyglobby, fdir) and is not part of the published
  # package (`files: ["dist"]`, no runtime dependency reaches it). It matches
  # globs authored by this repo's tooling config, never user input. Drop once
  # picomatch ships >4.0.7 and bump via `overrides`.
  "GHSA-fc5q-39xc-vjpf@node_modules/picomatch" # picomatch: ReDoS via repeated extglobs
)

report="$(npm audit --json || true)"

if ! printf '%s' "$report" | jq -e '.metadata.vulnerabilities' >/dev/null 2>&1; then
  echo "npm audit produced no vulnerability metadata (audit failed) — failing the build." >&2
  exit 1
fi

read_count() {
  local severity="$1"
  printf '%s' "$report" | jq -r --arg severity "$severity" \
    '.metadata.vulnerabilities[$severity] // 0'
}

critical="$(read_count critical)"
high="$(read_count high)"
moderate="$(read_count moderate)"
low="$(read_count low)"

# Runs jq over the JSON string passed as $1; remaining args go to jq.
jq_on() {
  printf '%s' "$1" | jq "${@:2}"
}

# Appends to the job summary (a no-op sink when not running in Actions).
append_summary() {
  tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

{
  echo "## Dependency audit"
  echo ""
  echo "| Severity | Affected packages |"
  echo "| -------- | ----------------- |"
  echo "| Critical | ${critical} |"
  echo "| High     | ${high} |"
  echo "| Moderate | ${moderate} |"
  echo "| Low      | ${low} |"
} | append_summary

# Build the allowlist as a JSON array — safe even when the array is emptied
# (removing every entry is the documented next step once fixes ship).
allow_json="$(jq -cn '$ARGS.positional' --args ${ALLOWLISTED_ADVISORIES[@]+"${ALLOWLISTED_ADVISORIES[@]}"})"

# Distinct high/critical "<GHSA-id>@<path>" pairs; non-GHSA advisories fall
# back to source-<n>:<name>. `(.via // [])` and `(.nodes // [...])` tolerate a
# vulnerability object missing either array instead of aborting under set -e.
all_ids="$(jq_on "$report" -c '
  [ .vulnerabilities[] as $vulnerability
    | ($vulnerability.via // [])[]
    | select(type == "object" and (.severity == "high" or .severity == "critical"))
    | ( (((.url // "") | capture("(?<id>GHSA-[-0-9a-z]+)").id)?)
        // ("source-" + ((.source // 0) | tostring) + ":" + (.name // .title // "unknown"))
      ) as $advisory_id
    | ($vulnerability.nodes // ["unknown-path"])[]
    | "\($advisory_id)@\(.)"
  ] | unique')"

# Staleness has no reliable signal in `npm audit --json` (`fixAvailable` is
# per-package, not per-advisory), so removal is manual — the `::warning` below
# is what prompts a maintainer to check when an entry falls out of the report.
blocking_ids="$(jq_on "$all_ids" -c --argjson allow "$allow_json" 'map(select(IN($allow[]) | not))')"
blocking_count="$(jq_on "$blocking_ids" 'length')"

accepted_ids="$(jq_on "$all_ids" -c --argjson allow "$allow_json" 'map(select(IN($allow[])))')"
accepted_present="$(jq_on "$accepted_ids" 'length')"

stale_ids="$(jq_on "$all_ids" -r --argjson allow "$allow_json" '$allow - . | .[]')"
if [ -n "$stale_ids" ]; then
  stale_summary="${stale_ids//$'\n'/, }"
  echo "::warning title=Stale audit allowlist entries::${stale_summary}"
  {
    echo ""
    echo "Stale allowlist entries (no longer present in the audit — safe to remove from ALLOWLISTED_ADVISORIES):"
    echo "$stale_ids" | sed 's/^/- /'
  } | append_summary
fi

if [ "$accepted_present" -gt 0 ]; then
  {
    echo ""
    echo "Accepted (allowlisted, no upstream fix) high/critical advisories:"
    jq_on "$accepted_ids" -r '.[] | "- " + .'
  } | append_summary
fi

if [ "$blocking_count" -gt 0 ]; then
  {
    echo ""
    echo "Found ${blocking_count} un-allowlisted high/critical advisories — failing the build:"
    jq_on "$blocking_ids" -r '.[] | "- " + .'
  } | append_summary >&2
  exit 1
fi

echo "No un-allowlisted high or critical advisories found."
