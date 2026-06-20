# Operator Command Dispatch

GodMode's operator-facing message/command controls must be **honest**: a control
either delivers to a specific live agent PTY with visible evidence, or it is
visibly disabled/erroring — never a silent no-op (issue #57). This note documents
the small dispatch surface added for role messages and the honesty rule for the
not-yet-implemented global command.

## Boundaries

| Concern | Owner |
| --- | --- |
| Compose exact text + one submit char; decide next input state | `composePtyMessage` / `deliverRoleMessage` in `src/shared/commandDispatch.ts` (pure) |
| Render the per-pane `Message <role>` control; show inline failure | `AgentPane` in `src/renderer/components/AgentPane.tsx` |
| Typed renderer→main delivery bridge (`sendPty`) | `src/preload/index.ts` over `GODMODE_IPC.ptySend` |
| Validate payload, write to the role PTY, return a typed result | `handleSendPty` in `src/main/index.ts` → `writeToPtySessionResult` in `src/main/pty.ts` |
| Centralized IPC channel name | `ptySend: 'godmode:pty:send'` in `src/shared/ipcChannels.ts` |

## Delivery contract

- A role message is delivered to the pane's **generic role id** (`head`,
  `builder`, `reviewer_a`, `reviewer_b`) — never a vendor name.
- The submit character is a single `\r`, matching the handoff/fix/reviewer prompt
  delivery path (`${prompt}\r`), composed once in `composePtyMessage`.
- `writeToPtySessionResult` returns a typed `PtyWriteResult` (`src/shared/types.ts`):
  - `{ ok: true, bytes }` on a confirmed write,
  - `{ ok: false, code: 'no_live_session' | 'unknown_pane' | 'write_failed' | 'invalid_payload', error }` otherwise.
- The renderer clears the input **only** on `ok: true`. On any failure the text is
  preserved and the typed `error` is shown inline so the operator can retry — for
  example after a one-shot reviewer process has already exited.
- Raw xterm typing is unchanged: `term.onData` still uses the fire-and-forget
  `writePty` (`GODMODE_IPC.ptyWrite`). `sendPty` is a separate `invoke` so only the
  send control learns delivery status. `writeToPtySession` (fire-and-forget) is
  retained for internal prompt delivery and now delegates to
  `writeToPtySessionResult` so there is a single write code path.

## Global command honesty

The product spec's global command bar (`docs/godmode-v1-product-spec.md` §6.5) has
no designed routing rule mapping free text to a target role's live PTY, and the
harness team-chat transcript is out of scope. Until that routing is designed, both
the footer **Global command** input and the **Harness Chat** message input are
rendered **disabled** with an explanatory placeholder/title, rather than accepting
text they cannot dispatch. Operators drive live agents through each role pane's
`Message <role>` control, which delivers with a typed result today.
