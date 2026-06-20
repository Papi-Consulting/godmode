/**
 * Pure operator command/message dispatch semantics (issue #57). Framework-free so
 * the renderer's send controls stay thin and the delivery rules are unit-testable
 * without a DOM or live Electron: compose the exact text + one submit character,
 * call the injected PTY send, and derive the next input state (clear only on a
 * confirmed write; preserve the text + surface a reason on any failure).
 */
import type { PtyWriteResult } from './types.js';

/**
 * The single submit character appended after the operator's exact text, matching
 * the handoff/fix/reviewer prompt delivery path (`${prompt}\r`) so role messages
 * submit consistently across every dispatch surface.
 */
export const PTY_SUBMIT_CHAR = '\r';

/** Compose the operator's exact text plus one submit character for PTY delivery. */
export function composePtyMessage(text: string): string {
  return `${text}${PTY_SUBMIT_CHAR}`;
}

/** Injected PTY send (preload `sendPty`); returns a typed result, or undefined when the bridge is absent. */
export type RoleMessageSend = (input: { paneId: string; data: string }) => Promise<PtyWriteResult | undefined>;

export type RoleMessageOutcome = {
  /** Whether the message was confirmed written to the live PTY. */
  delivered: boolean;
  /** Next value for the input: cleared ('') on success, preserved on failure/no-op. */
  nextValue: string;
  /** Inline error to show, or null when none (success, or an ignored empty submit). */
  error: string | null;
};

/**
 * Deliver an operator role message to a live PTY and derive the next input state.
 * Whitespace-only text is a no-op (no write, no error). The field is cleared only
 * on a confirmed successful write; on no-live-session / unknown-pane / failed
 * write / missing bridge the text is preserved and a reason is surfaced so the
 * operator can retry (issue #57).
 */
export async function deliverRoleMessage(
  paneId: string,
  text: string,
  send: RoleMessageSend,
): Promise<RoleMessageOutcome> {
  if (text.trim().length === 0) {
    return { delivered: false, nextValue: text, error: null };
  }
  let result: PtyWriteResult | undefined;
  try {
    result = await send({ paneId, data: composePtyMessage(text) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { delivered: false, nextValue: text, error: `Message delivery failed: ${reason}` };
  }
  if (result?.ok) {
    return { delivered: true, nextValue: '', error: null };
  }
  const error = result && !result.ok ? result.error : 'Message delivery is unavailable (no live session).';
  return { delivered: false, nextValue: text, error };
}
