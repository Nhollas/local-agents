---
name: advisor
description: Escalation pattern for when you're stuck. Spawn a stronger model as a sub-agent, give it the failing context, apply its guidance, and continue. The advisor is a one-shot consultation — it does not take over the task. Use when you have tried the same approach three or more times and it keeps failing, when you cannot form a plausible hypothesis about why something is breaking, or when the user explicitly asks for "a second opinion" / "consult the advisor".
---

# Advisor

You are stuck. The advisor is a one-shot consultation with a stronger model, not a hand-off. You bring it the problem, you receive guidance, you decide what to do with the guidance, and you keep working.

## When to invoke

Use the advisor when any of these are true:

- You have tried the same fix three or more times and it keeps failing in the same place.
- You cannot state a falsifiable hypothesis about why the current failure is happening.
- You have two reasonable approaches and no basis to pick between them.
- The user explicitly asked for a second opinion.

Do **not** invoke the advisor for:

- Tasks you simply haven't started — the advisor isn't a planner.
- Tasks the user said should be quick — pause and ask the user instead.
- Generic "is this code good?" reviews — that's the `review` skill.

## Current state of the run

<commits_so_far>
!`git log origin/{{ base_branch }}..HEAD --oneline`
</commits_so_far>

<uncommitted_state>
!`git status --short`
</uncommitted_state>

<uncommitted_diff>
!`git diff`
</uncommitted_diff>

Use these as raw material for the "What I've tried" section below. Distil to attempts, expected vs actual, and the specific question — do **not** paste the snapshots verbatim into the consultation prompt. The advisor doesn't need every diff hunk; it needs the shape of what you tried and why it failed.

## How to invoke

Spawn a single sub-agent via the `Agent` tool. Use `subagent_type: "general-purpose"` with `model: "opus"` — the SDK accepts only the family name (`"sonnet" | "opus" | "haiku"`), not full IDs.

The prompt to the advisor must be **self-contained** — the advisor sees none of your prior conversation. Include, in this order:

1. **What I'm trying to do.** One paragraph stating the goal and the user-visible behaviour the success state should have.
2. **What I've tried.** Bullet list, one bullet per attempt. For each: what you did, what you expected, what actually happened. Include the verbatim error message or test output where possible.
3. **What I've ruled out.** Bullet list. Helps the advisor avoid re-suggesting things you already know don't work.
4. **The specific question.** End with one clear question. Examples:
   - "Is my mental model of how X works wrong, and if so, where?"
   - "Which of approach A or approach B is correct, and why?"
   - "What hypothesis am I missing that would explain this failure?"

Ask the advisor for: a verdict on what's going wrong, a concrete next step, and an explicit signal if the problem is outside what it can judge from the context given.

Cap the response shape — for example, "Reply in under 300 words." The advisor's value is sharpness, not length.

## Applying the guidance

Treat the advisor's reply as a strong recommendation, not a command:

- If the verdict makes sense and you can act on it directly, do so.
- If the verdict points at something you can verify cheaply (a file to read, a command to run), verify before acting.
- If the verdict contradicts what you've already established as true, surface the contradiction in your reasoning and re-check the contradicting evidence before changing course.

When you continue working, summarise the advisor's verdict and your decision in one short paragraph so the next reader of the run log understands what changed and why.

## Anti-patterns

- **Repeated consultation.** One advisor call per stuck point. If the first call didn't unblock you, the problem is not "needs more consultation" — it's "stop and report what's missing to the user."
- **Dumping the whole transcript.** The advisor doesn't need every step you took. Distil to attempts, expected vs actual, and the question.
- **Acting on guidance without understanding it.** If you cannot restate the advisor's reasoning in your own words, you don't understand it well enough to apply it. Re-read or stop.

## After the consultation

The advisor sub-agent has exited; there is no ongoing session to return to. Resume the original task you were working on, applying or rejecting the advisor's guidance as described above. Do not spawn the advisor again for the same stuck point — if you are still blocked, stop and report what is missing to the user.
