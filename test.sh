#!/usr/bin/env bash
# Smoke-tests the worker's markdown, index, resolution, missing-note, and pass-through behavior.

set -u

domain=${1:-}
if [[ -z "$domain" ]]; then
  echo "Usage: $0 domain" >&2
  exit 2
fi

base="https://${domain}"
failures=0
body=
status=

fetch_body() {
  local response
  response=$(curl -sS -L -w $'\n__HTTP_STATUS__:%{http_code}' "${base}$1") || return 1
  status=${response##*__HTTP_STATUS__:}
  body=${response%$'\n__HTTP_STATUS__:'*}
}

check() {
  local name=$1
  shift
  if "$@"; then
    echo "ok - $name"
  else
    echo "not ok - $name" >&2
    failures=$((failures + 1))
  fi
}

direct_path() {
  fetch_body "/02-Evergreen/Terms/Design+engineering.md" || return 1
  [[ "$status" == "200" ]] || return 1
  [[ "$body" =~ ^(---|#{1,6}[[:space:]]|[^[:space:]]) ]]
}

llms_index() {
  fetch_body "/llms.txt" || return 1
  [[ "$status" == "200" ]] || return 1
  [[ "$body" == \#\ * ]] || return 1
  [[ "$body" == *"](https://"* ]]
}

markdown_pointer() {
  fetch_body "/looking.md" || return 1
  [[ "$status" == "200" ]] || return 1
  [[ "$body" == *"<!-- Site index for agents: "*"/llms.txt"* ]] || return 1
  if [[ "$body" == ---$'\n'* ]]; then
    [[ "${body%%$'\n'*}" == "---" ]]
  fi
}

resolved_wikilink() {
  fetch_body "/looking.md?resolve=1" || return 1
  [[ "$status" == "200" ]] || return 1
  [[ "$body" == *"Superficializing+effects"* ]]
}

permalink() {
  fetch_body "/looking.md" || return 1
  [[ "$status" == "200" ]] || return 1
  [[ "$body" == *"Hi, I'm Nathan"* ]]
}

missing_note() {
  fetch_body "/this-note-does-not-exist-obsidian-publish-md.md" || return 1
  [[ "$status" == "404" ]]
}

normal_page() {
  local result http_status content_type
  result=$(curl -sS -L -o /dev/null -w $'%{http_code}\n%{content_type}' "${base}/looking") || return 1
  http_status=${result%%$'\n'*}
  content_type=${result#*$'\n'}
  [[ "$http_status" == "200" ]] || return 1
  [[ "$content_type" == text/html* ]]
}

check "direct-path markdown returns content" direct_path
check "llms.txt returns a linked site index" llms_index
check "markdown includes the llms.txt pointer without displacing frontmatter" markdown_pointer
check "resolve rewrites a known wikilink" resolved_wikilink
check "permalink markdown returns content" permalink
check "missing markdown returns 404" missing_note
check "normal page passes through as HTML" normal_page

if (( failures > 0 )); then
  echo "$failures smoke test(s) failed" >&2
  exit 1
fi

echo "All smoke tests passed"
