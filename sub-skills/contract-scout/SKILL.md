---
name: nexus-contract-scout
description: Runs every 6 hours. Discovers new contracts deployed on the Nexus testnet, classifies them by type and exchange relevance, filters wash/bot activity, scores by engagement quality, and highlights notable contracts to Slack. Updates contract registry and developer journey tracking.
schedule: "0 */6 * * *"
---

# Nexus Contract Scout

## Prerequisites

```bash
CONFIG_DIR="skills/nexus-testnet-monitor/config"
RPC_HTTP=$(grep 'rpc_http:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
EXPLORER_API=$(grep 'explorer_api:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')
MIN_INTERACTORS=$(grep 'min_unique_interactors:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
MIN_SCORE=$(grep 'min_score_for_highlight:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
WASH_THRESHOLD=$(grep 'wash_filter_threshold:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')
HIGHLIGHT_MAX=$(grep 'highlight_max_per_run:' "$CONFIG_DIR/thresholds.yml" | awk '{print $2}')

# Read current registry
REGISTRY=$(cat memory/contract-registry.json 2>/dev/null || echo '{"contracts":[],"last_scout_block":0,"last_scout_time":null}')
LAST_SCOUT_BLOCK=$(echo "$REGISTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['last_scout_block'])")

# Read architecture context
CONTEXT=$(cat memory/nexus-context-cache.md 2>/dev/null || echo "")

SCOUT_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## Step 1: Discover New Contracts

Query Blockscout v2 for contracts deployed after `last_scout_block`:

```bash
# [TODO: verify Blockscout v2 response schema for this endpoint]
# Try v2 first, fall back to v1 if needed
CONTRACTS_RESPONSE=$(curl -s \
  --connect-timeout 15 \
  --max-time 60 \
  -H "Accept: application/json" \
  "${EXPLORER_API}/v2/smart-contracts?filter=new&limit=50" 2>/dev/null) || CONTRACTS_RESPONSE=""

HTTP_CHECK=$(echo "$CONTRACTS_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok')" 2>/dev/null || echo "error")

if [ "$HTTP_CHECK" = "error" ]; then
  # Try v1 fallback
  # [TODO: verify Blockscout v1 contract list endpoint]
  CONTRACTS_RESPONSE=$(curl -s \
    --connect-timeout 15 \
    --max-time 60 \
    -H "Accept: application/json" \
    "${EXPLORER_API}/api?module=contract&action=listcontracts&filter=verified&page=1&offset=50" 2>/dev/null) || CONTRACTS_RESPONSE=""
fi
```

Parse the contract list and filter to those deployed after `last_scout_block`:

```python
import json, sys, os

registry_data = json.loads(os.environ.get('REGISTRY', '{}'))
last_block = registry_data.get('last_scout_block', 0)

# Parse Blockscout v2 response
# Expected shape: {"items": [{"address": {"hash": "0x..."}, "block_number": N, ...}], "next_page_params": {...}}
# [TODO: verify exact Blockscout v2 response field names]
try:
    response = json.loads(os.environ.get('CONTRACTS_RESPONSE', '{}'))
    items = response.get('items', response.get('result', []))
except:
    items = []

new_contracts = [c for c in items if c.get('block_number', 0) > last_block]
print(json.dumps(new_contracts))
```

## Step 2: Classify Each Contract

For each new contract, determine its type and exchange relevance.

**Known function signatures to detect (first 4 bytes of keccak256):**

| Category | Selector | Function |
|---|---|---|
| ERC-20 | `0xa9059cbb` | transfer(address,uint256) |
| ERC-20 | `0x095ea7b3` | approve(address,uint256) |
| ERC-20 | `0x70a08231` | balanceOf(address) |
| ERC-721 | `0x6352211e` | ownerOf(uint256) |
| ERC-721 | `0xc87b56dd` | tokenURI(uint256) |
| DEX/AMM | `0x38ed1739` | swapExactTokensForTokens |
| DEX/AMM | `0xe8e33700` | addLiquidity |
| DEX/AMM | `0xbaa2abde` | removeLiquidity |
| DEX/AMM | `0xd06ca61f` | getAmountsOut |
| Vault | `0xb6b55f25` | deposit(uint256) |
| Vault | `0x2e1a7d4d` | withdraw(uint256) |
| Vault | `0x01e1d114` | totalAssets() |
| Order book | `0x942b6a3d` | placeOrder (approximate) |
| Order book | `0x2da68a17` | cancelOrder (approximate) |
| Oracle | `0xfeaf968c` | latestRoundData() |
| Lending | `0xc5ebeaec` | borrow(uint256) |
| Lending | `0x573ade81` | repay(uint256) |
| Perp | `0xb97dd9e2` | openPosition (approximate) |
| Liquidation | `0xab9c4b5d` | liquidate (approximate) |

For each contract:

```python
import json

