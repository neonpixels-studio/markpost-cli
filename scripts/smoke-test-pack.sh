#!/usr/bin/env bash
# Packs the CLI and smoke-tests the installed tarball. Mirrors the inline
# "Pack and smoke-test" step in .github/workflows/ci.yml; used by release.yml.
# Installing the packed tarball (not running dist/ from the working tree)
# exercises the real published `files`/`bin` config.
set -euo pipefail
shopt -s nullglob

temp_dir="${RUNNER_TEMP:-$(mktemp -d)}"
pack_dir="$temp_dir/pack"
mkdir -p "$pack_dir"
npm pack --pack-destination "$pack_dir"
tarballs=("$pack_dir"/*.tgz)
if [ "${#tarballs[@]}" -ne 1 ]; then
  echo "expected exactly one tarball in $pack_dir, found ${#tarballs[@]}: ${tarballs[*]:-none}"
  exit 1
fi
npm install -g "${tarballs[0]}"
if ! markpost --help > "$temp_dir/help.txt" 2>&1; then
  echo "installed CLI failed - see output below"
  cat "$temp_dir/help.txt"
  exit 1
fi
if ! grep -q '^Usage: markpost <command>' "$temp_dir/help.txt"; then
  echo "top-level usage line changed - update HELP_TEXT in src/index.ts"
  cat "$temp_dir/help.txt"
  exit 1
fi
