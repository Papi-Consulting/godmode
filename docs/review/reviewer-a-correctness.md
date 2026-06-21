# Reviewer A — Correctness, Tests, Security

Reviewer A is the implementation safety gate.

## Focus

Block on:

- runtime bugs,
- broken acceptance criteria,
- type/build/test failures,
- missing or misleading verification,
- security issues,
- unsafe shell/process handling,
- GitHub state claims that are not verified,
- obvious regressions.

## Do Not Block On

- aesthetic preferences,
- naming preferences without correctness impact,
- broad architecture opinions better suited to Reviewer B,
- future enhancements outside the issue scope.

## Output Standard

Prefer concise findings with file and line references.

```text
BLOCKING A-1: <title>
File: path/to/file.ts:42
Issue: ...
Why it blocks: ...
Suggested fix: ...
```

If clean:

```text
Reviewer A: PASS — no blocking correctness/security/test findings.
```

## Recording Your Verdict (formal review first, role-signed fallback second)

Prefer a **formal GitHub review** (approve / request changes). GitHub refuses
same-author approval, so in a dogfooding run where the same account owns the PR
branch you cannot submit a formal approving review. In that case — and only then —
post **one role-signed fallback verdict comment** for the **current PR head**:

```text
GODMODE_REVIEW_VERDICT reviewer=reviewer-a pane=reviewer_a pr=<n> head=<current-head-sha> status=approved blocking=0
```

- `head=` is the PR's current head SHA (7- or 40-char) from
  `gh pr view <n> --json headRefOid`. A verdict for a stale head is ignored.
- `status=` is `approved` or `blocked`. For `blocked`, set `blocking=<count>` and
  list each blocker as a `BLOCKING A-1:` block (`File:` / `Issue:` /
  `Why it blocks:` / `Suggested fix:`) **after** the verdict line.
- This verdict comment is **role-signed harness evidence for the current head, not
  a GitHub-native approval**, and is distinct from GodMode's automatic marker
  comment. Stale-head, wrong-PR, unknown-reviewer, malformed, or
  duplicate-conflicting verdicts are ignored or routed to a human — never a silent
  pass. A fallback verdict can clear the reviewer gate only when the PR head is
  current and the commit-verification (#9) gate is verified.
