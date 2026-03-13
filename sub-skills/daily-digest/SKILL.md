---
name: nexus-testnet-digest
description: Runs daily at 2pm UTC. Collects 24h chain health and engagement metrics, applies bot filtering, runs anomaly detection, generates developer funnel snapshot, reads monorepo activity, and sends a comprehensive product digest to Slack.
schedule: "0 14 * * *"
---

# Nexus Testnet Daily Digest

## Prerequisites

```bash
CONFIG_DIR="skills/nexus-testnet-monitor/config"
RPC_HTTP=$(grep 'rpc_http:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
EXPLORER_API=$(grep 'explorer_api:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
GITHUB_REPO=$(grep 'repo:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
DAU_TARGET=$(grep 'daily_active_addresses_target:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
DEPLOY_TARGET=$(grep 'daily_contract_deploys_target:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
ORGANIC_FLOOR=$(grep 'organic_ratio_floor:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
VERIFICATION_TARGET=$(grep 'verification_rate_target:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
MILD_Z=$(grep 'mild_anomaly_z:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
SIGNIFICANT_Z=$(grep 'significant_anomaly_z:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
LEARNING_DAYS=$(grep 'learning_mode_days:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')

DIGEST_DATE=$(date -u +%Y-%m-%d)
DIGEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
YESTERDAY=$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d 2>/dev/null)

# Load goals context
GOALS=$(cat "$CONFIG_DIR/goals.yml")
BASELINES=$(cat memory/baselines.json 2>/dev/null || echo '{"learning_mode":true,"metrics":{}}')
```

## Step 1: Chain Health Metrics (24h)

Query Blockscout stats endpoint for chain overview:

```bash
# [TODO: verify Blockscout v2 /stats response schema]
STATS=$(curl -s --connect-timeout 15 --max-time 60 \
  "${EXPLORER_API}/v2/stats" \
  -H "Accept: application/json" 2>/dev/null) || STATS='{}'

# Parse key fields
# [TODO: verify exact field names from Blockscout v2 /stats]
TOTAL_BLOCKS=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_blocks', d.get('blocks_count', 0)))" 2>/dev/null || echo 0)
TOTAL_TXS=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_transactions', d.get('transactions_count', 0)))" 2>/dev/null || echo 0)
TOTAL_ADDRESSES=$(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_addresses', 0))" 2>/dev/null || echo 0)
```

Sample 24h of blocks from RPC to calculate block time distribution:

```python
import json, subprocess, time

rpc_http = os.environ.get('RPC_HTTP', 'https://testnet.rpc.nexus.xyz')

def rpc_call(method, params=None):
    """Make a JSON-RPC call and return parsed result."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params or [],
        "id": 1
    })
    try:
        result = subprocess.run(
            ['curl', '-s', '--connect-timeout', '10', '--max-time', '30',
             '-X', 'POST', rpc_http,
             '-H', 'Content-Type: application/json',
             '-d', payload],
            capture_output=True, text=True, timeout=35
        )
        data = json.loads(result.stdout)
        return data.get('result')
    except:
        return None

# Get current block
current_block_hex = rpc_call('eth_blockNumber')
if not current_block_hex:
    print("ERROR: Could not fetch block number")
    exit(1)
current_block = int(current_block_hex, 16)

# Sample blocks: get block from 24h ago by scanning backwards
# Assuming ~2s block time = ~43200 blocks per 24h
TARGET_BLOCKS_24H = 43200
start_block = max(0, current_block - TARGET_BLOCKS_24H)

# Sample 100 evenly-spaced blocks to compute avg block time
sample_size = 100
step = max(1, TARGET_BLOCKS_24H // sample_size)
block_times = []

for i in range(sample_size):
    block_num = start_block + (i * step)
    block_hex = hex(block_num)
    block_data = rpc_call('eth_getBlockByNumber', [block_hex, False])
    if block_data and 'timestamp' in block_data:
        block_times.append(int(block_data['timestamp'], 16))

# Calculate block time stats
if len(block_times) >= 2:
    deltas = [block_times[i+1] - block_times[i] for i in range(len(block_times)-1)]
    avg_block_time = sum(deltas) / len(deltas)
    min_block_time = min(deltas)
    max_block_time = max(deltas)
    sorted_deltas = sorted(deltas)
    p50_block_time = sorted_deltas[len(sorted_deltas)//2]
else:
    avg_block_time = 0
    min_block_time = 0
    max_block_time = 0
    p50_block_time = 0

print(json.dumps({
    'avg_block_time': round(avg_block_time, 2),
    'min_block_time': min_block_time,
    'max_block_time': max_block_time,
    'p50_block_time': p50_block_time,
    'current_block': current_block,
    'start_block': start_block
}))
```

