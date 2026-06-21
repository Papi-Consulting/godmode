import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PaneSessionState } from '../../shared/types.js';
import { deliverRoleMessage } from '../../shared/commandDispatch.js';

type AgentPaneProps = {
  id: string;
  role: string;
  agent: string;
  commandHint: string;
  phase: string;
  accent: string;
  roleDoc?: string;
  /** Run worktree path the session launches in, when the run is isolated (#41). */
  worktreePath?: string;
  /**
   * Live PTY session-state lifecycle truth for this pane (issue #63), pushed from
   * main. Drives the header status, the Start/Restart/Stop control availability,
   * and whether the message input can deliver — instead of local optimistic state.
   */
  session?: PaneSessionState | null;
};

/** Operator-facing status text for a pane, derived from main's session truth (#63). */
function describeSession(session: PaneSessionState | null | undefined, launching: boolean, fallback: string): string {
  if (launching && !session?.live) return 'launching…';
  if (!session) return fallback;
  switch (session.lifecycle) {
    case 'running':
      return session.awaitingInput ? 'waiting · needs operator' : 'running';
    case 'exited':
      return `exited (${session.exitCode ?? '?'})`;
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'launch failed';
    case 'never_started':
    default:
      return fallback;
  }
}

export function AgentPane({ id, role, agent, commandHint, phase, accent, roleDoc, worktreePath, session }: AgentPaneProps) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runningRef = useRef(false);
  // Optimistic "we clicked Start and are awaiting main's confirmation" flag. Main's
  // pushed session state is authoritative and clears this as soon as it arrives.
  const [launching, setLaunching] = useState(false);
  const [focused, setFocused] = useState(false);
  // Operator role-message control (issue #57): exact text + one submit char is
  // delivered to this pane's live PTY; the field clears only on a confirmed write
  // and shows an inline reason (e.g. no live session) otherwise.
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const live = session?.live ?? false;
  const lifecycle = session?.lifecycle ?? 'never_started';
  const awaitingInput = (session?.awaitingInput ?? false) && live;
  const statusText = describeSession(session, launching, phase);

  // Keep the unmount-cleanup ref in sync with the authoritative live state, so a
  // component unmount (e.g. project switch re-render) stops a session main owns.
  useEffect(() => {
    runningRef.current = live;
  }, [live]);

  // Clear the optimistic launching flag once main reports a terminal/live outcome.
  useEffect(() => {
    if (live || lifecycle === 'failed' || lifecycle === 'exited' || lifecycle === 'stopped') {
      setLaunching(false);
    }
  }, [live, lifecycle, session?.changedAt]);

  useEffect(() => {
    if (!terminalHostRef.current || terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.2,
      theme: {
        background: '#050712',
        foreground: '#d7dde7',
        cursor: '#6aa7ff',
        selectionBackground: '#172554',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalHostRef.current);
    fit.fit();
    term.writeln(`GodMode ${role} · ${agent}`);
    term.writeln(`$ ${commandHint}`);
    term.writeln('adapter=cli · session state shown in header');
    if (roleDoc) term.writeln(`role-doc=${roleDoc}`);
    if (worktreePath) term.writeln(`worktree=${worktreePath}`);
    term.writeln('');

    terminalRef.current = term;
    fitRef.current = fit;

    const removeDataListener = window.godmode?.onPtyData((event) => {
      if (event.paneId === id) term.write(event.data);
    });
    // The exit line is operator-visible context in the scrollback; the header's
    // lifecycle (from main) is the authoritative state. Keep both in agreement.
    const removeExitListener = window.godmode?.onPtyExit((event) => {
      if (event.paneId === id) {
        runningRef.current = false;
        term.writeln(`\r\n[process exited: ${event.exit.exitCode}]`);
      }
    });

    const host = terminalHostRef.current;
    const onFocusIn = () => setFocused(true);
    const onFocusOut = () => setFocused(false);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      window.godmode?.resizePty({ paneId: id, cols: term.cols, rows: term.rows });
    });
    resizeObserver.observe(terminalHostRef.current);

    term.onData((data) => window.godmode?.writePty({ paneId: id, data }));

    return () => {
      if (runningRef.current) {
        window.godmode?.stopPty({ paneId: id });
        runningRef.current = false;
      }
      removeDataListener?.();
      removeExitListener?.();
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, [agent, commandHint, id, role, roleDoc, worktreePath]);

  async function start() {
    setLaunching(true);
    // Starting replaces any live session for this pane in the main process, so
    // this also serves as restart.
    const result = await window.godmode?.startPty({ paneId: id });
    if (result?.ok) {
      runningRef.current = true;
      fitRef.current?.fit();
      return;
    }
    // Main reports the launch failure as `failed` session state too, but surface
    // the reason in the pane scrollback for immediate operator context.
    setLaunching(false);
    runningRef.current = false;
    const errorMessage = result && !result.ok ? result.error : 'Failed to start session.';
    terminalRef.current?.writeln(`\r\n[launch error: ${errorMessage}]`);
  }

  function stop() {
    window.godmode?.stopPty({ paneId: id });
    runningRef.current = false;
  }

  // Deliver the role message to this pane's live PTY. The pure helper composes the
  // exact text + one submit char, calls the typed `sendPty`, and reports whether to
  // clear the field — the renderer never infers delivery from terminal output.
  async function sendMessage() {
    if (sending) return;
    setSending(true);
    try {
      const outcome = await deliverRoleMessage(id, message, (input) =>
        window.godmode ? window.godmode.sendPty(input) : Promise.resolve(undefined),
      );
      setMessage(outcome.nextValue);
      setMessageError(outcome.error);
    } finally {
      setSending(false);
    }
  }

  function onMessageKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendMessage();
    }
  }

  // The send control is disabled when there is no live PTY to deliver to (issue
  // #63): typing into a dead pane could never execute. The typed #57 result still
  // guards the race where the session dies between render and a click.
  const sendDisabled = sending || !live;
  const messagePlaceholder = live
    ? `Message ${role.toLowerCase()}...`
    : 'No live session — start the pane to message it';

  return (
    <section className={`agent-pane accent-${accent} session-${lifecycle}${awaitingInput ? ' session-attention' : ''}`}>
      <header className="agent-header">
        <div className="agent-title">
          <span className={`status-dot session-dot-${live ? 'live' : lifecycle}`} />
          <strong>{role}</strong>
          <span>{agent}</span>
          {roleDoc ? (
            <span className="agent-doc" title={roleDoc}>
              {roleDoc}
            </span>
          ) : null}
          {worktreePath ? (
            <span className="agent-worktree" title={`Run worktree · ${worktreePath}`}>
              ⑂ {worktreePath.split('/').pop()}
            </span>
          ) : null}
          {focused ? (
            <span className="agent-focus" title="Keyboard focus is in this terminal — typing goes here, Enter submits to the agent">
              ⌨ focused
            </span>
          ) : null}
        </div>
        <div className="agent-actions">
          <span className={`agent-session-status${awaitingInput ? ' attention' : ''}`} title={session?.error ?? undefined}>
            {statusText}
          </span>
          <button onClick={start} disabled={live || launching} aria-label={`Start ${role} session`}>
            ▶
          </button>
          <button onClick={start} disabled={launching} aria-label={`Restart ${role} session`}>
            ↻
          </button>
          <button onClick={stop} disabled={!live} aria-label={`Stop ${role} session`}>
            ■
          </button>
        </div>
      </header>
      <div ref={terminalHostRef} className="terminal-host" />
      <div className="agent-message-row">
        <input
          aria-label={`Message ${role}`}
          placeholder={messagePlaceholder}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          disabled={sendDisabled}
          title={live ? undefined : 'No live PTY for this pane. Start (or restart) the session to deliver a message.'}
        />
        <button aria-label={`Send message to ${role}`} onClick={() => void sendMessage()} disabled={sendDisabled}>
          Send
        </button>
      </div>
      {messageError ? (
        <p className="agent-message-error" role="alert">
          {messageError}
        </p>
      ) : null}
    </section>
  );
}
