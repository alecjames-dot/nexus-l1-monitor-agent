---
name: nexus-competitive-bench
description: Runs monthly on the 1st. Compares Nexus testnet metrics against peer exchange L1 chains (Sei, Hyperliquid, Injective, dYdX). Uses DefiLlama API and web search for peer data. Generates comparison table and narrative analysis with actionable gap identification.
schedule: "0 10 1 * *"
---

# Nexus Competitive Benchmark

## Prerequisites

```bash
CONFIG_DIR="skills/nexus-testnet-monitor/config"
BENCHMARKS=$(cat "$CONFIG_DIR/benchmarks.yml")
ENDPOINTS=$(cat "$CONFIG_DIR/endpoints.yml")

BENCH_DATE=$(date -u +%Y-%m)
BENCH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BENCH_FILE="memory/benchmarks/${BENCH_DATE}.md"

mkdir -p memory/benchmarks
```

## Step 1: Collect Peer Data

Query DefiLlama for TVL and chain stats:

```bash
# DefiLlama chains endpoint returns all tracked chains
DEFILLAMA_CHAINS=$(curl -s --connect-timeout 15 --max-time 60 \
  "https://api.llama.fi/v2/chains" \
  -H "Accept: application/json" 2>/dev/null) || DEFILLAMA_CHAINS='[]'

echo "$DEFILLAMA_CHAINS" | python3 -c "
import json, sys

chains = json.load(sys.stdin)
chains_by_slug = {c.get('gecko_id', c.get('name', '')).lower(): c for c in chains}

peers = ['sei', 'hyperliquid', 'injective', 'dydx']
results = {}
for peer in peers:
    # Try multiple slug variations
    for slug in [peer, peer.replace('dydx', 'dydx-chain'), peer + '-chain']:
        if slug in chains_by_slug:
            c = chains_by_slug[slug]
            results[peer] = {
                'name': c.get('name', peer),
                'tvl': c.get('tvl', 'N/A'),
                'chainId': c.get('chainId', 'N/A'),
            }
            break
    if peer not in results:
        results[peer] = {'name': peer, 'tvl': 'N/A (not in DefiLlama)'}

print(json.dumps(results, indent=2))
" 2>/dev/null || echo '{}'
```

Use web search to supplement with block time, DAU, and gas data for each peer:

For each peer chain in `config/benchmarks.yml`, use web search to find recent public data:
- Search: `"{CHAIN_NAME} blockchain block time 2025 2026"`
- Search: `"{CHAIN_NAME} daily active addresses 2025"`
- Search: `"{CHAIN_NAME} daily transactions 2025"`
- Search: `"{CHAIN_NAME} gas fees gwei 2025"`
- Search: `"{CHAIN_NAME} monthly new contracts deployed"`

Note all sourced data with dates and URLs in the report. Mark unavailable metrics as `N/A`.

```python
# Peer data template — filled from web searches
# [TODO: fill with real data from web searches at report generation time]
peer_data = {
    'sei': {
        'name': 'Sei',
        'chain_type': 'exchange_l1',
        'block_time_ms': 'N/A',  # Fill from web search
        'daily_active_addresses': 'N/A',
        'daily_transactions': 'N/A',
        'monthly_contracts': 'N/A',
        'gas_cost_usd': 'N/A',
        'tvl_usd': 'N/A',  # Fill from DefiLlama
        'time_to_finality_s': 'N/A',
        'notes': 'Parallel EVM, Twin Turbo consensus. Live mainnet.'
    },
    'hyperliquid': {
        'name': 'Hyperliquid',
        'chain_type': 'exchange_l1',
        'block_time_ms': 'N/A',
        'daily_active_addresses': 'N/A',
        'daily_transactions': 'N/A',
        'monthly_contracts': 'N/A',
        'gas_cost_usd': '0 (gasless)',
        'tvl_usd': 'N/A',
        'time_to_finality_s': 'N/A',
        'notes': 'Custom HyperBFT consensus. Gasless. Perps-focused.'
    },
    'injective': {
        'name': 'Injective',
        'chain_type': 'exchange_l1',
        'block_time_ms': 'N/A',
        'daily_active_addresses': 'N/A',
        'daily_transactions': 'N/A',
        'monthly_contracts': 'N/A',
        'gas_cost_usd': 'N/A',
        'tvl_usd': 'N/A',
        'time_to_finality_s': 'N/A',
        'notes': 'Cosmos SDK, Tendermint BFT. Built-in order book module.'
    },
    'dydx': {
        'name': 'dYdX Chain',
        'chain_type': 'exchange_l1',
        'block_time_ms': 'N/A',
        'daily_active_addresses': 'N/A',
        'daily_transactions': 'N/A',
        'monthly_contracts': 'N/A',
        'gas_cost_usd': 'N/A',
        'tvl_usd': 'N/A',
        'time_to_finality_s': 'N/A',
        'notes': 'Cosmos SDK, dedicated perps chain. Off-chain matching.'
    }
}
```

