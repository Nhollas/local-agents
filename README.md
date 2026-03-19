# Local Autonomous Agents

AI agents that run on your machine, triggered by external events, powered by your Claude subscription.

See [docs/pattern.md](docs/pattern.md) for the full pattern documentation.

## Agents

| Agent | Command | Trigger | What it does |
|-------|---------|---------|-------------|
| Conventions | `pnpm conventions-agent` | `/check` on a PR | Finds codebase convention violations, offers to fix them |
| PR Summary | `pnpm pr-summary-agent` | PR opened | Posts a concise summary of what changed |

## Setup

```bash
pnpm install
cp .env.example .env
```

### Authentication

The Agent SDK uses your existing Claude Code login automatically. Just make sure you're logged into Claude Code with an active subscription.

### Environment

Edit `.env` with your webhook secret:

```bash
# Generate a webhook secret
openssl rand -hex 32
```

### Cloudflare Tunnel

Each agent needs a tunnel to receive webhooks. See [docs/pattern.md](docs/pattern.md#cloudflare-tunnel-setup-one-time) for setup instructions.

## Running

```bash
# Terminal 1: start an agent
pnpm conventions-agent

# Terminal 2: start the tunnel
cloudflared tunnel run pr-conventions-agent
```

## Requirements

- Node.js >= 22.6.0
- pnpm
- `gh` CLI (authenticated)
- `cloudflared` (for webhook delivery)
- Claude Code (logged in with active subscription)
