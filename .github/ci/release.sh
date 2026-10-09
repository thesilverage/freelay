#!/usr/bin/env bash
# Release helpers for tag-triggered workflows. Run from the repository root.
#
#   release.sh check stable|beta TAG   prints should_release=true|false (and
#                                      sets that step output under Actions)
#   release.sh set-version TAG         writes TAG into manifest.json
#
# A stable tag equals manifest.json's version. A prerelease tag has that version
# as its base and an explicit alpha, beta, or rc sequence.
set -euo pipefail

case "${1:-}" in
  check)
    channel="${2:?channel}" tag="${3:?tag}"
    manifest_version=$(jq -r .version manifest.json)
    stable_pattern='^[0-9]+\.[0-9]+\.[0-9]+$'
    prerelease_pattern='^[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[0-9]+$'
    prerelease_base="${tag%%-*}"
    should=false
    if [ "$channel" = stable ] && [[ "$tag" =~ $stable_pattern ]] \
      && [ "$tag" = "$manifest_version" ]; then
      should=true
    elif [ "$channel" = beta ] && [[ "$tag" =~ $prerelease_pattern ]] \
      && [ "$prerelease_base" = "$manifest_version" ]; then
      should=true
    fi
    echo "Tag $tag, manifest $manifest_version: $channel release $should"
    echo "should_release=$should" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    ;;
  set-version)
    tag="${2:?tag}"
    tmp="$(mktemp)"
    jq --arg version "$tag" '.version = $version' manifest.json > "$tmp"
    mv "$tmp" manifest.json
    jq -e --arg version "$tag" '.version == $version' manifest.json > /dev/null
    echo "manifest.json version set to $tag"
    ;;
  *) echo "usage: release.sh check stable|beta TAG | release.sh set-version TAG" >&2; exit 2 ;;
esac
