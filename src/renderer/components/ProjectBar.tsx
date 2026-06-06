import { useEffect, useState } from 'react';
import type { HarnessStatus, ProjectState } from '../../shared/types.js';

const STATUS_LABEL: Record<HarnessStatus, string> = {
  valid: 'valid',
  partial: 'partial',
  missing: 'missing',
  unreadable: 'unreadable',
};

export function ProjectBar() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.godmode?.getProject().then((state) => {
      if (active && state) setProject(state);
    });
    return () => {
      active = false;
    };
  }, []);

  async function openTypedPath() {
    const target = pathInput.trim();
    if (!target || !window.godmode || busy) return;
    setBusy(true);
    const next = await window.godmode.selectProject({ path: target });
    if (next) setProject(next);
    setBusy(false);
  }

  async function browse() {
    if (!window.godmode || busy) return;
    setBusy(true);
    const next = await window.godmode.browseProject();
    if (next) {
      setProject(next);
      setPathInput('');
    }
    setBusy(false);
  }

  const harness = project?.harness;
  const optional = harness?.requirements.filter((r) => r.kind === 'optional') ?? [];

  return (
    <section className="project-bar" aria-label="Operated project selector and harness status">
      <div className="project-id">
        <span className="section-kicker">Operated project</span>
        <strong title={project?.root ?? undefined}>{project?.root ?? 'No project selected'}</strong>
        {project?.isAppRepo ? (
          <span
            className="dogfood-badge"
            title="The operated project is the GodMode app repo itself. Agents act on it as the operated project, not as the app."
          >
            dogfooding · same as app repo
          </span>
        ) : null}
      </div>

      <div className="project-open">
        <input
          aria-label="Project path"
          placeholder="Enter a local repo path…"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void openTypedPath();
          }}
        />
        <button onClick={() => void openTypedPath()} disabled={busy || !pathInput.trim()}>
          Open
        </button>
        <button onClick={() => void browse()} disabled={busy}>
          Browse…
        </button>
      </div>

      <div className="harness-status" aria-live="polite">
        {harness ? (
          <>
            <span className={`harness-chip harness-${harness.status}`}>
              <span className="status-dot" />
              harness {STATUS_LABEL[harness.status]}
            </span>
            {harness.error ? <span className="harness-detail error">{harness.error}</span> : null}
            {harness.missingRequired.length > 0 ? (
              <span className="harness-detail error">missing: {harness.missingRequired.join(', ')}</span>
            ) : null}
            {optional.length > 0 ? (
              <span className="harness-optional">
                {optional.map((r) => `${r.present ? '✓' : '·'} ${r.label}`).join('   ')}
              </span>
            ) : null}
          </>
        ) : (
          <span className="harness-detail">Harness status unavailable — run inside the GodMode app.</span>
        )}
      </div>
    </section>
  );
}