## Step 2: Engagement Metrics

Query Blockscout for 24h engagement data:

```bash
# Active addresses in last 24h
# [TODO: verify Blockscout v2 endpoint for daily active addresses]
ACTIVE_ADDRS=$(curl -s --connect-timeout 15 --max-time 60 \
  "${EXPLORER_API}/v2/transactions?filter=validated&limit=50" \
  -H "Accept: application/json" 2>/dev/null) || ACTIVE_ADDRS='{}'

# Top contracts by gas
TOP_CONTRACTS=$(curl -s --connect-timeout 15 --max-time 60 \
  "${EXPLORER_API}/v2/main-page/transactions" \
  -H "Accept: application/json" 2>/dev/null) || TOP_CONTRACTS='{}'
```

```python
import json, os
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

def parse_24h_engagement(tx_data_raw):
    """Parse transaction data and compute 24h engagement metrics with bot filtering."""

    try:
        data = json.loads(tx_data_raw) if isinstance(tx_data_raw, str) else tx_data_raw
        items = data.get('items', data.get('result', []))
    except:
        items = []

    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(hours=24)

    # Filter to last 24h
    recent_txs = []
    for tx in items:
        ts = tx.get('timestamp') or tx.get('inserted_at')
        if ts:
            try:
                tx_time = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                if tx_time > day_ago:
                    recent_txs.append(tx)
            except:
                recent_txs.append(tx)  # Include if can't parse time

    # Raw metrics
    senders = Counter()
    hourly_counts = defaultdict(int)
    contract_gas = defaultdict(int)

    for tx in recent_txs:
        sender = tx.get('from', {}).get('hash', tx.get('from', ''))
        if sender:
            senders[sender] += 1

        # Hourly distribution
        ts = tx.get('timestamp', '')
        if ts:
            try:
                hour = datetime.fromisoformat(ts.replace('Z', '+00:00')).hour
                hourly_counts[hour] += 1
            except:
                pass

        # Gas per contract
        to_addr = tx.get('to', {}).get('hash', tx.get('to', ''))
        gas_used = tx.get('gas_used', 0)
        if to_addr and gas_used:
            contract_gas[to_addr] += int(str(gas_used), 16) if str(gas_used).startswith('0x') else int(gas_used)

    # Bot filtering heuristics
    bot_addresses = set()

    # Burst sender: >50 tx/hour from single address
    for sender, count in senders.items():
        if count > 50:
            bot_addresses.add(sender)

    # Faucet-and-dump: single tx after funding (harder to detect without faucet data)
    # Mark addresses with exactly 1 tx as potentially low-signal (not bots, but low engagement)
    single_tx_addresses = {sender for sender, count in senders.items() if count == 1}

    # Organic = not burst-sender + more than 1 tx (simple heuristic for now)
    organic_addresses = {sender for sender, count in senders.items()
                         if sender not in bot_addresses and count >= 2}

    raw_dau = len(senders)
    organic_dau = len(organic_addresses)

    return {
        'raw_dau': raw_dau,
        'organic_dau': organic_dau,
        'organic_ratio': round(organic_dau / raw_dau, 3) if raw_dau > 0 else 0,
        'total_transactions': len(recent_txs),
        'bot_flagged_count': len(bot_addresses),
        'single_tx_addresses': len(single_tx_addresses),
        'top_5_contracts_by_gas': sorted(contract_gas.items(), key=lambda x: x[1], reverse=True)[:5],
        'hourly_distribution': dict(hourly_counts)
    }
```

Read contract deployment data from registry:

```python
with open('memory/contract-registry.json') as f:
    registry = json.load(f)

from datetime import datetime, timezone, timedelta
now = datetime.now(timezone.utc)
day_ago = now - timedelta(hours=24)

# Contracts deployed in last 24h
recent_contracts = [
    c for c in registry['contracts']
    if c.get('scout_time') and
    datetime.fromisoformat(c['scout_time'].replace('Z', '+00:00')) > day_ago
]

contracts_deployed = len(recent_contracts)
contracts_verified = sum(1 for c in recent_contracts if c.get('is_verified'))
verification_rate = contracts_verified / contracts_deployed if contracts_deployed > 0 else 0

# Recent highlights (score > threshold)
MIN_SCORE = float(os.environ.get('MIN_SCORE', '0.60'))
highlights = [c for c in recent_contracts if c.get('score', 0) >= MIN_SCORE]
```

