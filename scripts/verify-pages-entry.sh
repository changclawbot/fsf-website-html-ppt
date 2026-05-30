#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <deck-url> <catalog-pattern> [catalog-url]" >&2
  exit 64
fi

deck_url="$1"
catalog_pattern="$2"
catalog_url="${3:-https://changclawbot.github.io/fsf-website-html-ppt/ppt-catalog/}"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/pages-verify.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if command -v gh >/dev/null 2>&1; then
  head_sha="$(git rev-parse HEAD)"
  for _ in 1 2 3 4 5 6; do
    status="$(gh run list --workflow pages-build-deployment --branch main --limit 10 --json headSha,status,conclusion \
      --jq ".[] | select(.headSha == \"$head_sha\") | [.status, (.conclusion // \"\")] | @tsv" 2>/dev/null | head -n 1 || true)"

    if [ -n "$status" ]; then
      run_status="${status%%$'\t'*}"
      run_conclusion="${status#*$'\t'}"
      if [ "$run_status" = "completed" ] && [ "$run_conclusion" = "success" ]; then
        break
      fi
      if [ "$run_status" = "completed" ]; then
        echo "pages build finished with conclusion: $run_conclusion" >&2
        exit 1
      fi
    fi
    sleep 10
  done
fi

for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  deck_code="$(curl -L --max-time 20 -sS -o "$tmpdir/deck.html" -w '%{http_code}' "$deck_url" || true)"
  catalog_code="$(curl -L --max-time 20 -sS -o "$tmpdir/catalog.html" -w '%{http_code}' "$catalog_url" || true)"

  if [ "$deck_code" = "200" ] &&
     [ "$catalog_code" = "200" ] &&
     rg -q "$catalog_pattern" "$tmpdir/catalog.html"; then
    echo "verified deck=200 catalog=200 pattern=$catalog_pattern"
    exit 0
  fi

  echo "try $i deck=$deck_code catalog=$catalog_code pattern_found=no"
  sleep 10
done

echo "verification failed after waiting: deck=$deck_url catalog=$catalog_url pattern=$catalog_pattern" >&2
exit 1
