#!/usr/bin/env bash
set -euo pipefail
tag="${1:?release tag required}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
sha="$(git rev-parse HEAD)"
name="${GH_REPO##*/}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git archive HEAD | tar -xf - -C "$stage"
if [[ -f bun.lock ]]; then cp bun.lock "$stage/bun.lock"; fi
# Consume the exact published archives, not a moving upstream branch.
while IFS= read -r dependency; do
  repo="$(jq -r .repository <<< "$dependency")"
  path="$(jq -r .path <<< "$dependency")"
  commit="$(jq -r .commit <<< "$dependency")"
  version="$(jq -r .tag <<< "$dependency")"
  asset="${repo##*/}-$version.tar.gz"
  [[ "$(git rev-parse "HEAD:$path")" == "$commit" ]]
  ref="$(git ls-remote "https://github.com/$repo.git" "refs/tags/$version^{}" | cut -f1)"
  if [[ -z "$ref" ]]; then ref="$(git ls-remote "https://github.com/$repo.git" "refs/tags/$version" | cut -f1)"; fi
  [[ "$ref" == "$commit" ]]
  download="$(mktemp -d "$stage/.upstream.XXXXXX")"
  gh release download "$version" --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$download"
  (cd "$download" && sha256sum -c SHA256SUMS)
  mkdir -p "$stage/$path"
  tar -xzf "$download/$asset" -C "$stage/$path"
  [[ "$(cat "$stage/$path/RELEASE_COMMIT")" == "$commit" ]]
  rm -rf "$download"
done < <(jq -c '.dependencies[]' upstream.releases.json)
printf '%s\n' "$sha" > "$stage/RELEASE_COMMIT"
mkdir -p dist
tar --sort=name --mtime="@$(git show -s --format=%ct HEAD)" --owner=0 --group=0 --numeric-owner -czf "dist/$name-$tag.tar.gz" -C "$stage" .
tar -tzf "dist/$name-$tag.tar.gz" >/dev/null
