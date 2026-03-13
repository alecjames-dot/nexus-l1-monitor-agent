#!/bin/bash
# Blockscout API wrapper for Nexus testnet.
# Usage: ./blockscout-query.sh <endpoint> [query_params]
# Example: ./blockscout-query.sh "/api/v2/stats"
# Example: ./blockscout-query.sh "/api/v2/smart-contracts" "filter=new&limit=50"
#
# Outputs raw JSON. Caller is responsible for parsing.
# Exits 0 on success, 1 on HTTP error, 2 on curl failure.

set -euo pipefail

EXPLORER_API="${NEXUS_EXPLORER_API:-https://testnet.explorer.nexus.xyz}"
ENDPOINT="${1:-/api/v2/stats}"
QUERY_PARAMS="${2:-}"

if [ -n "$QUERY_PARAMS" ]; then
  FULL_URL="${EXPLORER_API}${ENDPOINT}?${QUERY_PARAMS}"
else
  FULL_URL="${EXPLORER_API}${ENDPOINT}"
fi

RESPONSE=$(curl -s -w '\n%{http_code}' \
  --connect-timeout 10 \
  --max-time 30 \
  -H "Accept: application/json" \
  "$FULL_URL" 2>&1) || {
  echo '{"error": "curl_failed"}' >&2
  exit 2
}

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "{\"error\": \"http_$HTTP_CODE\", \"url\": \"$FULL_URL\"}" >&2
  exit 1
fi

echo "$HTTP_BODY"