## Step 3: Developer Funnel Snapshot

```python
with open('memory/developer-journeys.json') as f:
    journeys = json.load(f)

devs = journeys.get('developers', {})

stage_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
for dev in devs.values():
    stage = dev.get('stage', 0)
    for s in range(1, stage + 1):
        stage_counts[s] += 1

# Conversion rates
conversion_rates = {}
for i in range(1, 6):
    if stage_counts[i] > 0:
        conversion_rates[f'stage_{i}_to_{i+1}'] = round(stage_counts[i+1] / stage_counts[i], 3)
    else:
        conversion_rates[f'stage_{i}_to_{i+1}'] = 0.0

# Find biggest drop-off
biggest_dropoff = min(conversion_rates.items(), key=lambda x: x[1])

dropoff_diagnosis = {
    'stage_1_to_2': "Developers get faucet funds but don't send any transactions. Possible causes: unclear RPC setup docs, wallet config friction, no starter templates.",
    'stage_2_to_3': "Developers interact with the chain but don't deploy contracts. Possible causes: no deploy guides, foundry/hardhat templates missing or broken.",
    'stage_3_to_4': "Developers deploy but don't verify their contracts. Possible causes: Blockscout verification flow is unclear or broken, developers don't know verification improves discoverability.",
    'stage_4_to_5': "Verified deployers don't deploy a second project. Possible causes: single-project explorers, lack of hackathon/grant incentives for repeated building.",
    'stage_5_to_6': "Multi-deployers don't attract organic users. Possible causes: no user-facing apps, bot-heavy testing, no marketing channels."
}

diagnosis_text = dropoff_diagnosis.get(biggest_dropoff[0], "Unknown drop-off pattern.")

# Update funnel snapshot
journeys['funnel_snapshot'] = {
    'date': DIGEST_DATE,
    'stage_1_faucet': stage_counts[1],
    'stage_2_first_tx': stage_counts[2],
    'stage_3_first_deploy': stage_counts[3],
    'stage_4_verified': stage_counts[4],
    'stage_5_second_deploy': stage_counts[5],
    'stage_6_traction': stage_counts[6],
    'conversion_rates': conversion_rates
}

with open('memory/developer-journeys.json', 'w') as f:
    json.dump(journeys, f, indent=2)
```

## Step 4: Anomaly Detection

```python
import math, json

with open('memory/baselines.json') as f:
    baselines = json.load(f)

learning_mode = baselines.get('learning_mode', True)
metrics_data = baselines.get('metrics', {})
LEARNING_DAYS = int(os.environ.get('LEARNING_DAYS', 14))
MILD_Z = float(os.environ.get('MILD_Z', 2.0))
SIGNIFICANT_Z = float(os.environ.get('SIGNIFICANT_Z', 3.0))

current_metrics = {
    'organic_dau': engagement['organic_dau'],
    'total_transactions': engagement['total_transactions'],
    'contracts_deployed': contracts_deployed,
    'verification_rate': verification_rate,
    'avg_block_time': chain_health['avg_block_time']
}

anomalies = []

if learning_mode:
    # Accumulate baseline data
    for metric_name, value in current_metrics.items():
        if metric_name not in metrics_data:
            metrics_data[metric_name] = {'values': [], 'count': 0}
        metrics_data[metric_name]['values'].append(value)
        metrics_data[metric_name]['count'] += 1

    # Check if we have enough data to exit learning mode
    sample_count = min(m['count'] for m in metrics_data.values()) if metrics_data else 0
    if sample_count >= LEARNING_DAYS:
        # Compute baselines
        for metric_name, data in metrics_data.items():
            values = data['values']
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / len(values)
            std_dev = math.sqrt(variance) if variance > 0 else 0.001
            metrics_data[metric_name]['mean'] = mean
            metrics_data[metric_name]['std_dev'] = std_dev

        baselines['learning_mode'] = False
        baselines['baseline_ready'] = DIGEST_TIME
        print(f"ANOMALY_DETECTION: Exiting learning mode after {sample_count} days. Baselines established.")
else:
    # Detection mode — compute z-scores
    for metric_name, value in current_metrics.items():
        if metric_name in metrics_data:
            mean = metrics_data[metric_name].get('mean', value)
            std_dev = metrics_data[metric_name].get('std_dev', 1)
            z_score = (value - mean) / std_dev if std_dev > 0 else 0

            if abs(z_score) >= SIGNIFICANT_Z:
                anomalies.append({
                    'metric': metric_name,
                    'value': value,
                    'mean': round(mean, 3),
                    'z_score': round(z_score, 2),
                    'severity': 'significant',
                    'direction': 'spike' if z_score > 0 else 'drop'
                })
            elif abs(z_score) >= MILD_Z:
                anomalies.append({
                    'metric': metric_name,
                    'value': value,
                    'mean': round(mean, 3),
                    'z_score': round(z_score, 2),
                    'severity': 'mild',
                    'direction': 'spike' if z_score > 0 else 'drop'
                })

# Update baselines with rolling window (keep last 30 days)
BASELINE_WINDOW = 30
for metric_name, value in current_metrics.items():
    if metric_name not in metrics_data:
        metrics_data[metric_name] = {'values': [], 'count': 0}
    metrics_data[metric_name]['values'] = metrics_data[metric_name]['values'][-BASELINE_WINDOW:]
    metrics_data[metric_name]['values'].append(value)
    metrics_data[metric_name]['count'] = len(metrics_data[metric_name]['values'])

baselines['metrics'] = metrics_data
if not baselines.get('baseline_start'):
    baselines['baseline_start'] = DIGEST_TIME

with open('memory/baselines.json', 'w') as f:
    json.dump(baselines, f, indent=2)
```