EXCHANGE_CATEGORIES = {
    'dex_router', 'amm_pool', 'order_book', 'matching_engine',
    'vault', 'lending_pool', 'margin_contract', 'liquidation_engine',
    'oracle_consumer', 'yield_aggregator', 'options_contract',
    'perp_contract', 'prediction_market', 'swap_aggregator'
}

ERC20_SELECTORS = {'0xa9059cbb', '0x095ea7b3', '0x70a08231', '0x18160ddd'}
ERC721_SELECTORS = {'0x6352211e', '0xc87b56dd', '0x42842e0e'}
DEX_SELECTORS = {'0x38ed1739', '0xe8e33700', '0xbaa2abde', '0xd06ca61f'}
VAULT_SELECTORS = {'0xb6b55f25', '0x2e1a7d4d', '0x01e1d114'}
ORACLE_SELECTORS = {'0xfeaf968c', '0x50d25bcd'}
LENDING_SELECTORS = {'0xc5ebeaec', '0x573ade81', '0xa415bcad'}

def classify_contract(contract_data, verified_source=None):
    categories = []
    is_exchange_relevant = False

    if verified_source:
        src = verified_source.lower()
        if 'swap' in src or 'dex' in src or 'router' in src:
            categories.append('dex_router')
        if 'amm' in src or 'pool' in src or 'pair' in src:
            categories.append('amm_pool')
        if 'vault' in src or 'strategy' in src:
            categories.append('vault')
        if 'orderbook' in src or 'order_book' in src or 'orderbook' in src:
            categories.append('order_book')
        if 'oracle' in src or 'pricefeed' in src or 'price_feed' in src:
            categories.append('oracle_consumer')
        if 'lending' in src or 'borrow' in src or 'lend' in src:
            categories.append('lending_pool')
        if 'perp' in src or 'perpetual' in src or 'futures' in src:
            categories.append('perp_contract')
        if 'option' in src:
            categories.append('options_contract')
        if 'liquidat' in src:
            categories.append('liquidation_engine')
        if 'yield' in src or 'aggregat' in src:
            categories.append('yield_aggregator')

    # Detect standard token types
    if any(sel in str(contract_data) for sel in ERC20_SELECTORS):
        categories.append('erc20_token')
    if any(sel in str(contract_data) for sel in ERC721_SELECTORS):
        categories.append('erc721_nft')
    if any(sel in str(contract_data) for sel in DEX_SELECTORS):
        if 'dex_router' not in categories:
            categories.append('dex_router')
    if any(sel in str(contract_data) for sel in VAULT_SELECTORS):
        if 'vault' not in categories:
            categories.append('vault')
    if any(sel in str(contract_data) for sel in ORACLE_SELECTORS):
        if 'oracle_consumer' not in categories:
            categories.append('oracle_consumer')

    is_exchange_relevant = bool(set(categories) & EXCHANGE_CATEGORIES)

    return {
        'categories': categories,
        'is_exchange_relevant': is_exchange_relevant,
        'primary_category': categories[0] if categories else 'unknown'
    }
