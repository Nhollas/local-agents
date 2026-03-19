# Pattern: Local Autonomous Agents

Run AI agents on your machine, triggered by external events, using your Claude subscription. No API billing, no cloud infrastructure, no human in the loop until you choose to be.

## The Pattern

```
External Event (GitHub, Slack, etc.)
        │
        ▼
Cloudflare Tunnel (secure, stable URL)
        │
        ▼
Local Webhook Server (Hono)
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push Result Back (comment, commit, message)
```

Three components, same every time:

1. **Webhook server** — receives events, routes to the right handler
2. **Cloudflare Tunnel** — gives your local server a stable public URL
3. **Agent** — Claude Agent SDK `query()` with the right tools and prompt

## Why Local

- **Subscription-powered** — uses your existing Claude Code login
- **Your machine, your data** — nothing leaves your control beyond what the agent explicitly pushes
- **Full toolchain available** — the agent has access to git, pnpm, your test suite, everything an engineer has
- **No infrastructure to manage** — runs locally, tunnel handles ingress

## How to Build an Agent

### 1. Define the trigger

What external event starts the work? A GitHub webhook, a Slack message, a cron job. This determines which events your server listens for.

### 2. Define the scope

What does the agent do? Keep it narrow, specific, and objective. The best agents answer questions that have clear right answers discoverable from the context (codebase, logs, docs).

### 3. Write the server

A Hono server that receives webhooks, verifies signatures, and dispatches to your agent function. The server responds immediately (202) and processes asynchronously.

```typescript
app.post("/webhook", async (c) => {
  const payload = JSON.parse(await c.req.text());

  // Dispatch asynchronously
  handleEvent(payload).catch(console.error);

  return c.text("Processing", 202);
});
```

### 4. Write the agent

Use `query()` with the tools the agent needs and a clear prompt. The prompt should describe the role and the constraints, not step-by-step instructions — the model knows how to do its job.

```typescript
for await (const msg of query({
  prompt: "...",
  options: {
    model: "claude-sonnet-4-6",
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk",
  },
})) {
  // handle messages
}
```

### 5. Push the result

Post a comment, push commits, send a Slack message — whatever the appropriate output is. Use `gh` CLI for GitHub operations since it handles auth automatically.

## Running

Two terminals:

```bash
# Terminal 1: agent server
pnpm <agent-name>

# Terminal 2: tunnel
cloudflared tunnel run <tunnel-name>
```

## Sandboxing

For agents that modify code, use the SDK's built-in sandbox (`@anthropic-ai/sandbox-runtime`). It uses OS-level isolation (Seatbelt on macOS) to restrict filesystem writes and network access.

```typescript
sandbox: {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: ["git push"],
  filesystem: {
    allowWrite: [workDir],
  },
  network: {
    allowLocalBinding: true,
    allowedDomains: ["github.com", "api.anthropic.com"],
  },
}
```

Key points:
- `allowWrite` restricts where the agent can write — use a disposable temp directory
- `allowedDomains` restricts network access
- `excludedCommands` lets specific commands (like `git push`) run outside the sandbox when they need capabilities the sandbox blocks (e.g. Chromium for pre-push hook tests)
- Read-only agents can skip sandboxing

## Cloudflare Tunnel Setup (One-Time)

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create <tunnel-name>
cloudflared tunnel route dns <tunnel-name> <subdomain.yourdomain.com>
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-name>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <subdomain.yourdomain.com>
    service: http://localhost:<port>
  - service: http_status:404
```

Register the webhook on GitHub (or via `gh api`), pointing at `https://<subdomain.yourdomain.com>/webhook`.

## Examples in This Repo

| Agent | Trigger | What it does |
|-------|---------|-------------|
| `conventions-agent` | `/check` comment on PR | Finds codebase convention violations, offers to fix them |
| `pr-summary-agent` | PR opened | Posts a concise summary of what changed |

## Design Principles

- **Narrow scope** — each agent does one specific job well
- **Codebase as source of truth** — agents discover context by reading, not from config
- **Objective outputs** — agents answer questions with clear, verifiable answers
- **Human in the loop at the right moments** — autonomous for small, specific tasks; escalate for ambiguous decisions
- **Disposable work environments** — clone fresh, work in /tmp, clean up after
- **Same toolchain as engineers** — agents run tests, hooks, and linters the same way you do
