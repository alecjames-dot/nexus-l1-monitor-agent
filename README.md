# nexus-l1-monitor-agent

Aeon skill for monitoring the Nexus testnet (chain ID 3945) — and later mainnet (chain ID 3946).

Tracks chain health, engagement, developer activity, contract discovery, and exchange readiness. Sends alerts and reports to Slack.

## Sub-skills

| Skill | Schedule | Description |
|---|---|---|
| `pulse-check` | every 15 min | RPC health, block progression, gas price, faucet |
| `daily-digest` | daily 14:00 UTC | Engagement, contracts, developer funnel, anomaly detection |
| `contract-scout` | every 6h | New contract discovery, classification, scoring |
| `trend-report` | Monday 15:00 UTC | Weekly analysis, 11 SVG charts, ERI score, scorecard |
| `competitive-bench` | 1st of month | Peer comparison: Sei, Hyperliquid, Injective, dYdX |

## Structure

```
├── SKILL.md                  # Orchestrator + conversational interface
├── aeon.yml                  # Scheduler config
├── config/                   # All thresholds, endpoints, goals (swap for mainnet migration)
├── sub-skills/               # One SKILL.md per scheduled job
├── graph-gen/                # Node.js SVG chart generation pipeline
├── templates/                # Slack mrkdwn message templates
├── scripts/                  # rpc-check.sh, blockscout-query.sh, install-graph-deps.sh
└── memory/                   # Persistent state (committed by Aeon after each run)
```

## Mainnet migration

All URLs, thresholds, and chain config live in `config/endpoints.yml`. Uncomment the `mainnet:` block and update thresholds in `config/thresholds.yml`. No skill logic changes needed.

## Secrets required

- `SLACK_WEBHOOK_URL` — minimum for outbound alerts
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` — for bidirectional conversational interface

## Chain

- Testnet RPC: `https://testnet.rpc.nexus.xyz`
- Explorer: `https://testnet.explorer.nexus.xyz`
- Docs: `https://docs.nexus.xyz`
