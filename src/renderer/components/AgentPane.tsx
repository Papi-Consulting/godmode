import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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
        <input aria-label={`Message ${role}`} placeholder={`Message ${role.toLowerCase()}...`} />
        <button aria-label={`Send message to ${role}`}>Send</button>
      </div>
    </section>
  );
}