Send anomaly alerts for significant anomalies:

```bash
for anomaly in significant_anomalies:
  MSG=$(cat skills/nexus-testnet-monitor/templates/slack-anomaly.md \
    | sed "s/{{METRIC}}/${anomaly[metric]}/g" \
    | sed "s/{{VALUE}}/${anomaly[value]}/g" \
    | sed "s/{{MEAN}}/${anomaly[mean]}/g" \
    | sed "s/{{Z_SCORE}}/${anomaly[z_score]}/g" \
    | sed "s/{{DIRECTION}}/${anomaly[direction]}/g" \
    | sed "s/{{DATE}}/$DIGEST_DATE/g")
  ./notify --channel="#nexus-testnet-ops" --severity="anomaly" --message="$MSG"
done
```

## Step 5: Goals Progress

```python
import yaml

with open('skills/nexus-testnet-monitor/config/goals.yml') as f:
    goals_config = yaml.safe_load(f)  # [TODO: install pyyaml if not available, else parse with regex]

goals_progress = []
for goal in goals_config.get('goals', {}).get('short_term', []):
    metric = goal.get('metric')
    target = goal.get('target')
    current = current_metrics.get(metric, None)

    if current is not None and target:
        pct = round((current / target) * 100, 1)
        status_emoji = '🟢' if pct >= 80 else '🟡' if pct >= 50 else '🔴'
        goals_progress.append({
            'metric': metric,
            'current': current,
            'target': target,
            'pct': pct,
            'deadline': goal.get('deadline'),
            'emoji': status_emoji
        })
```

## Step 6: GitHub/Monorepo Activity

```bash
GH_COMMITS=$(curl -s \
  "https://api.github.com/repos/${GITHUB_REPO}/commits?since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)&per_page=10" \
  -H "Accept: application/vnd.github.v3+json" 2>/dev/null) || GH_COMMITS='[]'

GH_COMMIT_COUNT=$(echo "$GH_COMMITS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
GH_LATEST_MSG=$(echo "$GH_COMMITS" | python3 -c "import json,sys; items=json.load(sys.stdin); print(items[0]['commit']['message'][:100] if items else 'none')" 2>/dev/null || echo "none")
```

## Step 7: Generate Sparklines

```python
def make_sparkline(values, width=7):
    """Generate a Unicode sparkline from a list of values."""
    if not values:
        return '░' * width
    blocks = '▁▂▃▄▅▆▇█'
    min_v = min(values)
    max_v = max(values)
    if max_v == min_v:
        return '▄' * len(values)
    return ''.join(
        blocks[round((v - min_v) / (max_v - min_v) * 7)]
        for v in values
    )

# Load last 7 days of digests for sparklines
import os, glob
digest_files = sorted(glob.glob('memory/testnet-digests/*.json'))[-7:]
historical = []
for f in digest_files:
    with open(f) as fh:
        historical.append(json.load(fh))

organic_dau_7d = [d.get('organic_dau', 0) for d in historical]
tx_count_7d = [d.get('total_transactions', 0) for d in historical]
block_time_7d = [d.get('avg_block_time', 0) for d in historical]

organic_sparkline = make_sparkline(organic_dau_7d)
tx_sparkline = make_sparkline(tx_count_7d)
block_time_sparkline = make_sparkline(block_time_7d)
```

