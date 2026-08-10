# Agent Guidelines

General guidelines for agents.

## Core Behavior

### Communication

- Keep replies short and easy to resume after an interruption
- Skip generic preambles (`Let me`, `I'll start by`, `Great question`)
- Lead with the answer or completed outcome
- Ground verdicts in the code, command output, or a cited source
- During ongoing work, state the current outcome and what remains without repeating the full plan
- Report failures with location and evidence first, then the cause and fix when known or the next diagnostic
- Skip routine narration, redundant recaps, closing pleasantries, and long logs
- Link known URLs as clickable Markdown, show commits as `[abc1234](url)` and always link PR or issue numbers

### Scope and judgment

- If an approach is weak, say so and propose a better one
- Fix only what was asked. Every changed line should trace to the request; mention unrelated cleanup instead of doing it
- Make reasonable assumptions for reversible, local, low-risk work
- Ask before choices that materially change the outcome or are destructive, irreversible, public, costly, security-sensitive, or cross-repo

---

## Workflow

### Session and planning

- When supported, rename the current session once its task is clear, whether the session was just created or already existed: `<ticket-id>-<descriptive-slug>` or `<descriptive-slug>`
- Before non-trivial work, read the relevant code, docs, contracts, and current worktree state
- State a short plan covering what, where, why, verification, and non-goals

### Verification

- Match proof to risk and the available surface
- Bug fixes should include a repro when feasible; refactors prove parity; features need contract proof and a runtime check
- Relevant verification must pass before work is called complete

### When blocked

- Reproduce failures and identify the root cause with evidence
- Do not skip gates or apply workarounds without explicit approval

---

## Code Principles

### Architecture

- Build small, composable pieces with narrow surfaces
- Prefer deep modules over layered complexity
- Avoid speculative configurability, abstraction, and defensive branches unrelated to the touched contract
- Prefer reversible changes when uncertain; delete dead code instead of preserving it just in case

### Flow

- Parse external input at the boundary and make illegal states unrepresentable internally
- Handle failures at touched external boundaries; make errors contextful and recoverable where possible

### Performance

- Benchmark hot paths and performance-sensitive changes with before/after numbers

### Guardrails

- Follow the target repo's language and type conventions
- Avoid weakening types or adding unchecked casts, ignores, non-null assertions, or similar escape hatches when an idiomatic validated option exists; do not globally ban established languages or syntax
- Keep linters, type checks, tests, and hooks enabled; fix root causes

### Docs

- Keep docs portable and reproducible
- Avoid volatile metrics, absolute paths, `file://`, and editor URIs

### Testing

- Prefer integration, contract, and end-to-end proof over mock-heavy unit tests
- Prefer in-process tests with controlled clocks over real timers and logger assertions unless the process boundary matters

### Source comments

- Default to writing no new source comments
- Never add comments that state the obvious or narrate the code, commit messages exist for a reason
- Add comments only for essential invariants or external constraints the code cannot express

---

## Commits and PRs

- Prefer conventional commits, title multi-commit PRs for their net change in a conventional style
- Use the repo PR template, otherwise cover Summary, Changed, Review aids, Risks, Verification, and Complexity; make it concise
- Every non-trivial PR must include a `Review aids` section with the artifact that best explains the change
  - a focused Mermaid diagram for flows or architecture with a readable orientation
  - labeled screenshots or an existing preview/artifact link for visible UI
  - put multiple related images or videos in a compact Markdown table with short labels; use two or three columns, place comparisons side by side, and leave a single artifact standalone
  - sanitized example input/output for behavior and contracts
- Use before/after when comparison matters

### Addressing PR feedback

- While addressing feedback on PR, prefer follow-up commits over amending and force-pushing
- Keep each inline review comment to one actionable concern and short
