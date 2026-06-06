import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HarnessRequirement,
  HarnessStatus,
  ProjectHarnessState,
  ProjectState,
} from '../shared/types.js';
import { getAppRepoRoot } from './appRepo.js';

// The **operated project** root every project/PTY/GitHub operation is scoped
// to. Defaults to the process working directory so the app is usable
// immediately, but selecting a project re-points it. This is the operated
// project, not the GodMode app repo — PTY launches must read this rather than
// process.cwd(), and it is never silently assumed to be GodMode's own repo.
let selectedProjectRoot: string = process.cwd();

export function getSelectedProjectRoot(): string {
  return selectedProjectRoot;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

type ResolveResult = { root: string } | { error: string };

/** Resolve user input to an absolute, readable directory or an error message. */
export function resolveProjectRoot(input: string): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter a project path.' };

  const resolved = path.resolve(expandHome(trimmed));

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { error: `Path does not exist: ${resolved}` };
  }
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return { error: `Directory is not readable: ${resolved}` };
  }
  return { root: resolved };
}

function isFile(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function isDir(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function unreadable(error: string): ProjectHarnessState {
  return { status: 'unreadable', error, requirements: [], missingRequired: [] };
}

/**
 * Inspect a project root for GodMode harness files. The required set mirrors the
 * minimum harness contract in docs/godmode-v1-product-spec.md: AGENTS.md plus a
 * README.md or docs/spec.md. Optional documentation folders improve agent
 * fidelity but never gate validity.
 */
export function detectHarness(root: string): ProjectHarnessState {
  try {
    if (!fs.statSync(root).isDirectory()) {
      return unreadable(`Not a directory: ${root}`);
    }
    fs.accessSync(root, fs.constants.R_OK);
  } catch {
    return unreadable(`Project root is not readable: ${root}`);
  }

  const requirements: HarnessRequirement[] = [
    {
      id: 'agents',
      label: 'AGENTS.md',
      kind: 'required',
      present: isFile(root, 'AGENTS.md'),
      candidates: ['AGENTS.md'],
    },
    {
      id: 'spec',
      label: 'README.md or docs/spec.md',
      kind: 'required',
      present: isFile(root, 'README.md') || isFile(root, 'docs/spec.md'),
      candidates: ['README.md', 'docs/spec.md'],
    },
    {
      id: 'config',
      label: '.agentic/godmode.yaml',
      kind: 'optional',
      present: isFile(root, '.agentic/godmode.yaml'),
      candidates: ['.agentic/godmode.yaml'],
    },
    {
      id: 'review',
      label: 'docs/review/',
      kind: 'optional',
      present: isDir(root, 'docs/review'),
      candidates: ['docs/review/'],
    },
    {
      id: 'architecture',
      label: 'docs/architecture/',
      kind: 'optional',
      present: isDir(root, 'docs/architecture'),
      candidates: ['docs/architecture/'],
    },
    {
      id: 'conventions',
      label: 'docs/conventions/',
      kind: 'optional',
      present: isDir(root, 'docs/conventions'),
      candidates: ['docs/conventions/'],
    },
    {
      id: 'friction',
      label: 'docs/friction/',
      kind: 'optional',
      present: isDir(root, 'docs/friction'),
      candidates: ['docs/friction/'],
    },
  ];

  const required = requirements.filter((r) => r.kind === 'required');
  const satisfied = required.filter((r) => r.present);
  const missingRequired = required.filter((r) => !r.present).map((r) => r.label);

  let status: HarnessStatus;
  if (satisfied.length === required.length) status = 'valid';
  else if (satisfied.length === 0) status = 'missing';
  else status = 'partial';

  return { status, requirements, missingRequired };
}

/**
 * Whether the operated-project root resolves to the GodMode app repo itself
 * (self-dogfooding). Compares canonicalized paths so a symlinked or
 * differently-cased path to the same directory is still recognized. The
 * conceptual boundary is preserved regardless: this only flags that the two
 * contexts currently point at the same directory.
 */
function isSameAsAppRepo(root: string): boolean {
  const appRoot = getAppRepoRoot();
  const canonical = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return canonical(root) === canonical(appRoot);
}

function buildProjectState(root: string): ProjectState {
  return {
    root,
    name: path.basename(root),
    harness: detectHarness(root),
    isAppRepo: isSameAsAppRepo(root),
  };
}

/** Current project state for the selected root. */
export function getProjectState(): ProjectState {
  return buildProjectState(selectedProjectRoot);
}

/**
 * Validate and select a project root. On success the selected root is updated
 * and PTY operations follow it. On failure the selected root is left unchanged
 * and an `unreadable` state describing the attempted path is returned, so the UI
 * can show what failed without losing the previously working project.
 */
export function selectProject(input: string): ProjectState {
  const trimmed = input.trim();
  const attempted = trimmed ? path.resolve(expandHome(trimmed)) : '';
  const resolved = resolveProjectRoot(input);

  if ('error' in resolved) {
    return {
      root: attempted || null,
      name: attempted ? path.basename(attempted) : null,
      harness: unreadable(resolved.error),
      // An unresolvable path is not treated as the app repo; the previously
      // selected (working) project root is left unchanged.
      isAppRepo: false,
    };
  }

  selectedProjectRoot = resolved.root;
  return buildProjectState(resolved.root);
}
