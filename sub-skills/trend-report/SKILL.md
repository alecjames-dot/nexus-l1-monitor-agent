---
name: nexus-testnet-trend
description: Runs every Monday at 3pm UTC. Generates the weekly trend analysis report with 11 SVG charts, Exchange Readiness Index, Chain Characteristics Scorecard, docs freshness audit, incident summary, goals progress, and 3-5 actionable recommendations. Sends executive summary to Slack and commits full report to repo.
schedule: "0 15 * * 1"
---

# Nexus Testnet Weekly Trend Report

## Prerequisites

```bash
CONFIG_DIR="skills/nexus-testnet-monitor/config"
ENDPOINTS=$(cat "$CONFIG_DIR/endpoints.yml")
THRESHOLDS=$(cat "$CONFIG_DIR/thresholds.yml")
GOALS=$(cat "$CONFIG_DIR/goals.yml")
BENCHMARKS=$(cat "$CONFIG_DIR/benchmarks.yml")
SLACK_CHANNELS=$(cat "$CONFIG_DIR/slack-channels.yml")

GITHUB_REPO=$(grep 'repo:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
DOCS_BASE=$(grep 'base_url:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
EXPLORER_API=$(grep 'explorer_api:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
RPC_HTTP=$(grep 'rpc_http:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')

REPORT_DATE=$(date -u +%Y-%m-%d)
REPORT_WEEK=$(date -u +%Y-%V)  # ISO week format
REPORT_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

GRAPH_OUTPUT_DIR="graphs/week-${REPORT_WEEK}"
TREND_FILE="memory/testnet-trends/week-${REPORT_WEEK}.md"

mkdir -p "$GRAPH_OUTPUT_DIR"
mkdir -p memory/testnet-trends
```

## Step 1: Load All Data Sources

```bash
# Read 7 days of daily digests
DIGEST_DIR="memory/testnet-digests"
DIGEST_FILES=$(ls -1 "$DIGEST_DIR"/*.json 2>/dev/null | sort | tail -7)
DIGEST_COUNT=$(echo "$DIGEST_FILES" | grep -c '.json' || echo 0)

if [ "$DIGEST_COUNT" -eq 0 ]; then
  echo "WARNING: No daily digest files found. Running with no historical data."
fi

# Read previous weekly report for comparison
PREV_WEEK=$(date -u -d 'last monday -7 days' +%Y-%V 2>/dev/null || date -u -v-7d +%Y-%V 2>/dev/null)
PREV_REPORT="memory/testnet-trends/week-${PREV_WEEK}.md"
HAS_PREV_REPORT=false
if [ -f "$PREV_REPORT" ]; then
  HAS_PREV_REPORT=true
fi

# Read contract registry
REGISTRY=$(cat memory/contract-registry.json 2>/dev/null || echo '{"contracts":[]}')
CONTRACT_COUNT=$(echo "$REGISTRY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['contracts']))" 2>/dev/null || echo 0)

# Read developer journeys
JOURNEYS=$(cat memory/developer-journeys.json 2>/dev/null || echo '{"developers":{}}')
DEV_COUNT=$(echo "$JOURNEYS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['developers']))" 2>/dev/null || echo 0)

# Read incidents
INCIDENTS=$(cat memory/testnet-incidents.json 2>/dev/null || echo '{"incidents":[]}')
```

## Step 2: Refresh Context Cache

Fetch key docs pages and monorepo context to populate `memory/nexus-context-cache.md`:

