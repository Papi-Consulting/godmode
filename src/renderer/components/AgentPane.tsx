import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
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
};

export function AgentPane({ id, role, agent, commandHint, phase, accent, roleDoc, worktreePath }: AgentPaneProps) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runningRef = useRef(false);
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  // Operator role-message control (issue #57): exact text + one submit char is
  // delivered to this pane's live PTY; the field clears only on a confirmed write
  // and shows an inline reason (e.g. no live session) otherwise.
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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
    term.writeln(`phase=${phase} adapter=cli`);
    if (roleDoc) term.writeln(`role-doc=${roleDoc}`);
    if (worktreePath) term.writeln(`worktree=${worktreePath}`);
    term.writeln('');

    terminalRef.current = term;
    fitRef.current = fit;

    const removeDataListener = window.godmode?.onPtyData((event) => {
      if (event.paneId === id) term.write(event.data);
    });
    const removeExitListener = window.godmode?.onPtyExit((event) => {
      if (event.paneId === id) {
        runningRef.current = false;
        setStatus('idle');
        term.writeln(`\r\n[process exited: ${event.exit.exitCode}]`);
      }
    });
    // Main may start a session on this pane's behalf (e.g. the builder recovery
    // relaunch, issue #55). Reflect it as running — the pane did not click Start, so
    // without this its controls would stay idle while a live process exists, and
    // unmount cleanup would not stop it.
    const removeStartedListener = window.godmode?.onPtyStarted((event) => {
      if (event.paneId === id) {
        runningRef.current = true;
        setStatus('running');
      }
    });

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
      removeStartedListener?.();
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, [agent, commandHint, id, phase, role, roleDoc, worktreePath]);

  async function start() {
    setStatus('running');
    // Starting replaces any live session for this pane in the main process, so
    // this also serves as restart.
    const result = await window.godmode?.startPty({ paneId: id });
    if (result?.ok) {
      runningRef.current = true;
      fitRef.current?.fit();
      return;
    }
    runningRef.current = false;
    setStatus('idle');
    const message = result && !result.ok ? result.error : 'Failed to start session.';
    terminalRef.current?.writeln(`\r\n[launch error: ${message}]`);
  }

  function stop() {
    window.godmode?.stopPty({ paneId: id });
    runningRef.current = false;
    setStatus('idle');
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

  return (
    <section className={`agent-pane accent-${accent}`}>
      <header className="agent-header">
        <div className="agent-title">
          <span className="status-dot" />
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
        </div>
        <div className="agent-actions">
          <span>{phase}</span>
          <button onClick={start} disabled={status === 'running'} aria-label={`Start ${role} session`}>
            ▶
          </button>
          <button onClick={start} disabled={status === 'idle'} aria-label={`Restart ${role} session`}>
            ↻
          </button>
          <button onClick={stop} disabled={status === 'idle'} aria-label={`Stop ${role} session`}>
            ■
          </button>
        </div>
      </header>
      <div ref={terminalHostRef} className="terminal-host" />
      <div className="agent-message-row">
        <input
          aria-label={`Message ${role}`}
          placeholder={`Message ${role.toLowerCase()}...`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          disabled={sending}
        />
        <button aria-label={`Send message to ${role}`} onClick={() => void sendMessage()} disabled={sending}>
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
