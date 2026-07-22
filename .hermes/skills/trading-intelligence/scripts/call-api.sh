#!/usr/bin/env bash
# Trading Intelligence skill — thin, read-only wrapper around the Integration API.
# Never issues anything but a GET; never echoes the token itself.
#
# Usage:
#   call-api.sh <health|runtime|positions|decisions|portfolio|summary> [query-string]
#
# Examples:
#   call-api.sh summary
#   call-api.sh decisions "limit=10&outcome=BUY"
#   call-api.sh positions
#
# Requires HERMES_INTEGRATION_TOKEN in the environment, matching the value the Integration API
# itself is configured with. Base URL defaults to http://127.0.0.1:3000 (this API is local-only by
# design — see references/safety-and-limitations.md); override with TRADING_INTELLIGENCE_BASE_URL
# only if you have been told this deployment uses a different host/port.

set -euo pipefail

BASE_URL="${TRADING_INTELLIGENCE_BASE_URL:-http://127.0.0.1:3000}"

if [ -z "${HERMES_INTEGRATION_TOKEN:-}" ]; then
  echo "Error: HERMES_INTEGRATION_TOKEN is not set in this environment. This skill cannot call the Integration API without it." >&2
  exit 1
fi

ENDPOINT="${1:-}"
case "$ENDPOINT" in
  health|runtime|positions|decisions|portfolio|summary) ;;
  "")
    echo "Usage: call-api.sh <health|runtime|positions|decisions|portfolio|summary> [query-string]" >&2
    exit 1
    ;;
  *)
    echo "Unknown endpoint \"$ENDPOINT\" — must be one of: health, runtime, positions, decisions, portfolio, summary." >&2
    exit 1
    ;;
esac

QUERY="${2:-}"
URL="${BASE_URL}/api/hermes/${ENDPOINT}"
if [ -n "$QUERY" ]; then
  URL="${URL}?${QUERY}"
fi

curl -sS \
  -H "Authorization: Bearer ${HERMES_INTEGRATION_TOKEN}" \
  "$URL"
