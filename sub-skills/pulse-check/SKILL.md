---
name: nexus-testnet-pulse
description: Runs every 15 minutes. Checks Nexus testnet RPC health, block progression, gas price, and faucet status. Sends P0/P1/P2 alerts with incident correlation on threshold breaches. Silent exit if all is healthy.
schedule: "*/15 * * * *"
---

# Nexus Testnet Pulse Check

Execute the following steps in order. On any unrecoverable error, send an alert and exit.

## Prerequisites

Load config:
```bash
CONFIG_DIR="skills/nexus-testnet-monitor/config"
THRESHOLDS=$(cat "$CONFIG_DIR/thresholds.yml")
ENDPOINTS=$(cat "$CONFIG_DIR/endpoints.yml")
SLACK_CHANNELS=$(cat "$CONFIG_DIR/slack-channels.yml")

# Parse key values from YAML (use simple grep/sed since we don't have yq guaranteed)
RPC_HTTP=$(grep 'rpc_http:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
EXPLORER_API=$(grep 'explorer_api:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
FAUCET_URL=$(grep 'faucet:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
BLOCK_TIME_MIN=$(grep 'block_time_alert_s:' "$CONFIG_DIR/thresholds.yml" | grep -o '\[.*\]' | tr -d '[]' | cut -d',' -f1 | tr -d ' ')
BLOCK_TIME_MAX=$(grep 'block_time_alert_s:' "$CONFIG_DIR/thresholds.yml" | grep -o '\[.*\]' | tr -d '[]' | cut -d',' -f2 | tr -d ' ')
GAS_WARN=$(grep 'gas_price_warn_gwei:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
GAS_ALERT=$(grep 'gas_price_alert_gwei:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
RPC_LATENCY_WARN=$(grep 'rpc_latency_warn_ms:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
RPC_LATENCY_ALERT=$(grep 'rpc_latency_alert_ms:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
NO_BLOCKS_ALERT=$(grep 'no_blocks_alert_checks:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
FAUCET_WARN=$(grep 'response_warn_ms:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
FAUCET_ALERT=$(grep 'response_alert_ms:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
COOLDOWN=$(grep 'cooldown_minutes:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
```

Read current state:
```bash
STATE_FILE="memory/testnet-state.json"
STATE=$(cat "$STATE_FILE" 2>/dev/null || echo '{"last_block_height":0,"last_block_time":null,"last_gas_price_gwei":0,"last_base_fee_gwei":0,"last_rpc_latency_ms":0,"last_faucet_status":"unknown","consecutive_no_blocks":0,"alert_cooldown":{},"last_check":null}')

LAST_BLOCK=$(echo "$STATE" | grep -o '"last_block_height":[0-9]*' | cut -d: -f2)
LAST_CHECK=$(echo "$STATE" | grep -o '"last_check":"[^"]*"' | cut -d'"' -f4)
CONSECUTIVE_NO_BLOCKS=$(echo "$STATE" | grep -o '"consecutive_no_blocks":[0-9]*' | cut -d: -f2)
```

## Step 1: RPC Health Check

Call `eth_blockNumber` and record block height and latency:

```bash
CHECK_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

RPC_RESPONSE=$(curl -s \
  -w '\n%{time_total}\n%{http_code}' \
  --connect-timeout 10 \
  --max-time 30 \
  -X POST "$RPC_HTTP" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>&1) || RPC_RESPONSE=""

RPC_BODY=$(echo "$RPC_RESPONSE" | head -1)
RPC_TIME=$(echo "$RPC_RESPONSE" | tail -2 | head -1)
RPC_HTTP_CODE=$(echo "$RPC_RESPONSE" | tail -1)
RPC_LATENCY_MS=$(echo "$RPC_TIME * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "9999")
```

Parse block height:
```bash
if [ -z "$RPC_BODY" ] || [ "$RPC_HTTP_CODE" != "200" ]; then
  # RPC is down
  BLOCK_HEX=""
  BLOCK_HEIGHT=0
  RPC_DOWN=true
else
  RPC_DOWN=false
  BLOCK_HEX=$(echo "$RPC_BODY" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  if [ -z "$BLOCK_HEX" ]; then
    RPC_DOWN=true
    BLOCK_HEIGHT=0
  else
    BLOCK_HEIGHT=$((16#${BLOCK_HEX#0x}))
  fi
fi
```