## Step 2: Collect Nexus Data

Read from most recent digest and weekly report:

```python
import json, glob

# Latest digest
digest_files = sorted(glob.glob('memory/testnet-digests/*.json'))
latest_digest = {}
if digest_files:
    with open(digest_files[-1]) as f:
        latest_digest = json.load(f)

# Latest weekly trend
trend_files = sorted(glob.glob('memory/testnet-trends/week-*.md'))
latest_trend = ''
if trend_files:
    with open(trend_files[-1]) as f:
        latest_trend = f.read()

nexus_data = {
    'name': 'Nexus Testnet',
    'chain_type': 'exchange_l1',
    'chain_id': 3945,
    'status': 'testnet (not mainnet)',
    'block_time_ms': round(latest_digest.get('chain_health', {}).get('avg_block_time', 0) * 1000),
    'daily_active_addresses': latest_digest.get('engagement', {}).get('organic_dau', 0),
    'daily_transactions': latest_digest.get('engagement', {}).get('total_transactions', 0),
    'monthly_contracts': 'see registry',
    'gas_cost_usd': 'near-zero (testnet)',
    'tvl_usd': 0,  # Testnet — no real TVL
    'time_to_finality_s': 'BFT (instant)',
    'notes': 'Dual-block: NexusCore co-processors at 50-100ms, NexusEVM every 4-10 Core blocks. EVM-compatible. Pre-mainnet.'
}
```

## Step 3: Generate Comparison Table

```python
metrics = [
    ('Block time (ms)', 'block_time_ms'),
    ('Daily active addresses', 'daily_active_addresses'),
    ('Daily transactions', 'daily_transactions'),
    ('Monthly new contracts', 'monthly_contracts'),
    ('Gas cost (USD)', 'gas_cost_usd'),
    ('TVL (USD)', 'tvl_usd'),
    ('Time to finality', 'time_to_finality_s'),
]

all_chains = [nexus_data] + list(peer_data.values())

table_header = "| Metric | " + " | ".join(c['name'] for c in all_chains) + " |"
table_sep = "|---|" + "---|" * len(all_chains)
table_rows = []

for metric_label, metric_key in metrics:
    row = f"| {metric_label} | "
    row += " | ".join(str(c.get(metric_key, 'N/A')) for c in all_chains)
    row += " |"
    table_rows.append(row)

comparison_table = "\n".join([table_header, table_sep] + table_rows)
```

## Step 4: Narrative Analysis

```python
narrative_sections = []

for metric_label, metric_key in metrics:
    nexus_val = nexus_data.get(metric_key)
    peer_vals = [p.get(metric_key) for p in peer_data.values() if p.get(metric_key) not in ('N/A', None, 0)]

    if nexus_val in ('N/A', None, 0) or not peer_vals:
        continue

    # Classify Nexus position
    # NOTE: Testnet vs mainnet comparison is not apples-to-apples
    narrative_sections.append(
        f"**{metric_label}:** Nexus testnet shows {nexus_val}. "
        f"Important caveat: Nexus is a pre-mainnet testnet — DAU, TVL, and transaction volume "
        f"comparisons against live mainnets are not apples-to-apples. "
        f"Block time and architectural metrics are the most meaningful comparison at this stage."
    )

# Architectural differentiation
narrative_sections.append("""**Architectural differentiation:**
Nexus is the only chain in this peer group with a *dual-block execution model* — NexusCore co-processors run at 50-100ms for latency-sensitive trading operations (matching, liquidation), while NexusEVM provides general EVM programmability every 4-10 Core blocks. This design targets the structural limitation of general-purpose EVMs for trading: you get native protocol-level matching performance without sacrificing EVM composability. No direct equivalent exists in the current exchange L1 landscape.""")
```