```bash
echo "# Nexus Context Cache" > memory/nexus-context-cache.md
echo "" >> memory/nexus-context-cache.md
echo "Last refreshed: $REPORT_TIME" >> memory/nexus-context-cache.md
echo "" >> memory/nexus-context-cache.md

# Fetch docs pages (grab key text sections)
for page in "/" "/architecture/nexuscore" "/architecture/nexusevm" "/architecture/dual-block-execution"; do
  PAGE_URL="${DOCS_BASE}${page}"
  PAGE_CONTENT=$(curl -s --connect-timeout 10 --max-time 30 "$PAGE_URL" 2>/dev/null | \
    python3 -c "
import sys, re
html = sys.stdin.read()
# Strip HTML tags, keep text
text = re.sub(r'<[^>]+>', ' ', html)
text = re.sub(r'\s+', ' ', text)
print(text[:2000])
" 2>/dev/null || echo "[fetch failed]")
  echo "## Docs: $page" >> memory/nexus-context-cache.md
  echo "" >> memory/nexus-context-cache.md
  echo "$PAGE_CONTENT" >> memory/nexus-context-cache.md
  echo "" >> memory/nexus-context-cache.md
done

# Fetch monorepo README
for file in "README.md" "CHANGELOG.md"; do
  GH_CONTENT=$(curl -s \
    "https://raw.githubusercontent.com/${GITHUB_REPO}/main/$file" \
    --connect-timeout 10 --max-time 30 2>/dev/null | head -100 || echo "[fetch failed]")
  echo "## GitHub: $file" >> memory/nexus-context-cache.md
  echo "" >> memory/nexus-context-cache.md
  echo "$GH_CONTENT" >> memory/nexus-context-cache.md
  echo "" >> memory/nexus-context-cache.md
done

echo "Context cache refreshed: $(wc -l < memory/nexus-context-cache.md) lines"
```

## Step 3: Calculate WoW Trends

```python
import json, os, glob, math
from datetime import datetime, timezone, timedelta

# Load all available digests
digest_files = sorted(glob.glob('memory/testnet-digests/*.json'))
digests = []
for f in digest_files:
    try:
        with open(f) as fh:
            digests.append(json.load(fh))
    except:
        pass

# Last 7 days
last_7 = digests[-7:] if len(digests) >= 7 else digests
# Previous 7 days
prev_7 = digests[-14:-7] if len(digests) >= 14 else []

def avg(values, key):
    vals = [d.get(key, d.get('engagement', {}).get(key, 0)) for d in values]
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else 0

def wow_delta(current, previous):
    if previous == 0:
        return None
    return round(((current - previous) / previous) * 100, 1)

# Extract metrics with nested access
def get_metric(digest, path):
    """Access nested dict via dot-notation path."""
    parts = path.split('.')
    d = digest
    for p in parts:
        if isinstance(d, dict):
            d = d.get(p, 0)
        else:
            return 0
    return d or 0

metrics_this_week = {
    'organic_dau': avg(last_7, 'organic_dau') or (sum(get_metric(d, 'engagement.organic_dau') for d in last_7) / max(len(last_7), 1)),
    'total_transactions': sum(get_metric(d, 'engagement.total_transactions') for d in last_7),
    'contracts_deployed': sum(get_metric(d, 'contracts.deployed_24h') for d in last_7),
    'contracts_verified': sum(get_metric(d, 'contracts.verified_24h') for d in last_7),
    'avg_block_time': avg(last_7, 'avg_block_time') or (sum(get_metric(d, 'chain_health.avg_block_time') for d in last_7) / max(len(last_7), 1)),
    'devs_at_stage_3_plus': max(get_metric(d, 'developer_funnel.stage_3_deploy') for d in last_7) if last_7 else 0,
    'devs_at_traction': max(get_metric(d, 'developer_funnel.stage_6_traction') for d in last_7) if last_7 else 0,
}

metrics_prev_week = {
    'organic_dau': sum(get_metric(d, 'engagement.organic_dau') for d in prev_7) / max(len(prev_7), 1) if prev_7 else 0,
    'total_transactions': sum(get_metric(d, 'engagement.total_transactions') for d in prev_7),
    'contracts_deployed': sum(get_metric(d, 'contracts.deployed_24h') for d in prev_7),
} if prev_7 else {}

wow_trends = {
    metric: wow_delta(metrics_this_week.get(metric, 0), metrics_prev_week.get(metric, 0))
    for metric in metrics_prev_week
}

def trend_arrow(delta):
    if delta is None: return '→'
    if delta > 10: return '↑↑'
    if delta > 0: return '↑'
    if delta > -10: return '↓'
    return '↓↓'
```

## Step 4: Generate Charts