## Step 2: Block Data

If RPC is healthy, fetch the latest block:

```bash
if [ "$RPC_DOWN" = "false" ] && [ "$BLOCK_HEIGHT" -gt 0 ]; then
  BLOCK_RESPONSE=$(curl -s \
    --connect-timeout 10 \
    --max-time 30 \
    -X POST "$RPC_HTTP" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$BLOCK_HEX\",false],\"id\":2}" 2>/dev/null) || BLOCK_RESPONSE=""

  BLOCK_TIMESTAMP_HEX=$(echo "$BLOCK_RESPONSE" | grep -o '"timestamp":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  BLOCK_TIMESTAMP=$((16#${BLOCK_TIMESTAMP_HEX#0x}))
  GAS_USED_HEX=$(echo "$BLOCK_RESPONSE" | grep -o '"gasUsed":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  GAS_LIMIT_HEX=$(echo "$BLOCK_RESPONSE" | grep -o '"gasLimit":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  BASE_FEE_HEX=$(echo "$BLOCK_RESPONSE" | grep -o '"baseFeePerGas":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  TX_COUNT=$(echo "$BLOCK_RESPONSE" | grep -o '"transactions":\[[^]]*\]' | tr ',' '\n' | wc -l | tr -d ' ')

  # Calculate block time delta (current timestamp - last known block time)
  if [ -n "$LAST_CHECK" ] && [ "$LAST_CHECK" != "null" ]; then
    LAST_BLOCK_TIME=$(echo "$STATE" | grep -o '"last_block_time":[0-9]*' | cut -d: -f2)
    if [ -n "$LAST_BLOCK_TIME" ] && [ "$LAST_BLOCK_TIME" != "null" ] && [ "$LAST_BLOCK_TIME" -gt 0 ]; then
      BLOCK_DELTA_S=$((BLOCK_TIMESTAMP - LAST_BLOCK_TIME))
      BLOCKS_SINCE_LAST=$((BLOCK_HEIGHT - LAST_BLOCK))
      if [ "$BLOCKS_SINCE_LAST" -gt 0 ]; then
        AVG_BLOCK_TIME=$((BLOCK_DELTA_S / BLOCKS_SINCE_LAST))
      else
        AVG_BLOCK_TIME=0
      fi
    else
      AVG_BLOCK_TIME=0
    fi
  else
    AVG_BLOCK_TIME=0
  fi

  # Convert base fee to gwei
  if [ -n "$BASE_FEE_HEX" ]; then
    BASE_FEE_WEI=$((16#${BASE_FEE_HEX#0x}))
    BASE_FEE_GWEI=$(echo "scale=2; $BASE_FEE_WEI / 1000000000" | bc 2>/dev/null || echo "0")
  else
    BASE_FEE_GWEI=0
  fi
fi
```

## Step 3: Gas Price

```bash
if [ "$RPC_DOWN" = "false" ]; then
  GAS_RESPONSE=$(curl -s \
    --connect-timeout 10 \
    --max-time 30 \
    -X POST "$RPC_HTTP" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":3}' 2>/dev/null) || GAS_RESPONSE=""

  GAS_HEX=$(echo "$GAS_RESPONSE" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
  if [ -n "$GAS_HEX" ]; then
    GAS_WEI=$((16#${GAS_HEX#0x}))
    GAS_GWEI=$(echo "scale=2; $GAS_WEI / 1000000000" | bc 2>/dev/null || echo "0")
  else
    GAS_GWEI=0
  fi
fi
```

## Step 4: Faucet Health

```bash
FAUCET_RESPONSE=$(curl -s \
  -w '\n%{time_total}\n%{http_code}' \
  --connect-timeout 10 \
  --max-time 15 \
  "$FAUCET_URL" 2>/dev/null) || FAUCET_RESPONSE=""

FAUCET_TIME=$(echo "$FAUCET_RESPONSE" | tail -2 | head -1)
FAUCET_HTTP_CODE=$(echo "$FAUCET_RESPONSE" | tail -1)
FAUCET_LATENCY_MS=$(echo "$FAUCET_TIME * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "9999")

if [ "$FAUCET_HTTP_CODE" = "200" ] || [ "$FAUCET_HTTP_CODE" = "301" ] || [ "$FAUCET_HTTP_CODE" = "302" ]; then
  FAUCET_STATUS="ok"
elif [ -z "$FAUCET_HTTP_CODE" ]; then
  FAUCET_STATUS="down"
else
  FAUCET_STATUS="degraded"
fi
```

