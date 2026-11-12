#!/usr/bin/env bash
set -uo pipefail

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [[ -z "$base" ]]; then
  echo "No previous deployment SHA; building."
  exit 1
fi

if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch --quiet --no-tags --deepen=200 origin 2>/dev/null || true
fi
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "Previous deployment $base is not in the clone; building."
  exit 1
fi

private_packages="$(grep -l '"private": true' packages/*/package.json | xargs -n1 dirname)"
if ! git diff --quiet "$base" HEAD -- apps/docs apps/marketing $private_packages \
  vercel.json .vercelignore scripts/vercel-ignore-build.sh; then
  echo "A site, a private site package or the Vercel config changed since $base; building."
  exit 1
fi

if git diff "$base" HEAD -- 'packages/*/package.json' | grep -qE '^[+-][[:space:]]*"version":'; then
  echo "A package version changed since $base; building the release docs."
  exit 1
fi

echo "Neither site nor a package version changed since $base; skipping."
exit 0
