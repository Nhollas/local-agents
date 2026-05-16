# Production Considerations

A working list of concerns to address before this system could credibly run in production at scale. Intentionally lightweight — naming the topics and mapping the option space, not committing to solutions. Each entry lists the realistic options and, where research turned up a genuinely clear default for our stack (K8s, AWS, Cloudflare, mixed TS/Python/Go/.NET), a leading candidate.

## Originally identified

### Observability and audit

At a deployed level we need to know everything the system did: every run, every agent, every tool call, every model interaction. Both for debugging and for after-the-fact audit.

- **Options**: keep Langfuse self-hosted (already in place); OTel Collector + Tempo + Loki + Grafana; Honeycomb; Datadog (has an LLM Observability product); custom OTel → S3 + Athena.
- Note that observability and audit don't cleanly collapse into one system. Operational traces are mutable and TTL'd; audit needs immutability, tamper evidence, and long retention. Standard pattern is to dual-write: traces to Langfuse for debugging, structured run-level events to S3 with Object Lock for audit.
- **Leading candidate**: keep Langfuse for LLM observability, add S3 + Object Lock as the immutable audit tier for run-level events. Avoid adding Datadog/Honeycomb unless we're already paying for one.

### Scale

The system should comfortably handle many concurrent runs (e.g. 50 issues at once) without falling over. This concern is largely subsumed by the job/queue layer below — agent runs are long-lived, stateful, and resumable, so "scale" here means a runtime that handles that shape, not just more workers.

### Harness-layer agnosticism

The core of the app should not be tightly coupled to the Claude Agent SDK. Important distinction: the **harness** is the agent loop — tool execution, context/memory, subagents, permissions, hooks. A model SDK (Vercel AI SDK, LiteLLM) is one layer below and does **not** replace a harness; it only abstracts the raw model call. Swapping the harness is a fundamentally different operation than swapping the model.

- **Harness options if we ever wanted to swap**:
  - Stay on Claude Agent SDK — accept the coupling. Often the right answer.
  - Build our own harness — maximum control, maximum work, and we'd lose the tool/permission/subagent machinery Claude Agent SDK gives us for free.
  - Adopt a different opinionated harness — LangGraph, Mastra, OpenAI Agents SDK, Pydantic AI. Each is its own lock-in, not an abstraction over harnesses.
- **The pragmatic seam is *above* the harness, not inside it**. Our orchestration layer (ticket pickup, sandbox lifecycle, "spawn an agent, wait for it to finish, collect its trace and PR") stays harness-agnostic. The agent loop itself stays on Claude Agent SDK until there's a concrete reason to swap. If we ever do swap, only the inner agent process changes — orchestration above doesn't.
- **Leading candidate**: keep Claude Agent SDK as the harness. Define a clean interface at the *orchestration → agent* boundary (job spec in, structured result + trace out) so the harness is a swappable unit, not woven through the codebase. No model-SDK abstraction needed because Databricks is already providing the OpenAI-compatible endpoint layer.

### Authenticated, deployed dashboard

The dashboard that currently surfaces local activity needs to be deployed and authenticated per user.

- **Options**: Cloudflare Access in front of the app, backed by the corporate IdP (Okta/Entra/Google); Cognito; Auth0; WorkOS; Clerk; raw OIDC against corporate IdP.
- **Leading candidate**: Cloudflare Access → corporate IdP. Zero extra infra, fits the existing Cloudflare stack, JWT passed to the app for identity. App reads the JWT and maps to internal roles. The SaaS auth products are over-spec for an internal tool.

### Sandboxing

What we do locally today is not sufficient. The threat model is malicious code execution inside the sandbox (prompt injection, compromised dependency) trying to reach AWS metadata, internal network, or exfil secrets.