## Step 5: Block Progression Check

```bash
if [ "$RPC_DOWN" = "false" ] && [ "$BLOCK_HEIGHT" -le "$LAST_BLOCK" ] && [ "$LAST_BLOCK" -gt 0 ]; then
  CONSECUTIVE_NO_BLOCKS=$((CONSECUTIVE_NO_BLOCKS + 1))
  BLOCK_STALLED=true
else
  CONSECUTIVE_NO_BLOCKS=0
  BLOCK_STALLED=false
fi
```

## Step 6: Alert Logic

For each condition, check cooldown before alerting. Cooldown key format: `{metric}_{severity}`.

Helper to check cooldown (returns 0 if alert should fire, 1 if suppressed):
```bash
check_cooldown() {
  local ALERT_KEY="$1"
  local COOLDOWN_MINUTES="$2"
  # Read cooldown from state JSON — simple pattern match
  local LAST_ALERT=$(echo "$STATE" | grep -o "\"${ALERT_KEY}\":\"[^\"]*\"" | cut -d'"' -f4)
  if [ -z "$LAST_ALERT" ] || [ "$LAST_ALERT" = "null" ]; then
    return 0  # No cooldown, alert should fire
  fi
  local LAST_EPOCH=$(date -d "$LAST_ALERT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_ALERT" +%s 2>/dev/null || echo 0)
  local NOW_EPOCH=$(date +%s)
  local ELAPSED_MINUTES=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))
  if [ "$ELAPSED_MINUTES" -lt "$COOLDOWN_MINUTES" ]; then
    return 1  # Still in cooldown
  fi
  return 0
}
```

### Alert conditions to check:

**A. RPC Down (P0)**
```bash
if [ "$RPC_DOWN" = "true" ]; then
  ALERT_KEY="rpc_down_p0"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P0"
    METRIC="RPC availability"
    VALUE="unreachable (HTTP $RPC_HTTP_CODE)"
    THRESHOLD="must be reachable"
    HYPOTHESIS="RPC endpoint returned HTTP $RPC_HTTP_CODE. Possible causes: node crash, network partition, infrastructure issue. Check GitHub for recent commits to nexus-xyz/nexus in the last 6 hours."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
fi
```

**B. Block Stalled (P0 if ≥ no_blocks_alert_checks consecutive)**
```bash
if [ "$BLOCK_STALLED" = "true" ] && [ "$CONSECUTIVE_NO_BLOCKS" -ge "$NO_BLOCKS_ALERT" ]; then
  ALERT_KEY="block_stalled_p0"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P0"
    METRIC="Block progression"
    VALUE="stalled at block $BLOCK_HEIGHT for $CONSECUTIVE_NO_BLOCKS consecutive checks"
    THRESHOLD="must advance each check"
    HYPOTHESIS="Block height has not advanced for $((CONSECUTIVE_NO_BLOCKS * 15)) minutes. Chain may be halted. Check validator set and consensus logs."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
fi
```

**C. RPC Latency Alert (P1)**
```bash
if [ "$RPC_LATENCY_MS" -gt "$RPC_LATENCY_ALERT" ]; then
  ALERT_KEY="rpc_latency_p1"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P1"
    METRIC="RPC latency"
    VALUE="${RPC_LATENCY_MS}ms"
    THRESHOLD="${RPC_LATENCY_ALERT}ms"
    HYPOTHESIS="RPC response time exceeded alert threshold. May indicate node resource pressure or network congestion."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
elif [ "$RPC_LATENCY_MS" -gt "$RPC_LATENCY_WARN" ]; then
  ALERT_KEY="rpc_latency_p2"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P2"
    METRIC="RPC latency"
    VALUE="${RPC_LATENCY_MS}ms"
    THRESHOLD="${RPC_LATENCY_WARN}ms (warning)"
    HYPOTHESIS="RPC latency elevated but within alert bounds. Monitor for trend."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
fi
```