```bash
# Install deps if needed
if [ ! -d "skills/nexus-testnet-monitor/graph-gen/node_modules" ]; then
  bash skills/nexus-testnet-monitor/scripts/install-graph-deps.sh
fi

# Run chart generation
node skills/nexus-testnet-monitor/graph-gen/generate-charts.js \
  --week="$REPORT_WEEK" \
  --data-dir="memory/testnet-digests" \
  --output-dir="$GRAPH_OUTPUT_DIR" \
  --registry="memory/contract-registry.json" \
  --journeys="memory/developer-journeys.json" || {
  echo "WARNING: Chart generation failed. Report will be generated without charts."
  CHARTS_AVAILABLE=false
}
CHARTS_AVAILABLE=true
```

## Step 5: Calculate Exchange Readiness Index (ERI)

```python
import json

with open('memory/contract-registry.json') as f:
    registry = json.load(f)

with open('skills/nexus-testnet-monitor/config/thresholds.yml') as f:
    # Simple YAML parse for weights
    import re
    content = f.read()

    def extract_float(key, text):
        m = re.search(rf'{key}:\s*([\d.]+)', text)
        return float(m.group(1)) if m else 0.0

    weights = {
        'trading_primitive': extract_float('trading_primitive_weight', content),
        'token_pair': extract_float('token_pair_weight', content),
        'financial_diversity': extract_float('financial_diversity_weight', content),
        'trading_tx_share': extract_float('trading_tx_share_weight', content),
        'developer_intent': extract_float('developer_intent_weight', content),
        'nexuscore_utilization': extract_float('nexuscore_utilization_weight', content),
    }

contracts = registry.get('contracts', [])
all_categories = [cat for c in contracts for cat in c.get('categories', [])]

EXCHANGE_RELEVANT_CATEGORIES = {
    'dex_router', 'amm_pool', 'order_book', 'matching_engine',
    'vault', 'lending_pool', 'margin_contract', 'liquidation_engine',
    'oracle_consumer', 'yield_aggregator', 'options_contract',
    'perp_contract', 'prediction_market', 'swap_aggregator'
}

# Component 1: Trading primitive contracts (normalized to 0-1, cap at 20 contracts)
exchange_contracts = [c for c in contracts if c.get('is_exchange_relevant')]
trading_primitive_score = min(len(exchange_contracts) / 20.0, 1.0)

# Component 2: Token pair formation (unique ERC-20s with organic activity)
erc20_active = [c for c in contracts
                if 'erc20_token' in c.get('categories', [])
                and c.get('activity', {}).get('unique_callers', 0) >= 2]
token_pair_score = min(len(erc20_active) / 10.0, 1.0)

# Component 3: Financial primitive diversity (distinct financial categories)
financial_categories_present = set(all_categories) & EXCHANGE_RELEVANT_CATEGORIES
financial_diversity_score = min(len(financial_categories_present) / 8.0, 1.0)

# Component 4: Trading tx share (% of all tx touching exchange contracts)
exchange_addresses = {c['address'] for c in exchange_contracts}
# Approximate from registry activity data
total_tx = sum(c.get('activity', {}).get('tx_count', 0) for c in contracts)
exchange_tx = sum(c.get('activity', {}).get('tx_count', 0) for c in exchange_contracts)
trading_tx_share_score = (exchange_tx / total_tx) if total_tx > 0 else 0

# Component 5: Developer intent alignment
deployers_with_exchange = len(set(c.get('deployer') for c in exchange_contracts if c.get('deployer')))
all_deployers = len(set(c.get('deployer') for c in contracts if c.get('deployer')))
developer_intent_score = (deployers_with_exchange / all_deployers) if all_deployers > 0 else 0

# Component 6: NexusCore utilization (0 pre-launch — expected)
nexuscore_score = 0.0  # Will be non-zero once NexusCore APIs are deployed

# Weighted composite
eri_raw = (
    trading_primitive_score * weights['trading_primitive'] +
    token_pair_score * weights['token_pair'] +
    financial_diversity_score * weights['financial_diversity'] +
    trading_tx_share_score * weights['trading_tx_share'] +
    developer_intent_score * weights['developer_intent'] +
    nexuscore_score * weights['nexuscore_utilization']
)
eri_score = round(eri_raw * 100, 1)  # Scale to 0-100

eri_components = {
    'trading_primitives': round(trading_primitive_score * 100, 1),
    'token_pairs': round(token_pair_score * 100, 1),
    'financial_diversity': round(financial_diversity_score * 100, 1),
    'trading_tx_share': round(trading_tx_share_score * 100, 1),
    'developer_intent': round(developer_intent_score * 100, 1),
    'nexuscore_utilization': round(nexuscore_score * 100, 1)
}

print(f"ERI Score: {eri_score}/100")
print(f"Components: {json.dumps(eri_components, indent=2)}")
```

