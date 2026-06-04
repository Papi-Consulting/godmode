const issues = [
  '#12 QuadWork-inspired dashboard shell',
  '#13 Harness detector in main process',
  '#14 GitHub PR read-only pane',
];

const pullRequests = [
  '#22 feat/ui-operator-grid · draft',
  '#21 chore/scaffold-electron · merged',
  '#20 docs/add-review-lenses · merged',
];

const batchRows = [
  { id: '#12', label: 'Dashboard shell', progress: 74, status: 'builder running' },
  { id: '#13', label: 'Harness detector', progress: 35, status: 'needs spec' },
  { id: '#14', label: 'PR state pane', progress: 52, status: 'reviewer A pending' },
];

export function GithubPane() {
  return (
    <section className="panel github-pane">
      <header className="panel-header">
        <div>
          <span className="section-kicker">GitHub</span>
          <strong>Issues · Pull Requests · Batch</strong>
        </div>
        <span className="header-chip">main protected</span>
      </header>
      <div className="github-columns">
        <section>
          <header className="sub-header">
            <span>Issues (3)</span>
          </header>
          <ul className="feed-list">
            {issues.map((issue) => (
              <li key={issue}>
                <span className="status-dot" />
                {issue}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <header className="sub-header">
            <span>Pull Requests (3)</span>
          </header>
          <ul className="feed-list">
            {pullRequests.map((pullRequest) => (
              <li key={pullRequest}>
                <span className="status-dot cyan" />
                {pullRequest}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="batch-panel">
        <header className="sub-header">
          <span>Current Batch: UI Draft (3 items)</span>
          <strong>Manual merge gate</strong>
        </header>
        <div className="batch-list">
          {batchRows.map((row) => (
            <article className="batch-row" key={row.id}>
              <span>{row.id}</span>
              <strong>{row.label}</strong>
              <div className="progress-track" aria-label={`${row.label} ${row.progress}%`}>
                <span style={{ width: `${row.progress}%` }} />
              </div>
              <em>{row.progress}% · {row.status}</em>
            </article>
          ))}
        </div>
      </div>
      <footer className="queue-footer">
        <span>3/3 harness files read</span>
        <button>Edit queue</button>
      </footer>
    </section>
  );
}