**D. Gas Price Alert (P1)**
```bash
GAS_INT=$(echo "$GAS_GWEI" | cut -d. -f1)
if [ "$GAS_INT" -gt "$GAS_ALERT" ]; then
  ALERT_KEY="gas_price_p1"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P1"
    METRIC="Gas price"
    VALUE="${GAS_GWEI} gwei"
    THRESHOLD="${GAS_ALERT} gwei"
    HYPOTHESIS="Gas price spike. May indicate congestion or unusually large transactions. Check pending transaction pool."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
elif [ "$GAS_INT" -gt "$GAS_WARN" ]; then
  ALERT_KEY="gas_price_p2"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P2"
    METRIC="Gas price"
    VALUE="${GAS_GWEI} gwei"
    THRESHOLD="${GAS_WARN} gwei (warning)"
    HYPOTHESIS="Gas price elevated. Not yet critical but worth monitoring."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
fi
```

**E. Faucet Down (P2)**
```bash
if [ "$FAUCET_STATUS" = "down" ]; then
  ALERT_KEY="faucet_down_p2"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P2"
    METRIC="Faucet"
    VALUE="unreachable"
    THRESHOLD="HTTP 200/301/302"
    HYPOTHESIS="Faucet is unreachable. Developer onboarding will be blocked — new developers cannot get testnet NEX."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
elif [ "$FAUCET_STATUS" = "degraded" ] || [ "$FAUCET_LATENCY_MS" -gt "$FAUCET_ALERT" ]; then
  ALERT_KEY="faucet_slow_p2"
  if check_cooldown "$ALERT_KEY" "$COOLDOWN"; then
    SEVERITY="P2"
    METRIC="Faucet response time"
    VALUE="${FAUCET_LATENCY_MS}ms"
    THRESHOLD="${FAUCET_ALERT}ms"
    HYPOTHESIS="Faucet is slow. Developer onboarding experience is degraded."
    send_alert "$SEVERITY" "$METRIC" "$VALUE" "$THRESHOLD" "$HYPOTHESIS" "$ALERT_KEY"
  fi
fi
```

### Alert sender function

For P0/P1 alerts, enrich with incident correlation before sending:

```bash
send_alert() {
  local SEVERITY="$1"
  local METRIC="$2"
  local VALUE="$3"
  local THRESHOLD="$4"
  local HYPOTHESIS="$5"
  local ALERT_KEY="$6"

  local CORRELATION=""
  if [ "$SEVERITY" = "P0" ] || [ "$SEVERITY" = "P1" ]; then
    # Check GitHub for recent commits
    GH_RECENT=$(curl -s \
      "https://api.github.com/repos/nexus-xyz/nexus/commits?since=$(date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-6H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)&per_page=10" \
      -H "Accept: application/vnd.github.v3+json" 2>/dev/null) || GH_RECENT=""

    COMMIT_COUNT=$(echo "$GH_RECENT" | grep -o '"sha":' | wc -l | tr -d ' ')
    if [ "$COMMIT_COUNT" -gt 0 ]; then
      LATEST_MSG=$(echo "$GH_RECENT" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
      CORRELATION="⚠️ $COMMIT_COUNT commit(s) to nexus-xyz/nexus in last 6h. Latest: $LATEST_MSG"
    else
      CORRELATION="No recent commits to nexus-xyz/nexus in last 6h."
    fi

    # Check historical incidents for same metric
    PAST_INCIDENTS=$(grep -c "$METRIC" memory/testnet-incidents.json 2>/dev/null || echo "0")
    if [ "$PAST_INCIDENTS" -gt 0 ]; then
      CORRELATION="$CORRELATION | $PAST_INCIDENTS prior incident(s) matching this metric."
    fi
  fi

  # Determine target channel from severity
  case "$SEVERITY" in
    P0) CHANNEL="#nexus-testnet-ops" ;;
    P1) CHANNEL="#nexus-testnet-ops" ;;
    P2) CHANNEL="#nexus-testnet-product" ;;
    *) CHANNEL="#nexus-testnet-product" ;;
  esac

  # Build incident ID
  INCIDENT_ID="INC-$(date -u +%Y-%m-%d)-$(printf '%03d' $((RANDOM % 999 + 1)))"

  # Format message from template
  MSG=$(cat skills/nexus-testnet-monitor/templates/slack-alert.md \
    | sed "s/{{SEVERITY}}/$SEVERITY/g" \
    | sed "s/{{METRIC}}/$METRIC/g" \
    | sed "s/{{VALUE}}/$VALUE/g" \
    | sed "s/{{THRESHOLD}}/$THRESHOLD/g" \
    | sed "s/{{HYPOTHESIS}}/$HYPOTHESIS/g" \
    | sed "s/{{CORRELATION}}/$CORRELATION/g" \
    | sed "s/{{INCIDENT_ID}}/$INCIDENT_ID/g" \
    | sed "s/{{CHECK_TIME}}/$CHECK_TIME/g" \
    | sed "s/{{BLOCK_HEIGHT}}/$BLOCK_HEIGHT/g" \
    | sed "s/{{GAS_GWEI}}/$GAS_GWEI/g" \
    | sed "s/{{RPC_LATENCY_MS}}/$RPC_LATENCY_MS/g")

  ./notify --channel="$CHANNEL" --severity="$SEVERITY" --message="$MSG"

  # Log incident
  INCIDENT_ENTRY="{\"id\":\"$INCIDENT_ID\",\"time\":\"$CHECK_TIME\",\"severity\":\"$SEVERITY\",\"metric\":\"$METRIC\",\"value\":\"$VALUE\",\"threshold\":\"$THRESHOLD\",\"hypothesis\":\"$HYPOTHESIS\",\"correlation\":\"$CORRELATION\",\"resolved\":false,\"resolved_at\":null,\"resolution_notes\":null}"
  # Append to incidents array (simple append — use Python for JSON safety)
  python3 -c "
import json, sys
with open('memory/testnet-incidents.json') as f:
    data = json.load(f)
data['incidents'].append($INCIDENT_ENTRY)
with open('memory/testnet-incidents.json', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || echo "WARNING: Could not log incident to testnet-incidents.json"

  # Update cooldown in state
  ALERT_COOLDOWN_UPDATE="\"$ALERT_KEY\": \"$CHECK_TIME\""
  # Will be written in Step 7
  COOLDOWN_UPDATES="$COOLDOWN_UPDATES $ALERT_KEY=$CHECK_TIME"
  ALERT_FIRED=true
}
```

