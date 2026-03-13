#!/bin/bash
# Standalone RPC health check for Nexus testnet.
# Usage: ./rpc-check.sh [rpc_url]
# Defaults to testnet if no URL provided.
# Exits 0 if healthy, 1 if degraded, 2 if down.

set -euo pipefail

RPC_URL="${1:-https://testnet.rpc.nexus.xyz}"
WARN_MS=500
ALERT_MS=2000

echo "=== Nexus RPC Health Check ==="
echo "Endpoint: $RPC_URL"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# eth_blockNumber
RESPONSE=$(curl -s -w '\n%{time_total}\n%{http_code}' \
  --connect-timeout 10 \
  --max-time 30 \
  -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>&1) || {
  echo "RESULT: DOWN (curl failed)"
  exit 2
}

HTTP_BODY=$(echo "$RESPONSE" | head -1)
TIME_TOTAL=$(echo "$RESPONSE" | tail -2 | head -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
TIME_MS=$(echo "$TIME_TOTAL * 1000" | bc | cut -d. -f1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "RESULT: DOWN (HTTP $HTTP_CODE)"
  exit 2
fi

# Extract block number (hex)
BLOCK_HEX=$(echo "$HTTP_BODY" | grep -o '"result":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")
if [ -z "$BLOCK_HEX" ]; then
  echo "RESULT: ERROR (could not parse block number)"
  echo "Response: $HTTP_BODY"
  exit 2
fi

# Convert hex to decimal
BLOCK_DEC=$((16#${BLOCK_HEX#0x}))

echo "Block height:  $BLOCK_DEC"
echo "RPC latency:   ${TIME_MS}ms"
echo ""

# Classify health
if [ "$TIME_MS" -gt "$ALERT_MS" ]; then
  echo "RESULT: DEGRADED (latency ${TIME_MS}ms > ${ALERT_MS}ms alert threshold)"
  exit 1
elif [ "$TIME_MS" -gt "$WARN_MS" ]; then
  echo "RESULT: WARN (latency ${TIME_MS}ms > ${WARN_MS}ms warn threshold)"
  exit 0
else
  echo "RESULT: OK"
  exit 0
fi
