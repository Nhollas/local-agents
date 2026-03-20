# Local Autonomous Agents

AI agents that run on your machine, triggered by GitHub webhooks, powered by your Claude subscription.

A single gateway server auto-discovers agents from the `agents/` directory, routes incoming webhooks to matching handlers, and serves a live dashboard for monitoring.

See [docs/pattern.md](docs/pattern.md) for the full pattern documentation.

## Agents

| Agent | Trigger | What it does |
|-------|---------|-------------|
| PR Conventions (`/check`) | `/check` comment on a PR | Finds codebase convention violations, offers to fix them |
| PR Conventions (`/go`) | `/go` comment on a PR | Implements the selected fixes |
| PR Summary | PR opened | Posts a concise summary of what changed |

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

The gateway needs a tunnel to receive webhooks. See [docs/pattern.md](docs/pattern.md#cloudflare-tunnel-setup-one-time) for setup instructions.

## Running

```bash
# Start the gateway server and dashboard in dev mode
pnpm dev
```

This starts:
- **Gateway** on `http://localhost:3000` — receives webhooks, runs agents
- **Dashboard** on `http://localhost:5173` — live monitoring via SSE

For production:

```bash
pnpm start
```

In a separate terminal, start the tunnel:

```bash
cloudflared tunnel run pr-conventions-agent
```

## Dashboard

The dashboard shows all agent runs in real-time:
- Live connection status via SSE
- Runs grouped by agent with status badges
- Drill into run details to see tool use activity
- Kill running agents
- Dark/light theme

## Adding an Agent

Create a new directory under `agents/` with an `agent.ts` that default-exports an agent definition (or array of definitions):

```typescript
import { defineAgent } from "../core/index.ts";

export default defineAgent({
  name: "my-agent",
  triggers: [{ event: "pull_request", action: "opened" }],
  handler: async (ctx) => {
    const diff = await ctx.diff();
    await ctx.comment("Received your PR!");
  },
});
```

The gateway auto-discovers it on startup.

## Requirements

- Node.js >= 22.6.0
- pnpm
- `gh` CLI (authenticated)
- `cloudflared` (for webhook delivery)
- Claude Code (logged in with active subscription)