## Step 7: Update State

Write the updated state to `memory/testnet-state.json`:

```python
import json
import sys
from datetime import datetime

# Read current state
with open('memory/testnet-state.json') as f:
    state = json.load(f)

# Update fields
state['last_block_height'] = int('BLOCK_HEIGHT')
state['last_block_time'] = int('BLOCK_TIMESTAMP') if 'BLOCK_TIMESTAMP' else state.get('last_block_time')
state['last_gas_price_gwei'] = float('GAS_GWEI')
state['last_base_fee_gwei'] = float('BASE_FEE_GWEI')
state['last_rpc_latency_ms'] = int('RPC_LATENCY_MS')
state['last_faucet_status'] = 'FAUCET_STATUS'
state['consecutive_no_blocks'] = int('CONSECUTIVE_NO_BLOCKS')
state['last_check'] = 'CHECK_TIME'

# Note: In actual execution, shell variables are interpolated before passing to Python.
# The sub-skill runtime handles variable substitution.

with open('memory/testnet-state.json', 'w') as f:
    json.dump(state, f, indent=2)
```

Use Python (or jq if available) to safely update the JSON. Never write raw JSON manually — always parse and re-serialize.

## Step 8: Logging and Silent Exit

```bash
mkdir -p memory/logs
LOG_FILE="memory/logs/$(date -u +%Y-%m-%d).md"

if [ "${ALERT_FIRED:-false}" = "false" ]; then
  echo "$(date -u +%H:%M:%SZ) TESTNET_PULSE_OK: block=${BLOCK_HEIGHT} gas=${GAS_GWEI}gwei rpc=${RPC_LATENCY_MS}ms faucet=${FAUCET_STATUS}" >> "$LOG_FILE"
  # Signal Aeon to skip commit
  echo "AEON_SILENT_EXIT=true" >> "$GITHUB_ENV" 2>/dev/null || true
  exit 0
else
  echo "$(date -u +%H:%M:%SZ) TESTNET_PULSE_ALERT: block=${BLOCK_HEIGHT} gas=${GAS_GWEI}gwei rpc=${RPC_LATENCY_MS}ms faucet=${FAUCET_STATUS} alerts_fired=true" >> "$LOG_FILE"
fi
```