```

## Step 3: Measure Activity Per Contract

For each contract, query Blockscout for interaction data:

```bash
# [TODO: verify Blockscout v2 address transactions endpoint]
query_contract_activity() {
  local ADDRESS="$1"

  # Get transaction count and unique callers
  TX_DATA=$(curl -s \
    --connect-timeout 10 \
    --max-time 30 \
    "${EXPLORER_API}/v2/addresses/${ADDRESS}/transactions?limit=50" \
    -H "Accept: application/json" 2>/dev/null) || TX_DATA='{}'

  echo "$TX_DATA"
}

# For ERC-20 tokens, also get token stats
query_token_stats() {
  local ADDRESS="$1"
  TOKEN_DATA=$(curl -s \
    --connect-timeout 10 \
    --max-time 30 \
    "${EXPLORER_API}/v2/tokens/${ADDRESS}" \
    -H "Accept: application/json" 2>/dev/null) || TOKEN_DATA='{}'
  echo "$TOKEN_DATA"
}
```

Parse unique callers and interaction count:

```python
def parse_activity(tx_response):
    # [TODO: verify Blockscout v2 transactions response schema]
    # Expected: {"items": [{"from": {"hash": "0x..."}, ...}], "next_page_params": {...}}
    try:
        data = json.loads(tx_response) if isinstance(tx_response, str) else tx_response
        items = data.get('items', data.get('result', []))
        tx_count = len(items)
        unique_senders = len(set(
            tx.get('from', {}).get('hash', tx.get('from', ''))
            for tx in items
            if tx.get('from')
        ))
        return {'tx_count': tx_count, 'unique_callers': unique_senders, 'raw_items': items}
    except:
        return {'tx_count': 0, 'unique_callers': 0, 'raw_items': []}
```

## Step 4: Wash/Bot Filtering

Apply filters and flag suspicious activity:

```python
def is_wash_filtered(activity, threshold=0.80):
    """Return True if contract should be excluded due to wash/bot activity."""
    items = activity.get('raw_items', [])
    if not items:
        return False

    tx_count = len(items)
    if tx_count == 0:
        return False

    # Check concentration: if top 3 senders account for >threshold of all txs
    sender_counts = {}
    for tx in items:
        sender = tx.get('from', {}).get('hash', tx.get('from', 'unknown'))
        sender_counts[sender] = sender_counts.get(sender, 0) + 1

    top_3 = sorted(sender_counts.values(), reverse=True)[:3]
    top_3_share = sum(top_3) / tx_count if tx_count > 0 else 0

    if top_3_share > threshold:
        return True  # Concentrated — likely wash

    return False

def is_circular_token_transfer(items, window_size=100):
    """Detect A→B→C→A circular transfer patterns."""
    # Build directed graph of transfers
    edges = set()
    for tx in items[:window_size]:
        sender = tx.get('from', {}).get('hash', '')
        receiver = tx.get('to', {}).get('hash', tx.get('to', ''))
        if sender and receiver and sender != receiver:
            edges.add((sender, receiver))

    # Check for 3-cycles: A→B, B→C, C→A all in the same set
    for (a, b) in edges:
        for (b2, c) in edges:
            if b2 == b and c != a:
                if (c, a) in edges:
                    return True  # Circular pattern detected
    return False

def has_no_activity_after_24h(contract, activity, current_time):
    """Flag contracts deployed >24h ago with zero interactions."""
    deploy_time = contract.get('deployed_at', current_time)
    age_hours = (current_time - deploy_time) / 3600
    if age_hours > 24 and activity['tx_count'] == 0:
        return True
    return False