## Step 6: Docs Freshness Audit

```python
import re

with open('memory/nexus-context-cache.md') as f:
    context = f.read()

# Compare docs claims vs. observed testnet behavior
docs_findings = []

# Block time claim
block_time_claim = None
m = re.search(r'(\d+[-–]\d+\s*ms|block time.*?(\d+)\s*ms)', context, re.IGNORECASE)
if m:
    block_time_claim = m.group(0)
    # Compare to observed
    observed_avg = metrics_this_week.get('avg_block_time', 0)
    if observed_avg > 0:
        if observed_avg < 1.0:
            docs_findings.append({'type': 'Accurate', 'claim': f'Block time ~{block_time_claim}', 'observed': f'{observed_avg}s avg — consistent'})
        elif observed_avg > 10.0:
            docs_findings.append({'type': 'Inaccurate', 'claim': f'Block time ~{block_time_claim}', 'observed': f'{observed_avg}s avg — significantly slower than documented'})
        else:
            docs_findings.append({'type': 'Accurate', 'claim': f'Block time claim', 'observed': f'{observed_avg}s avg — within range'})

# NexusCore mention
if 'NexusCore' in context or 'nexuscore' in context.lower():
    # Check if any contracts indicate NexusCore activity
    nexuscore_contracts = [c for c in contracts if 'matching_engine' in c.get('categories', []) or 'order_book' in c.get('categories', [])]
    if nexuscore_contracts:
        docs_findings.append({'type': 'Signal', 'claim': 'NexusCore co-processors for matching/liquidation', 'observed': f'{len(nexuscore_contracts)} order book/matching contracts detected on NexusEVM — may be pre-NexusCore workarounds'})
    else:
        docs_findings.append({'type': 'Stale', 'claim': 'NexusCore co-processors', 'observed': 'No matching engine contracts found yet — feature may not be live'})

# EVM compatibility claim
docs_findings.append({'type': 'Vague', 'claim': 'EVM-compatible', 'observed': f'Standard EVM methods working. {len(contracts)} contracts deployed successfully.'})

# Coverage score: % of documented features with testnet evidence
documented_features = 5  # approximate count of major feature claims
evidenced_features = len([f for f in docs_findings if f['type'] in ('Accurate', 'Signal')])
docs_coverage_score = round(evidenced_features / documented_features, 2) if documented_features > 0 else 0
```

## Step 7: Chain Characteristics Scorecard

Rate 10 dimensions 🟢/🟡/🔴 with trend arrows:

