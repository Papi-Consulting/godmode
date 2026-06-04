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
};

export function AgentPane({ id, role, agent, commandHint, phase, accent }: AgentPaneProps) {
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
        background: '#050608',
        foreground: '#d7dde7',
        cursor: '#27f288',
        selectionBackground: '#263238',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalHostRef.current);
    fit.fit();
    term.writeln(`GodMode ${role} · ${agent}`);
    term.writeln(`$ ${commandHint} --project /Users/creator/projects/godmode`);
    term.writeln(`phase=${phase} adapter=cli`);
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
  }, [agent, commandHint, id, phase, role]);

  async function startShell() {
    setStatus('running');
    const session = await window.godmode?.startPty({ paneId: id });
    runningRef.current = session !== undefined;
    if (!runningRef.current) setStatus('idle');
    fitRef.current?.fit();
  }

  function stopShell() {
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
        </div>
        <div className="agent-actions">
          <span>{phase}</span>
          <button onClick={startShell} disabled={status === 'running'} aria-label={`Start ${role} shell`}>
            {status === 'running' ? 'Run' : '▶'}
          </button>
          <button onClick={stopShell} disabled={status === 'idle'} aria-label={`Stop ${role} shell`}>
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