- **Options grouped by isolation strength**:
  - *VM-level (strong)*: Firecracker DIY on EKS; AWS Fargate (managed Firecracker); Kata Containers on EKS; managed agent sandboxes — E2B, Modal, Daytona.
  - *Process-level (weaker for this threat model)*: gVisor on EKS; plain K8s pods with PSA/seccomp/AppArmor/NetworkPolicy. These block kernel exploits but not network exfil unless NetworkPolicy is correctly maintained.
  - *Wrong shape*: Cloudflare Containers/Workers Sandbox (V8 isolates — can't run arbitrary `npm install` or native builds).
- **Leading candidate (fork, not single answer)**: E2B or Fargate to move fast (Firecracker-backed, no platform eng work, lockable egress). Kata Containers on EKS if/when sandbox volume makes per-second SaaS cost hurt and we have platform bandwidth.

## Added during discussion

### Agent identity and authorization

What does the agent act *as* when it touches a repo, a Jira ticket, or opens a PR. Distinct from human auth.

- **Options**:
  - *GitHub*: GitHub App (short-lived installation tokens, scoped to repos/permissions, clear audit) over PATs. Fine-grained PATs are a fallback but still user-tied.
  - *Atlassian*: dedicated service account + API token (no App equivalent exists).
  - *AWS*: IRSA (IAM Roles for Service Accounts) so pods get short-lived AWS tokens via OIDC, no long-lived keys in cluster.
  - *Secret storage*: AWS Secrets Manager + External Secrets Operator (idiomatic K8s pattern, rotation lives in ASM); Vault as the provider-agnostic alternative.
  - *Sandbox blast radius*: a credential broker that mints short-lived scoped tokens at pod startup so the sandbox never sees the master credential.
- **Leading candidate**: GitHub App + IRSA + ASM + ESO + broker for sandbox-issued credentials.

### Budget and rate-limit enforcement

Per-run, per-team, per-day spend caps with hard kills, and backpressure that respects upstream provider rate limits.

- We already route inference through **Databricks Model Serving / AI Gateway**, which provides usage tracking, rate limits, PII detection, and per-key spend visibility. This supersedes adding a separate gateway like LiteLLM or Portkey — they would just be a second hop doing the same job.
- **What still needs designing on top of Databricks**: per-team budget enforcement (Databricks gives us the usage data, we own the policy of "team X has $Y/day"); the job scheduler's pre-dequeue check against budget state; treatment of 429s from Databricks as backpressure rather than retry-forever.
- App-code token counting remains leaky (can't predict output tokens), so in-flight spend stays at the gateway. The harness layer handles job admission.
- **Leading candidate**: Databricks AI Gateway as the in-path enforcer; a small budget-state service (or a table the scheduler queries) for per-team caps layered on top of Databricks usage data.

### Job and queue layer

Durable execution for long-running, resumable, idempotent agent runs.

- **Options**: Temporal (reference durable execution, excellent TS/Go SDKs, workflow ID as natural dedup key, native sleeps don't burn workers); AWS Step Functions (managed durable execution, awkward DSL, `waitForTaskToken` is useful for approval gates); Inngest / Trigger.dev (TS-first durable execution, lighter ops, less proven at extreme scale); Hatchet (open-source Temporal alternative); plain queue+worker (BullMQ, Celery, SQS+worker, River) — workable but you're writing the durability layer yourself.
- Queue+worker is underpowered for this workload because each retry has to reconstruct agent state. Durable execution makes that state implicit in the execution history.
- **Leading candidate**: Temporal if we want self-host on K8s and have TS or Go agent code. Trigger.dev v3 if we want a managed SaaS and stay TS-only. Step Functions only if zero-infra AWS-native is the dominant constraint.

### Offline eval harness for the agents

Run prompt/tool/model changes against fixture tickets and compare outcomes.

- **Options**: Langfuse datasets + evals (already in stack, weak on multi-turn trajectory comparison); Braintrust (best-in-class for agent evals, SaaS-only, data leaves infra); Promptfoo (good for prompt regression, awkward for multi-turn agents); Inspect (Python-native, research-grade, outcome-shaped); LangSmith (LangChain-coupled, skip); custom harness — for code-writing agents, running fixture tickets through the agent and asserting outcomes (CI green? correct files touched? diff sane?) is tractable.
- Outcome patterns worth combining: execution-based (run the PR in CI), static assertions on the diff, and LLM-as-judge calibrated against human labels.
- **MLflow open question**: the team uses Databricks; MLflow may or may not be intended as the agent tracing/eval system. MLflow 2.x has GenAI tracing and evals that compete with Langfuse + Braintrust. If we standardise on it, the eval *tooling* would be Python-first (REST API is fine for read paths, but the SDK is Python-shaped) — agent runtime itself stays whatever language we want. Worth confirming with the platform team before committing.
- **No clear single leading candidate**: Langfuse stays for tracing — don't force it to do eval. Choose Braintrust if SaaS is acceptable; build a custom harness if not; consider MLflow if there's an org-level reason to converge tooling with the data-science side.

### Mid-run approval gates

Policy-driven pauses during a run (not end-of-run PR review). Only matters if these scenarios are in our threat model.

- **Policy engine options**: hardcoded harness predicates (right for 3–6 well-known rules); OPA/Rego (worth it when policies need to update without redeploy or multiple stakeholders edit them); Cedar (RBAC-shaped, awkward fit for predicate-over-agent-state).
- **Pause/resume mechanism**: depends on the job-queue choice. Temporal signals if we go Temporal. Step Functions `waitForTaskToken` if Step Functions. SQS + state record if we're on plain queue+worker.
- **Leading candidate**: hardcoded predicates initially. Graduate to OPA only when rule count or non-engineer authorship demands it. Pause/resume primitive is a derivative of the queue-layer choice.

### Data retention and redaction

Traces contain source code and may contain secrets or sensitive data.

- **Options for redaction**:
  - *Ingest-time* (canonical): OTel Collector processor pipeline. Regex/pattern redaction for secrets; Presidio or a cheap fast model for PII. Latency cost ~20–50ms.
  - *Query-time* (backstop only): Langfuse field masking. Data is already stored — breach risk already realised.
- **Retention**: S3 lifecycle rules on the audit tier; Langfuse TTL for operational traces. Run-level events go to immutable storage; full prompt/completion bodies stay in operational traces with stricter access.
- **Leading candidate**: ingest-time redaction in the OTel Collector + tiered retention (short TTL on full traces, long retention on the redacted audit log in S3 Object Lock).

### Multiple users and teams across the org

Different users from different teams will use the system. Not necessarily a day-one isolation concern, but needs a coherent story.

- **Options**: full multi-tenant isolation at every layer (overkill for an internal tool); `team_id` tag on every run + a `(user, team, role)` table + row-level filtering in the API.
- Three roles cover most cases: viewer, operator, admin. Team memberships sync from the corporate IdP via SCIM or OIDC group claims.
- **Leading candidate**: `team_id` tagging + RBAC table + Cloudflare Access JWT mapped to roles. Defer full tenant isolation until there's a concrete reason.

## Cross-cutting observations

- The **job/queue choice constrains the mid-run approval mechanism**. Temporal → signals; Step Functions → `waitForTaskToken`; plain queue → SQS + state record. Pick the queue first.
- The **OTel Collector** is load-bearing for both observability and redaction. Investing in its pipeline pays off twice.
- **External Secrets Operator + Secrets Manager** appears in agent identity, dashboard secrets, and likely the credential broker. Standardising on it early reduces accidental sprawl.
- **Langfuse stays narrow**: tracing only. Don't stretch it to cover audit (use S3) or eval (use Braintrust or custom).
- **Cloudflare** earns its place at the perimeter (Access for auth, possibly egress controls) but not in the sandbox or LLM-gateway layer for this workload.