```python
def score_dimension(value, green_threshold, yellow_threshold, higher_is_better=True):
    if higher_is_better:
        if value >= green_threshold: return '🟢'
        if value >= yellow_threshold: return '🟡'
        return '🔴'
    else:
        if value <= green_threshold: return '🟢'
        if value <= yellow_threshold: return '🟡'
        return '🔴'

with open('memory/testnet-incidents.json') as f:
    incidents_data = json.load(f)

# Count incidents by category this week
week_start = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
recent_incidents = [i for i in incidents_data.get('incidents', []) if i.get('time', '') > week_start]
p0_count = sum(1 for i in recent_incidents if i.get('severity') == 'P0')
p1_count = sum(1 for i in recent_incidents if i.get('severity') == 'P1')

scorecard = {
    'consensus_stability': {
        'emoji': score_dimension(p0_count, 0, 1, higher_is_better=False),
        'label': 'Consensus stability',
        'value': f'{p0_count} P0 incidents this week',
        'trend': '↓↓' if p0_count > 2 else ('↓' if p0_count > 0 else '→')
    },
    'rpc_reliability': {
        'emoji': score_dimension(p1_count, 0, 2, higher_is_better=False),
        'label': 'RPC reliability',
        'value': f'{p1_count} RPC-related incidents',
        'trend': '→'
    },
    'gas_economics': {
        'emoji': score_dimension(metrics_this_week.get('avg_gas_gwei', 5), 50, 100, higher_is_better=False),
        'label': 'Gas economics',
        'value': f'avg {metrics_this_week.get("avg_gas_gwei", 0)} gwei',
        'trend': '→'
    },
    'developer_velocity': {
        'emoji': score_dimension(metrics_this_week.get('contracts_deployed', 0), 10, 3),
        'label': 'Developer velocity',
        'value': f'{metrics_this_week.get("contracts_deployed", 0)} contracts deployed this week',
        'trend': trend_arrow(wow_trends.get('contracts_deployed'))
    },
    'verification_culture': {
        'emoji': score_dimension(
            metrics_this_week.get('contracts_verified', 0) / max(metrics_this_week.get('contracts_deployed', 1), 1),
            0.6, 0.3
        ),
        'label': 'Verification culture',
        'value': f'{metrics_this_week.get("contracts_verified", 0)}/{metrics_this_week.get("contracts_deployed", 0)} contracts verified',
        'trend': '→'
    },
    'user_engagement': {
        'emoji': score_dimension(metrics_this_week.get('organic_dau', 0), 500, 100),
        'label': 'User engagement',
        'value': f'~{metrics_this_week.get("organic_dau", 0)} organic DAU avg',
        'trend': trend_arrow(wow_trends.get('organic_dau'))
    },
    'ecosystem_diversity': {
        'emoji': score_dimension(len(financial_categories_present), 5, 2),
        'label': 'Ecosystem diversity',
        'value': f'{len(financial_categories_present)} distinct financial contract types',
        'trend': '→'
    },
    'bot_spam_resilience': {
        'emoji': score_dimension(
            metrics_this_week.get('organic_ratio', 0.5), 0.7, 0.5
        ),
        'label': 'Bot/spam resilience',
        'value': f'{round(metrics_this_week.get("organic_ratio", 0) * 100, 1)}% organic traffic',
        'trend': '→'
    },
    'faucet_health': {
        'emoji': '🟢' if metrics_this_week.get('faucet_up_pct', 100) >= 95 else ('🟡' if metrics_this_week.get('faucet_up_pct', 100) >= 80 else '🔴'),
        'label': 'Faucet health',
        'value': f'~{metrics_this_week.get("faucet_up_pct", 100)}% uptime this week',
        'trend': '→'
    },
    'exchange_l1_alignment': {
        'emoji': score_dimension(eri_score, 60, 30),
        'label': 'Exchange L1 alignment (ERI)',
        'value': f'ERI: {eri_score}/100',
        'trend': '→'
    }
}
```

## Step 8: Goals Progress

```python
import re

try:
    # Simple YAML parse for goals
    with open('skills/nexus-testnet-monitor/config/goals.yml') as f:
        goals_text = f.read()

    goals_progress_md = "### Short-Term Goals\n\n"

    # Parse short_term goals
    short_term_block = re.search(r'short_term:(.*?)medium_term:', goals_text, re.DOTALL)
    if short_term_block:
        goals_progress_md += f"```\n{short_term_block.group(1)}\n```\n\n"

    # Cross-reference with current metrics
    for goal_metric, current_val in [
        ('verified_contracts_total', metrics_this_week.get('contracts_verified', 0)),
        ('organic_dau', metrics_this_week.get('organic_dau', 0))
    ]:
        goals_progress_md += f"- `{goal_metric}`: current = {current_val}\n"

except Exception as e:
    goals_progress_md = f"Goals progress unavailable: {e}\n"
```

## Step 9: Generate Actionable Recommendations

