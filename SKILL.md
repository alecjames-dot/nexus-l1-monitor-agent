---
name: nexus-testnet-monitor
description: Continuous monitoring of the Nexus testnet (chain ID 3945). Tracks chain health, engagement, developer activity, contract discovery, and exchange readiness. Sends alerts and reports to Slack. Accepts conversational input to adjust priorities and goals.
schedule: orchestrator
---

# Nexus Testnet Monitor — Orchestrator

You are the orchestrator for the Nexus testnet monitoring system. When invoked, you must first determine the execution context (scheduled sub-skill vs. conversational message) and route accordingly.

## Step 1: Load Configuration

Always load these config files before doing anything else:

```bash
# Read all config files
cat skills/nexus-testnet-monitor/config/endpoints.yml
cat skills/nexus-testnet-monitor/config/thresholds.yml
cat skills/nexus-testnet-monitor/config/slack-channels.yml
cat skills/nexus-testnet-monitor/config/goals.yml
cat skills/nexus-testnet-monitor/config/benchmarks.yml
```

Store the parsed values in memory for use throughout the execution.

## Step 2: Determine Execution Context

### Scheduled Run
If the environment variable `AEON_SKILL` is set, it contains the skill name to run. Map it to the sub-skill:

| AEON_SKILL | Sub-skill path |
|---|---|
| `nexus-testnet-pulse` | `sub-skills/pulse-check/SKILL.md` |
| `nexus-testnet-digest` | `sub-skills/daily-digest/SKILL.md` |
| `nexus-contract-scout` | `sub-skills/contract-scout/SKILL.md` |
| `nexus-testnet-trend` | `sub-skills/trend-report/SKILL.md` |
| `nexus-competitive-bench` | `sub-skills/competitive-bench/SKILL.md` |

Read the sub-skill's SKILL.md and execute its instructions.