## Step 8: Format and Send Digest

Substitute all values into the daily digest template:

```bash
DIGEST_MSG=$(cat skills/nexus-testnet-monitor/templates/daily-digest.md \
  | sed "s/{{DIGEST_DATE}}/$DIGEST_DATE/g" \
  | sed "s/{{CURRENT_BLOCK}}/$CURRENT_BLOCK/g" \
  | sed "s/{{AVG_BLOCK_TIME}}/$AVG_BLOCK_TIME/g" \
  | sed "s/{{MIN_BLOCK_TIME}}/$MIN_BLOCK_TIME/g" \
  | sed "s/{{MAX_BLOCK_TIME}}/$MAX_BLOCK_TIME/g" \
  | sed "s/{{ORGANIC_DAU}}/$ORGANIC_DAU/g" \
  | sed "s/{{RAW_DAU}}/$RAW_DAU/g" \
  | sed "s/{{ORGANIC_RATIO}}/$ORGANIC_RATIO/g" \
  | sed "s/{{TOTAL_TXS}}/$TOTAL_TXS/g" \
  | sed "s/{{CONTRACTS_DEPLOYED}}/$CONTRACTS_DEPLOYED/g" \
  | sed "s/{{VERIFICATION_RATE}}/$VERIFICATION_RATE/g" \
  | sed "s/{{GAS_GWEI_AVG}}/$GAS_GWEI_AVG/g" \
  | sed "s/{{GH_COMMIT_COUNT}}/$GH_COMMIT_COUNT/g" \
  | sed "s/{{GH_LATEST_MSG}}/$GH_LATEST_MSG/g" \
  | sed "s/{{ORGANIC_SPARKLINE}}/$ORGANIC_SPARKLINE/g" \
  | sed "s/{{TX_SPARKLINE}}/$TX_SPARKLINE/g" \
  | sed "s/{{BLOCK_TIME_SPARKLINE}}/$BLOCK_TIME_SPARKLINE/g" \
  | sed "s/{{FUNNEL_STAGE_3}}/$FUNNEL_STAGE_3/g" \
  | sed "s/{{FUNNEL_STAGE_6}}/$FUNNEL_STAGE_6/g" \
  | sed "s/{{BIGGEST_DROPOFF}}/$BIGGEST_DROPOFF/g" \
  | sed "s/{{DROPOFF_DIAGNOSIS}}/$DROPOFF_DIAGNOSIS/g" \
  | sed "s/{{DAU_TARGET}}/$DAU_TARGET/g" \
  | sed "s/{{DEPLOY_TARGET}}/$DEPLOY_TARGET/g" \
  | sed "s/{{ANOMALY_COUNT}}/${#anomalies[@]}/g")

./notify --channel="#nexus-testnet-product" --severity="digest" --message="$DIGEST_MSG"
```

## Step 9: Persist Daily Snapshot

```python
snapshot = {
    'date': DIGEST_DATE,
    'generated_at': DIGEST_TIME,
    'chain_health': {
        'current_block': current_block,
        'avg_block_time': avg_block_time,
        'min_block_time': min_block_time,
        'max_block_time': max_block_time
    },
    'engagement': {
        'raw_dau': engagement['raw_dau'],
        'organic_dau': engagement['organic_dau'],
        'organic_ratio': engagement['organic_ratio'],
        'total_transactions': engagement['total_transactions'],
        'bot_flagged': engagement['bot_flagged_count']
    },
    'contracts': {
        'deployed_24h': contracts_deployed,
        'verified_24h': contracts_verified,
        'verification_rate': verification_rate,
        'highlights': len(highlights)
    },
    'developer_funnel': {
        'stage_3_deploy': stage_counts[3],
        'stage_4_verified': stage_counts[4],
        'stage_6_traction': stage_counts[6],
        'biggest_dropoff': biggest_dropoff[0],
        'dropoff_rate': biggest_dropoff[1]
    },
    'monorepo': {
        'commits_24h': int(GH_COMMIT_COUNT),
        'latest_commit': GH_LATEST_MSG
    },
    'anomalies': anomalies,
    'goals_progress': goals_progress
}

with open(f'memory/testnet-digests/{DIGEST_DATE}.json', 'w') as f:
    json.dump(snapshot, f, indent=2)

print(f"Daily digest complete: {DIGEST_DATE}")
```