```

## Step 5: Score Remaining Contracts

```python
def score_contract(contract, activity, deployer_history, classification):
    """Compute composite engagement score 0–1."""

    # Component 1: Unique interactors (weight: 0.30)
    unique_callers = activity.get('unique_callers', 0)
    interactor_score = min(unique_callers / 50.0, 1.0)  # 50+ callers = max score

    # Component 2: Interaction growth rate over 24h (weight: 0.20)
    # Approximate: if >50% of interactions are in the last 24h, growth is strong
    recent_ratio = activity.get('recent_24h_ratio', 0.5)
    growth_score = recent_ratio

    # Component 3: Verification status (weight: 0.15)
    is_verified = contract.get('is_verified', False)
    verification_score = 1.0 if is_verified else 0.3

    # Component 4: Contract complexity — avg gas per call (weight: 0.15)
    avg_gas = activity.get('avg_gas_used', 0)
    # Normalize: 21000 = simple transfer (low complexity), 500000+ = complex (high)
    complexity_score = min(avg_gas / 500000.0, 1.0) if avg_gas > 0 else 0.1

    # Component 5: Deployer reputation (weight: 0.20)
    deployer_active_contracts = deployer_history.get('active_contract_count', 0)
    deployer_score = min(deployer_active_contracts / 5.0, 1.0)  # 5+ active = max

    composite = (
        interactor_score * 0.30 +
        growth_score * 0.20 +
        verification_score * 0.15 +
        complexity_score * 0.15 +
        deployer_score * 0.20
    )

    return {
        'composite_score': round(composite, 3),
        'components': {
            'unique_interactors': round(interactor_score, 3),
            'interaction_growth': round(growth_score, 3),
            'verification': round(verification_score, 3),
            'complexity': round(complexity_score, 3),
            'deployer_reputation': round(deployer_score, 3)
        }
    }
```

## Step 6: Highlight and Notify

For contracts scoring above `min_score_for_highlight`, send a Slack notification:

```python
def generate_architecture_context(contract, classification, nexus_context):
    """Cross-reference with Nexus architecture for actionable insight."""
    categories = classification.get('categories', [])
    notes = []

    if 'order_book' in categories or 'matching_engine' in categories:
        notes.append("🏗️ *Architecture note:* This looks like an order book or matching engine. NexusCore co-processors handle matching natively at the protocol level — this may be a migration candidate or indicate a developer exploring EVM-based trading primitives before NexusCore APIs are available.")

    if 'vault' in categories or 'lending_pool' in categories or 'yield_aggregator' in categories:
        notes.append("💰 *DeFi signal:* Vault/lending primitive deployed — positive signal for DeFi ecosystem growth on Nexus.")

    if 'perp_contract' in categories or 'options_contract' in categories:
        notes.append("📈 *Exchange alignment:* Perpetuals or options contract. Directly aligned with the Nexus exchange L1 thesis.")

    if 'dex_router' in categories or 'amm_pool' in categories:
        notes.append("🔄 *DEX activity:* AMM/DEX primitive. Token liquidity infrastructure forming.")

    if not notes:
        notes.append("ℹ️ General-purpose or utility contract.")

    return '\n'.join(notes)
```

Send highlight notification for top contracts (max `highlight_max_per_run`):

```bash
send_contract_highlight() {
  local ADDRESS="$1"
  local LABEL="$2"
  local SCORE="$3"
  local CATEGORY="$4"
  local DEPLOYER="$5"
  local UNIQUE_CALLERS="$6"
  local VERIFIED="$7"
  local ARCH_NOTES="$8"
  local EXPLORER_UI=$(grep 'explorer_ui:' "$CONFIG_DIR/endpoints.yml" | head -1 | awk '{print $2}' | tr -d '"')

  MSG=$(cat skills/nexus-testnet-monitor/templates/contract-highlight.md \
    | sed "s|{{ADDRESS}}|$ADDRESS|g" \
    | sed "s|{{LABEL}}|$LABEL|g" \
    | sed "s|{{SCORE}}|$SCORE|g" \
    | sed "s|{{CATEGORY}}|$CATEGORY|g" \
    | sed "s|{{DEPLOYER}}|$DEPLOYER|g" \
    | sed "s|{{UNIQUE_CALLERS}}|$UNIQUE_CALLERS|g" \
    | sed "s|{{VERIFIED}}|$VERIFIED|g" \
    | sed "s|{{ARCH_NOTES}}|$ARCH_NOTES|g" \
    | sed "s|{{EXPLORER_URL}}|${EXPLORER_UI}/address/${ADDRESS}|g" \
    | sed "s|{{SCOUT_TIME}}|$SCOUT_TIME|g")

  ./notify --channel="#nexus-testnet-product" --severity="info" --message="$MSG"
}
```

## Step 7: Update Contract Registry

Append all new contracts to `memory/contract-registry.json`:

```python
import json