### Conversational Message
If invoked with a message (from Telegram, Slack, or Discord via Aeon's messaging bridge), parse the intent using the patterns in **Step 4** below. The input message will be in `$AEON_MESSAGE` or passed as the first argument.

## Step 3: Error Handling

If any network call fails (RPC, Blockscout, GitHub API, faucet, docs):
1. Log the failure: `echo "ERROR: [service] call failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> memory/logs/errors.md`
2. If the failure suggests the chain is down (RPC unreachable), send a P0 alert via `./notify` before exiting.
3. Continue with partial data where possible rather than aborting.
4. Never fail silently — every error must be logged.

## Step 4: Conversational Interface

Parse the incoming message and route to the appropriate handler. Check patterns in order — first match wins.

### Intent: Status Check
**Detection:** message contains any of: `status`, `how's the chain`, `how is the chain`, `anything wrong`, `health check`, `how are things`
**Handler:**
1. Read `memory/testnet-state.json`
2. Read most recent file from `memory/testnet-digests/` (sort by filename desc, take first)
3. Compose a brief status summary:
   - Current block height and last check time
   - RPC latency
   - Gas price in gwei
   - Faucet status
   - Any active incidents from `memory/testnet-incidents.json` (where `resolved: false`)
4. Send via `./notify --channel=$AEON_REPLY_CHANNEL`

### Intent: Goal-Setting
**Detection:** message contains any of: `goal`, `target`, `priority`, `focus on`, `care about`, `by end of`, `i want`, `let's aim`, `set a goal`
**Handler:**
1. Parse the goal from natural language:
   - Extract metric name (map synonyms: "verified contracts" → `verified_contracts_total`, "organic users" → `organic_dau`, etc.)
   - Extract target value (number)
   - Extract deadline (convert to ISO date: "end of March" → "2026-03-31", "in two weeks" → compute from 2026-03-13)
2. Read `config/goals.yml`
3. Check if a goal for this metric already exists in `short_term`:
   - If yes, update target, deadline, and set `status: "in_progress"`
   - If no, append a new entry
4. Write updated `config/goals.yml`
5. Reply: "Got it. Goal updated: `{metric}` → `{target}` by `{deadline}`. I'll track this in every digest."

### Intent: Focus Adjustment
**Detection:** message contains any of: `focus on`, `deprioritize`, `care less about`, `for the next`, `elevate`, `ignore for now`
**Handler:**
1. Parse elevated metrics and deprioritized metrics from the message
2. Parse duration (e.g., "for the next two weeks" → expires 2026-03-27)
3. Read `config/goals.yml`
4. Update `focus_weights`:
   ```yaml
   focus_weights:
     elevated: [<extracted metrics>]
     deprioritized: [<extracted metrics>]
     expires: <computed ISO date or null>
   ```
5. Write updated `config/goals.yml`
6. Reply: "Focus updated. Elevated: `{elevated}`. Deprioritized: `{deprioritized}`. Expires: `{expires}`."

### Intent: Ad-Hoc Query
**Detection:** message contains any of: `what was`, `how many`, `which contracts`, `what's the`, `show me`, `tell me`, `what are`, `give me`, `list`, `who`
**Handler:**
1. Determine what data is needed:
   - Block/gas/latency → `memory/testnet-state.json`
   - DAU/transactions/engagement → latest `memory/testnet-digests/YYYY-MM-DD.json`
   - Contracts → `memory/contract-registry.json`
   - Developer funnel → `memory/developer-journeys.json`
   - Incidents → `memory/testnet-incidents.json`
   - Trends → latest `memory/testnet-trends/week-*.md`
2. Read the relevant files
3. Extract and format the answer concisely
4. Send via `./notify --channel=$AEON_REPLY_CHANNEL`

### Intent: Incident Resolution
**Detection:** message matches pattern `INC-\d{4}-\d{2}-\d{2}-\d{3}` OR contains `resolved`, `root cause`, `caused by`, `post-mortem`, `fixed`
**Handler:**
1. Extract incident ID from message (pattern: `INC-YYYY-MM-DD-NNN`)
2. Read `memory/testnet-incidents.json`
3. Find the matching incident by ID
4. Update fields:
   - `resolved: true`
   - `resolved_at: "<current ISO timestamp>"`
   - `resolution_notes: "<extracted explanation from message>"`
   - `root_cause: "<extracted cause if mentioned>"`
5. Write updated `memory/testnet-incidents.json`
6. Reply: "Incident `{id}` marked resolved. Notes: `{notes}`."

### Intent: Migration Query
**Detection:** message contains any of: `mainnet`, `migrate`, `switch over`, `production`, `go live`, `launch`
**Handler:**
1. Read `config/endpoints.yml`
2. Enumerate what must change for mainnet:
   - `testnet.chain_id`: 3945 → 3946
   - `testnet.rpc_http`, `rpc_ws`, `explorer_api`, `explorer_ui`: update to mainnet URLs
   - All thresholds in `config/thresholds.yml`: review and tighten per mainnet SLAs
   - `aeon.yml` skill names: optionally clone to `nexus-mainnet-*` variants
3. Reply with the full checklist

### Intent: Unrecognized
If no pattern matches:
- Reply: "I didn't recognize that as a monitoring command. Try: status check, set a goal, query data (e.g. 'what was organic DAU yesterday?'), or incident resolution (e.g. 'INC-2026-03-13-001 resolved, caused by X')."

## Step 5: Goals Context

When dispatching any scheduled sub-skill, pass the current goals context so sub-skills can reference it. Read `config/goals.yml` and make the following available to sub-skill execution:

- `$GOAL_SHORT_TERM`: JSON array of short-term goals
- `$FOCUS_ELEVATED`: space-separated list of elevated metric names
- `$FOCUS_DEPRIORITIZED`: space-separated list of deprioritized metric names
- Check if `focus_weights.expires` is in the past — if so, clear the focus weights before passing

## Conventions

- All timestamps use ISO 8601 UTC: `2026-03-13T14:00:00Z`
- All monetary amounts in USD unless labeled otherwise
- Block heights are decimal integers
- Gas prices are in gwei (decimal)
- Scores are 0–1 floats unless labeled 0–100
- Silent runs (no alerts, nothing notable) must NOT trigger a git commit — output a single log line and exit
- The `./notify` script accepts `--channel`, `--severity`, and `--message` flags (or reads from stdin)