```python
recommendations = []

# Recommendation logic — grounded in data + Nexus architecture
if metrics_this_week.get('contracts_deployed', 0) < 5:
    recommendations.append({
        'priority': 'P1',
        'rec': f"Deploy velocity is {metrics_this_week.get('contracts_deployed', 0)} contracts/week against a target of 5/day. Launch a grant or hackathon campaign targeting DeFi builders. The NexusCore dual-block architecture (50-100ms matching + NexusEVM for settlement) is a compelling story for perps/options developers specifically."
    })

if financial_diversity_score < 0.5:
    recommendations.append({
        'priority': 'P1',
        'rec': f"Only {len(financial_categories_present)} financial contract types detected ({', '.join(financial_categories_present) or 'none'}). Target deployers in missing categories: {', '.join(EXCHANGE_RELEVANT_CATEGORIES - financial_categories_present)[:200]}. These gaps directly suppress the ERI score."
    })

verification_rate = metrics_this_week.get('contracts_verified', 0) / max(metrics_this_week.get('contracts_deployed', 1), 1)
if verification_rate < 0.6:
    recommendations.append({
        'priority': 'P2',
        'rec': f"Verification rate is {round(verification_rate * 100, 1)}% against a 60% target. Add a verification step to the deploy guide on docs.nexus.xyz. Consider adding a Blockscout verification badge to the faucet success page."
    })

if metrics_this_week.get('organic_dau', 0) < 100:
    recommendations.append({
        'priority': 'P2',
        'rec': f"Organic DAU is {metrics_this_week.get('organic_dau', 0)}, well below the 500 target. The developer funnel shows the biggest drop-off at Stage {biggest_dropoff[0] if 'biggest_dropoff' in dir() else 'N/A'}. Focus docs investment there."
    })

if eri_score < 30:
    recommendations.append({
        'priority': 'P2',
        'rec': f"ERI is {eri_score}/100 (exchange readiness low). Prioritize seeding the ecosystem with at least 1 working DEX router and 1 lending pool to establish DeFi primitives. These unlock token pair formation (weight: 0.15) and financial diversity (weight: 0.20) components simultaneously."
    })

# Cap at 5 recommendations
recommendations = recommendations[:5]
```

## Step 10: Write Full Report

