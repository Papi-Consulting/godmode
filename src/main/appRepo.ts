import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppRepoState } from '../shared/types.js';

/**
 * Locate the GodMode **application repository** root — the repo that ships the
 * Electron app, its docs, and config defaults. This is deliberately separate
 * from the operated project (the external repo opened inside GodMode); the two
 * only coincide while self-dogfooding. See
 * docs/architecture/app-vs-operated-project.md.
 *
 * Resolved by walking up from this compiled module until a package.json named
 * "godmode" is found, so it stays correct both in `electron:dev` (running from
 * dist/) and in a packaged build, and never depends on process.cwd() (which is
 * whatever directory the app happened to be launched from).
 */
function locateAppRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Walk up a bounded number of levels looking for GodMode's own package.json.
  for (let i = 0; i < 12; i += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'godmode') return dir;
    } catch {
      // No (or unreadable) package.json here — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: the launch directory is the best remaining guess.
  return process.cwd();
}

const appRepoRoot = locateAppRepoRoot();

let cachedState: AppRepoState | null = null;

/**
 * Absolute path to the GodMode app repo root. Used to detect self-dogfooding
 * (operated project === app repo); it must never be used as the working
 * directory for agent/PTY operations, which always follow the operated project.
 */
export function getAppRepoRoot(): string {
  return appRepoRoot;
}

/** Identity of the GodMode app repo (root/name/version) for display and dogfooding detection. */
export function getAppRepoState(): AppRepoState {
  if (cachedState) return cachedState;

  let name = 'godmode';
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRepoRoot, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    name = pkg.name ?? name;
    version = pkg.version ?? version;
  } catch {
    // Fall back to the safe defaults above if package.json is unreadable.
  }

  cachedState = { root: appRepoRoot, name, version };
  return cachedState;
}