## Step 5: Identify Actionable Gaps

```python
gap_recommendations = []

# Block time gap
if nexus_data.get('block_time_ms', 0) > 2000:
    gap_recommendations.append("**Block time:** Testnet block times exceed 2s average. Verify NexusEVM block scheduling is functioning as designed. NexusCore's 50-100ms target is the key differentiator — ensure this is testable before mainnet launch.")

# Developer tooling gap (inferred)
gap_recommendations.append("**Developer tooling:** Sei, Injective, and dYdX all have mature SDKs and starter kits. Nexus's primary tooling advantage path is EVM compatibility — ensure Hardhat, Foundry, and viem work without modification. Verify and document any non-standard behaviors.")

# DeFi primitive gap
contract_count = len([c for c in registry.get('contracts', []) if c.get('is_exchange_relevant')])
if contract_count < 5:
    gap_recommendations.append(f"**Ecosystem seeding:** Only {contract_count} exchange-relevant contracts deployed. Peer chains built early traction via grants and protocol-level liquidity incentives. Consider a builder grant program targeting DEX/lending/perps primitives specifically.")

# Docs gap
gap_recommendations.append("**Documentation:** No peer chain documentation coverage data available for automated comparison. Manual audit recommended: benchmark Nexus docs completeness and quality against Hyperliquid's builder docs and Sei's developer hub.")
```

## Step 6: Write Report

```bash
cat > "$BENCH_FILE" << BENCH_EOF
# Nexus Competitive Benchmark — ${BENCH_DATE}

**Generated:** ${BENCH_TIME}

> **Important context:** Nexus is a pre-mainnet testnet. DAU, TVL, and transaction metrics are not comparable to live mainnets like Sei, Hyperliquid, Injective, and dYdX. Block time, architecture, and development velocity metrics are the most meaningful comparisons at this stage.

---

## Comparison Table

${COMPARISON_TABLE}

*Data sourced from: DefiLlama API + web search. Sources and dates available in raw data section below.*

---

## Narrative Analysis

${NARRATIVE_MD}

---

## Actionable Gaps

${GAPS_MD}

---

## Peer Chain Notes

$(for chain in sei hyperliquid injective dydx; do
  echo "**$(echo ${peer_data[$chain][name]}):** ${peer_data[$chain][notes]}"
  echo ""
done)

---

## Raw Data Sources

| Chain | Source | Date |
|---|---|---|
| Sei | DefiLlama + web search | ${BENCH_DATE} |
| Hyperliquid | DefiLlama + web search | ${BENCH_DATE} |
| Injective | DefiLlama + web search | ${BENCH_DATE} |
| dYdX Chain | DefiLlama + web search | ${BENCH_DATE} |

*[TODO: fill in specific URLs and dates from web search results at generation time]*
BENCH_EOF

echo "Benchmark report written to: $BENCH_FILE"
```

## Step 7: Send to Slack

```bash
BENCH_MSG=$(cat skills/nexus-testnet-monitor/templates/competitive-bench.md \
  | sed "s/{{BENCH_DATE}}/$BENCH_DATE/g" \
  | sed "s/{{COMPARISON_TABLE}}/$COMPARISON_TABLE_ESCAPED/g" \
  | sed "s/{{KEY_TAKEAWAYS}}/$KEY_TAKEAWAYS/g" \
  | sed "s/{{ERI_SCORE}}/$ERI_SCORE/g")

./notify --channel="#nexus-testnet-product" --severity="report" --message="$BENCH_MSG"
echo "Competitive benchmark complete for $BENCH_DATE."
```
