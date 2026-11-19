#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# Scan working-tree files owned by this repository. Gitlinks are directories,
# not files: their independently validated source and documentation stay out.
scan="$(mktemp -d)"
trap 'rm -rf "$scan"' EXIT
while IFS= read -r -d '' file; do
    [ -f "$file" ] || continue
    mkdir -p "$scan/$(dirname "$file")"
    cp "$file" "$scan/$file"
done < <(git ls-files -z --cached --others --exclude-standard)
ln -s "$root/node_modules" "$scan/node_modules"
bun "$root/node_modules/@kitty-crow/code-guards/src/cli.ts" all --strict --path "$scan" --include-tests "$@"