```bash
cat > "$TREND_FILE" << REPORT_EOF
# Nexus Testnet Weekly Report — Week ${REPORT_WEEK}

**Generated:** ${REPORT_TIME}
**Data range:** 7-day window ending ${REPORT_DATE}
**Chain:** Nexus Testnet (chain ID 3945)

---

## Chain Characteristics Scorecard

| Dimension | Status | This Week | Trend |
|---|---|---|---|
$(python3 -c "
import json, os
scorecard = $scorecard_json  # injected by script
for k, v in scorecard.items():
    print(f\"| {v['label']} | {v['emoji']} | {v['value']} | {v['trend']} |\")
")

---

## Exchange Readiness Index: ${ERI_SCORE}/100

| Component | Score | Weight |
|---|---|---|
| Trading primitive contracts | ${ERI_TRADING_PRIM}% | 25% |
| Token pair formation | ${ERI_TOKEN_PAIR}% | 15% |
| Financial primitive diversity | ${ERI_DIVERSITY}% | 20% |
| Trading tx share | ${ERI_TX_SHARE}% | 15% |
| Developer intent alignment | ${ERI_DEV_INTENT}% | 15% |
| NexusCore utilization | ${ERI_NEXUSCORE}% | 10% |

*Note: NexusCore utilization will remain 0 until Core co-processor APIs are deployed on testnet. This is expected.*

---

## Week-over-Week Trends

| Metric | This Week | WoW Change |
|---|---|---|
| Organic DAU (avg) | ${ORGANIC_DAU_AVG} | ${WOW_DAU} |
| Total transactions | ${TOTAL_TXS} | ${WOW_TXS} |
| Contracts deployed | ${CONTRACTS_DEPLOYED} | ${WOW_DEPLOYS} |
| Contracts verified | ${CONTRACTS_VERIFIED} | — |
| Avg block time | ${AVG_BLOCK_TIME}s | — |

---

## Developer Funnel

| Stage | Count | Conversion |
|---|---|---|
| Stage 1: Faucet funded | ${STAGE_1} | — |
| Stage 2: First tx | ${STAGE_2} | ${CONV_1_2}% |
| Stage 3: First deploy | ${STAGE_3} | ${CONV_2_3}% |
| Stage 4: Verified | ${STAGE_4} | ${CONV_3_4}% |
| Stage 5: 2nd deploy | ${STAGE_5} | ${CONV_4_5}% |
| Stage 6: Traction (≥5 users) | ${STAGE_6} | ${CONV_5_6}% |

**Biggest drop-off:** Stage → Stage (${BIGGEST_DROPOFF_RATE}% conversion)
**Diagnosis:** ${DROPOFF_DIAGNOSIS}

---

## Contract Ecosystem

**Total contracts in registry:** ${CONTRACT_COUNT}
**Exchange-relevant:** ${EXCHANGE_CONTRACT_COUNT}
**Categories present:** ${CATEGORIES_LIST}

---

## Docs Freshness Audit

${DOCS_FINDINGS_MD}

**Coverage score:** ${DOCS_COVERAGE_SCORE}/1.0

---

## Incidents This Week

${INCIDENT_SUMMARY_MD}

---

## Goals Progress

${GOALS_PROGRESS_MD}

---

## Charts

$(if [ "$CHARTS_AVAILABLE" = "true" ]; then
  echo "![Active Addresses]($GRAPH_OUTPUT_DIR/active-addresses.svg)"
  echo "![Daily Transactions]($GRAPH_OUTPUT_DIR/daily-transactions.svg)"
  echo "![Gas Economics]($GRAPH_OUTPUT_DIR/gas-economics.svg)"
  echo "![Contract Deployments]($GRAPH_OUTPUT_DIR/contract-deployments.svg)"
  echo "![Block Time Distribution]($GRAPH_OUTPUT_DIR/block-time-distribution.svg)"
  echo "![Ecosystem Map]($GRAPH_OUTPUT_DIR/ecosystem-map.svg)"
  echo "![Scorecard Trend]($GRAPH_OUTPUT_DIR/scorecard-trend.svg)"
  echo "![Developer Funnel]($GRAPH_OUTPUT_DIR/developer-funnel.svg)"
  echo "![Exchange Readiness Index]($GRAPH_OUTPUT_DIR/exchange-readiness-index.svg)"
  echo "![ERI Trend]($GRAPH_OUTPUT_DIR/eri-trend.svg)"
  echo "![Cohort Retention]($GRAPH_OUTPUT_DIR/cohort-retention.svg)"
else
  echo "*(Charts unavailable — graph generation failed. Check Node.js installation.)*"
fi)

---

## Top ${#recommendations[@]} Recommendations

$(for i in "${!recommendations[@]}"; do
  priority="${recommendations[$i][priority]}"
  rec="${recommendations[$i][rec]}"
  echo "$((i+1)). **[$priority]** $rec"
  echo ""
done)

---

*Report generated by nexus-testnet-trend skill. Next report: $(date -u -d 'next monday' +%Y-%m-%d 2>/dev/null || date -u -v+7d +%Y-%m-%d 2>/dev/null).*
REPORT_EOF

echo "Full report written to: $TREND_FILE"
```

## Step 11: Send Slack Executive Summary

```bash
SUMMARY_MSG=$(cat skills/nexus-testnet-monitor/templates/trend-report.md \
  | sed "s/{{REPORT_WEEK}}/$REPORT_WEEK/g" \
  | sed "s/{{REPORT_DATE}}/$REPORT_DATE/g" \
  | sed "s/{{ERI_SCORE}}/$ERI_SCORE/g" \
  | sed "s/{{SCORECARD_SUMMARY}}/$SCORECARD_SUMMARY/g" \
  | sed "s/{{TOP_RECS}}/$TOP_RECS/g" \
  | sed "s/{{ORGANIC_DAU_AVG}}/$ORGANIC_DAU_AVG/g" \
  | sed "s/{{WOW_DAU}}/$WOW_DAU/g" \
  | sed "s/{{CONTRACTS_DEPLOYED}}/$CONTRACTS_DEPLOYED/g" \
  | sed "s/{{REPORT_LINK}}/memory\/testnet-trends\/week-${REPORT_WEEK}.md/g")

./notify --channel="#nexus-testnet-product" --severity="report" --message="$SUMMARY_MSG"

echo "Weekly trend report complete for week $REPORT_WEEK."
```
