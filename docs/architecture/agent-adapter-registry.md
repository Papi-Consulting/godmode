# Agent Adapter Registry & Command Templates

GodMode is bring-your-own-agent native: the operator maps generic **roles**
(`head`, `builder`, `reviewer_a`, `reviewer_b`) to whatever CLIs they run —
Hermes, Claude, Codex, OpenCode, OpenClaw, Gemini, or a custom command. Core
workflow code must reason about **roles, capabilities, and lifecycle**, never
about a specific vendor. This doc records how the adapter registry and command
templates deliver that (issue #5).

## Boundaries

| Concern | Owner |
| --- | --- |
| Parse/validate `.agentic/godmode.yaml`, hold safe defaults | `src/main/config.ts` |
| Resolve roles → agents, capabilities, render command templates | `src/main/agents.ts` |
| Shared, renderer-facing types | `src/shared/types.ts` |
| Expose registry over IPC (`godmode:registry:get`) | `src/main/index.ts` |
| Auditable, role-scoped command preview | `src/renderer/components/CommandPreviewPane.tsx` |

`config.ts` exposes a single `loadConfig()` that both the renderer pane view
(`getConfigState`) and the registry (`getRegistryState`) build on, so the two can
never drift. `DEFAULT_CONFIG` is the one source of safe defaults — panes and the
registry both derive from it.

## Adapter & capability model

An agent declares an `adapter` (`cli` | `mcp` | `acp` | `custom`) and a `mode`
(`interactive` | `oneshot` | `oneshot_or_interactive`). Each adapter has a
capability baseline (`ADAPTER_CAPABILITY_DEFAULTS`); per-agent `capabilities`
in config override individual keys. Effective capabilities are resolved by
`resolveCapabilities(adapter, overrides)`.

Only the `cli` adapter is launch-wired in v1 (the existing safe shell PTY). The
others exist so config and the registry can *describe* an agent without core code
branching on a transport. The default reviewer (Codex) narrows `canEditFiles` and
`canOpenPr` to `false` because reviewers comment on PRs rather than edit them — a
worked example of the override mechanism.

## Command templates

Three lifecycle steps map to renderable commands: `builder_start`,
`reviewer_start`, `builder_fix`. (`head` orchestrates and has no launch template
in v1.) Each template is a prompt string with `{{variable}}` placeholders drawn
from `TemplateContext` (issue/PR/role variables). `DEFAULT_TEMPLATES` holds safe
defaults that lead with the harness reading rules every fresh session must
follow; a project can override any kind via the optional `commands:` config
block.

`renderTemplate` substitutes bound variables and **leaves unbound tokens
intact**, returning their names. This is deliberate: a preview must read as an
explicit placeholder, never a silent blank, and the UI lists what is still
unbound. `buildPreview` renders one builder start, one start per configured
reviewer, and one builder fix.

## Auditability

Producing a `RenderedCommand` never launches anything. `commandLine` is a preview
of how GodMode *would* start the bound agent; the prompt is shown separately and
delivered per the agent's mode (streamed into the PTY for interactive agents,
passed as input for one-shot agents). The cockpit renders every card role-first
and chips it `preview · mock until launched`, with per-card `unbound` variable
markers. Real launch beyond the safe PTY is out of scope for v1.

## Failure behavior

`getRegistryState` mirrors config loading and never throws. A missing config
yields `default` (safe defaults); an invalid or unreadable one yields defaults
**plus a visible `error`**, so unknown adapter/role configs are surfaced in the
UI rather than silently dropped. Unknown agents referenced by a role, bad
adapters, and duplicate reviewer panes are all rejected at the Zod layer in
`config.ts`.

## Tests

`test/agents.test.js` covers template substitution, missing-variable reporting,
capability resolution, the builder/reviewer/fix preview shape, and config
template overrides. Run with `npm test` (builds the main process, then Node's
built-in test runner — no extra dependencies).
