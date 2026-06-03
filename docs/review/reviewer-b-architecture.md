# Reviewer B — Architecture, Harness, Maintainability

Reviewer B is the architecture and process safety gate.

## Focus

Block on:

- breaking bring-your-own-agent role separation,
- hardcoding Hermes/Claude/Codex assumptions into core abstractions,
- state-machine logic that relies on LLM self-reports instead of verification,
- project rules hidden outside harness docs/config,
- PRs that drift from `docs/spec.md` or `AGENTS.md`,
- implementation that undermines the tmux-style operator workflow,
- unrelated changes bundled into the task.

## Do Not Block On

- small implementation style differences,
- polish that can wait,
- speculative future extensibility not needed for the current slice.

## Output Standard

Prefer concise findings with file and line references.

```text
BLOCKING B-1: <title>
File: path/to/file.ts:42
Issue: ...
Why it blocks: ...
Suggested fix: ...
```

If clean:

```text
Reviewer B: PASS — no blocking architecture/harness findings.
```
