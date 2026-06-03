import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type AgentPaneProps = {
  id: string;
  role: string;
  agent: string;
  commandHint: string;
  description: string;
};

export function AgentPane({ id, role, agent, commandHint, description }: AgentPaneProps) {
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
      fontSize: 12,
      theme: {
        background: '#090b12',
        foreground: '#d8dee9',
        cursor: '#e151a3',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalHostRef.current);
    fit.fit();
    term.writeln(`GodMode ${role} pane`);
    term.writeln(`Default agent: ${agent}`);
    term.writeln(`Command hint: ${commandHint}`);
    term.writeln('Press Start shell to attach a local PTY.');

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
  }, [agent, commandHint, id, role]);

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
    <section className="pane agent-pane">
      <header className="pane-header">
        <div>
          <span className="pane-role">{role}</span>
          <strong>{agent}</strong>
        </div>
        <div className="pane-actions">
          <button onClick={startShell} disabled={status === 'running'}>
            {status === 'running' ? 'Running' : 'Start shell'}
          </button>
          <button onClick={stopShell} disabled={status === 'idle'}>
            Stop
          </button>
        </div>
      </header>
      <p className="pane-description">{description}</p>
      <div ref={terminalHostRef} className="terminal-host" />
    </section>
  );
}
