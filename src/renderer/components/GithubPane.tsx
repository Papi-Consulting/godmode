const checklist = [
  'Project harness detected',
  'GitHub issue selected',
  'Builder branch active',
  'PR detected',
  'Reviewer A complete',
  'Reviewer B complete',
  'Merge-ready summary',
];

export function GithubPane() {
  return (
    <section className="pane github-pane">
      <header className="pane-header">
        <div>
          <span className="pane-role">PR / GitHub</span>
          <strong>Run state</strong>
        </div>
        <span className="tiny-badge">static scaffold</span>
      </header>
      <div className="github-card">
        <p className="muted">Current project</p>
        <h2>GodMode</h2>
        <p>Repo-local harness + GitHub issue/PR state will appear here.</p>
      </div>
      <ol className="state-list">
        {checklist.map((item, index) => (
          <li key={item}>
            <span>{index + 1}</span>
            {item}
          </li>
        ))}
      </ol>
    </section>
  );
}