with open('memory/contract-registry.json') as f:
    registry = json.load(f)

# Append new contracts
for contract in new_contracts_with_scores:
    entry = {
        'address': contract['address'],
        'deployed_at_block': contract['block_number'],
        'deployed_at_time': contract.get('deployed_at_time'),
        'deployer': contract.get('deployer'),
        'is_verified': contract.get('is_verified', False),
        'categories': contract['classification']['categories'],
        'primary_category': contract['classification']['primary_category'],
        'is_exchange_relevant': contract['classification']['is_exchange_relevant'],
        'score': contract['score']['composite_score'],
        'score_components': contract['score']['components'],
        'activity': {
            'tx_count': contract['activity']['tx_count'],
            'unique_callers': contract['activity']['unique_callers'],
            'avg_gas_used': contract['activity'].get('avg_gas_used', 0)
        },
        'wash_filtered': contract.get('wash_filtered', False),
        'highlighted': contract.get('highlighted', False),
        'scout_time': SCOUT_TIME
    }

    # Deduplicate by address
    existing_addresses = {c['address'] for c in registry['contracts']}
    if entry['address'] not in existing_addresses:
        registry['contracts'].append(entry)

# Update scout metadata
registry['last_scout_block'] = current_block_height
registry['last_scout_time'] = SCOUT_TIME

with open('memory/contract-registry.json', 'w') as f:
    json.dump(registry, f, indent=2)
```

## Step 8: Update Developer Journeys

For each deployer seen, update their progression through the 6-stage funnel:

```
Stage 1: Funded by faucet
Stage 2: First transaction sent
Stage 3: First contract deployed
Stage 4: Contract verified on explorer
Stage 5: Second contract deployed
Stage 6: Traction (contract has ≥5 unique organic callers)
```

```python
import json

with open('memory/developer-journeys.json') as f:
    journeys = json.load(f)

for deployer_address in new_deployer_addresses:
    if deployer_address not in journeys['developers']:
        # New developer — create entry and backfill stages
        journeys['developers'][deployer_address] = {
            'address': deployer_address,
            'first_seen': SCOUT_TIME,
            'stage': 3,  # At minimum they deployed a contract
            'stage_timestamps': {
                'stage_1_faucet': None,  # Try to backfill from faucet data
                'stage_2_first_tx': None,
                'stage_3_first_deploy': SCOUT_TIME,
                'stage_4_verified': None,
                'stage_5_second_deploy': None,
                'stage_6_traction': None
            },
            'contract_addresses': [contract['address']],
            'contract_count': 1
        }
    else:
        dev = journeys['developers'][deployer_address]
        dev['contract_addresses'].append(contract['address'])
        dev['contract_count'] = len(dev['contract_addresses'])

        # Stage 5: second deploy
        if dev['contract_count'] >= 2 and dev['stage'] < 5:
            dev['stage'] = 5
            dev['stage_timestamps']['stage_5_second_deploy'] = SCOUT_TIME

        # Stage 4: verified contract
        if contract.get('is_verified') and dev['stage'] < 4:
            dev['stage'] = 4
            dev['stage_timestamps']['stage_4_verified'] = SCOUT_TIME

        # Stage 6: traction
        if contract['activity']['unique_callers'] >= 5 and dev['stage'] < 6:
            dev['stage'] = 6
            dev['stage_timestamps']['stage_6_traction'] = SCOUT_TIME

with open('memory/developer-journeys.json', 'w') as f:
    json.dump(journeys, f, indent=2)
```

## Step 9: Silent Exit

If no contracts were discovered or highlighted:
```bash
if [ "${CONTRACTS_FOUND:-0}" -eq 0 ]; then
  echo "$(date -u +%H:%M:%SZ) CONTRACT_SCOUT_SILENT: no new contracts since block $LAST_SCOUT_BLOCK" >> "memory/logs/$(date -u +%Y-%m-%d).md"
  echo "AEON_SILENT_EXIT=true" >> "$GITHUB_ENV" 2>/dev/null || true
fi
```
