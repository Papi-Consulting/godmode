import { useEffect, useState } from 'react';
import type { AgentRegistryState, CommandTemplateKind, RenderedCommand } from '../../shared/types.js';

// Role-first labels for each template kind. Generic by design — vendor names only
// ever appear as the resolved display name, never as a template identifier.
const KIND_LABEL: Record<CommandTemplateKind, string> = {
  builder_start: 'Builder · start',
  reviewer_start: 'Reviewer · start',
  builder_fix: 'Builder · fix',
};

function CommandCard({ command }: { command: RenderedCommand }) {
  return (
    <article className="command-card">
      <header className="command-card-head">
        <strong>{KIND_LABEL[command.kind]}</strong>
        <span className="command-agent">{command.displayName}</span>
        <span className="command-tag">{command.adapter}</span>
        <span className="command-tag">{command.delivery}</span>
      </header>
      <code className="command-line">$ {command.commandLine}</code>
      <pre className="command-prompt">{command.prompt}</pre>
      {command.missingVariables.length > 0 ? (
        <div className="command-missing" aria-label="Unbound template variables">
          <span>unbound</span>
          {command.missingVariables.map((name) => (
            <span className="missing-var" key={name}>
              {name}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Auditable, role-scoped preview of the command templates GodMode would render
 * for a run. Everything here is preview-only: nothing is sent or launched by
 * viewing it. Unbound issue/PR variables stay visible as `{{tokens}}` and are
 * listed per card so the operator can see exactly what is still mock.
 */
export function CommandPreviewPane() {
  const [registry, setRegistry] = useState<AgentRegistryState | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      void window.godmode?.getRegistry().then((next) => {
        if (active && next) setRegistry(next);
      });
    load();
    const off = window.godmode?.onProjectChanged(() => load());
    return () => {
      active = false;
      off?.();
    };
  }, []);

  const preview = registry?.preview ?? [];

  return (
    <section className="panel command-preview-panel" aria-label="Agent command templates">
      <header className="panel-header">
        <div>
          <span className="section-kicker">Command Templates</span>
          <strong>Auditable preview</strong>
        </div>
        <span className="header-chip warn">preview · mock until launched</span>
      </header>
      {registry?.error ? (
        <p className="config-error" role="alert">
          {registry.error}
        </p>
      ) : null}
      <div className="command-preview-list">
        {preview.map((command, index) => (
          <CommandCard key={`${command.kind}-${command.role}-${index}`} command={command} />
        ))}
      </div>
    </section>
  );
}
