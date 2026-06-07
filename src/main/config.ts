import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type {
  AgentRole,
  ConfigStatus,
  ProjectConfigState,
  RolePaneConfig,
} from '../shared/types.js';
import { getSelectedProjectRoot } from './project.js';

const CONFIG_REL_PATH = '.agentic/godmode.yaml';

/** Short, human-facing label per generic role. Display-only; not an identifier. */
const ROLE_LABEL: Record<AgentRole, string> = {
  head: 'HEAD',
  builder: 'BUILDER',
  reviewer_a: 'REV A',
  reviewer_b: 'REV B',
};

const roleEntrySchema = z.object({
  agent: z.string().min(1),
  display_name: z.string().min(1),
  role_doc: z.string().min(1).optional(),
});

const headSchema = roleEntrySchema.extend({ pane: z.literal('head') });
const builderSchema = roleEntrySchema.extend({ pane: z.literal('builder') });
const reviewerSchema = roleEntrySchema.extend({
  // A slug: reviewer ids are used as path segments for run artifacts
  // (`.godmode/runs/<run-id>/<id>.log`) and as PR-comment signatures, so they
  // must not contain path separators or `..` that could escape the run dir.
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, 'reviewer id must be a slug ([A-Za-z0-9_-]) with no path separators'),
  pane: z.enum(['reviewer_a', 'reviewer_b']),
});

const agentDefSchema = z.object({
  adapter: z.enum(['cli', 'mcp', 'acp', 'custom']),
  command: z.string().min(1),
  mode: z.enum(['interactive', 'oneshot', 'oneshot_or_interactive']),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});

/**
 * Optional per-project overrides for the built-in command templates. Each value
 * is a prompt string that may interpolate `{{variable}}` placeholders (see
 * agents.ts). Omitted kinds fall back to the safe harness defaults.
 */
const commandsSchema = z
  .object({
    builder_start: z.string().min(1).optional(),
    reviewer_start: z.string().min(1).optional(),
    builder_fix: z.string().min(1).optional(),
  })
  .optional();

const godmodeConfigSchema = z
  .object({
    project: z
      .object({
        name: z.string().min(1).optional(),
        default_branch: z.string().min(1).optional(),
      })
      .optional(),
    harness: z.record(z.string(), z.string()).optional(),
    roles: z.object({
      head: headSchema,
      builder: builderSchema,
      reviewers: z
        .array(reviewerSchema)
        .min(1)
        .max(2)
        .superRefine((reviewers, ctx) => {
          const seen = new Set<string>();
          for (const reviewer of reviewers) {
            if (seen.has(reviewer.pane)) {
              ctx.addIssue({ code: 'custom', message: `Duplicate reviewer pane: ${reviewer.pane}` });
            }
            seen.add(reviewer.pane);
          }
        }),
    }),
    workflow: z.record(z.string(), z.unknown()).optional(),
    commands: commandsSchema,
    agents: z.record(z.string(), agentDefSchema),
  })
  .superRefine((config, ctx) => {
    const known = new Set(Object.keys(config.agents));
    const requireAgent = (agent: string, where: string) => {
      if (!known.has(agent)) {
        ctx.addIssue({ code: 'custom', message: `Unknown agent "${agent}" referenced by ${where}` });
      }
    };
    requireAgent(config.roles.head.agent, 'roles.head');
    requireAgent(config.roles.builder.agent, 'roles.builder');
    config.roles.reviewers.forEach((reviewer, index) =>
      requireAgent(reviewer.agent, `roles.reviewers[${index}]`),
    );
  });

export type GodmodeConfig = z.infer<typeof godmodeConfigSchema>;

/**
 * Safe defaults used when no config file exists or a present file fails
 * validation. This is the single source of truth for both the renderer panes and
 * the agent registry, so the two never drift. Hermes/Claude/Codex appear here
 * only as default display labels and command hints, never as core identifiers
 * (AGENTS.md BYOA rule). Reviewer capabilities are narrowed because reviewers
 * comment on PRs rather than edit files or open them.
 */
export const DEFAULT_CONFIG: GodmodeConfig = {
  roles: {
    head: { pane: 'head', agent: 'hermes', display_name: 'Hermes' },
    builder: { pane: 'builder', agent: 'claude-code', display_name: 'Claude Code' },
    reviewers: [
      {
        pane: 'reviewer_a',
        id: 'reviewer-a',
        agent: 'codex',
        display_name: 'Codex',
        role_doc: 'docs/review/reviewer-a-correctness.md',
      },
      {
        pane: 'reviewer_b',
        id: 'reviewer-b',
        agent: 'codex',
        display_name: 'Codex',
        role_doc: 'docs/review/reviewer-b-architecture.md',
      },
    ],
  },
  agents: {
    hermes: { adapter: 'cli', command: 'hermes', mode: 'interactive' },
    'claude-code': { adapter: 'cli', command: 'claude', mode: 'interactive' },
    codex: {
      // `codex exec <prompt>` is Codex's non-interactive path that runs a prompt
      // to completion and exits; plain `codex <prompt>` opens the interactive CLI
      // and never returns, which would leave a one-shot reviewer stuck `running`
      // and never auto-post. The harness stays vendor-agnostic — this exec
      // invocation lives in config (default + per-project), not in core code.
      adapter: 'cli',
      command: 'codex exec',
      mode: 'oneshot',
      capabilities: { canEditFiles: false, canOpenPr: false },
    },
  },
};

function panesFromConfig(config: GodmodeConfig): RolePaneConfig[] {
  const toPane = (
    role: AgentRole,
    entry: { agent: string; display_name: string; role_doc?: string },
    reviewerId?: string,
  ): RolePaneConfig => ({
    paneId: role,
    roleKey: role,
    roleLabel: ROLE_LABEL[role],
    displayName: entry.display_name,
    agentId: entry.agent,
    commandHint: config.agents[entry.agent].command,
    roleDoc: entry.role_doc,
    reviewerId,
  });

  return [
    toPane('head', config.roles.head),
    toPane('builder', config.roles.builder),
    ...config.roles.reviewers.map((reviewer) => toPane(reviewer.pane, reviewer, reviewer.id)),
  ];
}

const DEFAULT_PANES: RolePaneConfig[] = panesFromConfig(DEFAULT_CONFIG);

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4).map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length > issues.length ? ` (+${error.issues.length - issues.length} more)` : '';
  return `Invalid ${CONFIG_REL_PATH}: ${issues.join('; ')}${more}`;
}

/**
 * Resolved config plus the metadata both the pane view and the agent registry
 * need. `config` is always populated — the parsed file on `loaded`, or
 * {@link DEFAULT_CONFIG} on every non-loaded status — so callers can resolve
 * roles uniformly while still surfacing `error` for visible feedback.
 */
export type LoadedConfig = {
  status: ConfigStatus;
  source: 'config' | 'default';
  projectName?: string;
  error?: string;
  config: GodmodeConfig;
};

/**
 * Read, parse, and validate the selected project's `.agentic/godmode.yaml`.
 * Never throws: a missing file yields defaults, a malformed file yields a
 * visible error with defaults, and an unreadable root is reported as such. This
 * is the shared loader behind {@link getConfigState} and the agent registry.
 */
export function loadConfig(): LoadedConfig {
  const root = getSelectedProjectRoot();

  let projectName: string | undefined;
  try {
    if (!fs.statSync(root).isDirectory()) {
      return { status: 'unreadable', source: 'default', error: `Not a directory: ${root}`, config: DEFAULT_CONFIG };
    }
    projectName = path.basename(root);
  } catch {
    return {
      status: 'unreadable',
      source: 'default',
      error: `Project root is not readable: ${root}`,
      config: DEFAULT_CONFIG,
    };
  }

  const file = path.join(root, CONFIG_REL_PATH);
  let raw: string;
  try {
    if (!fs.statSync(file).isFile()) {
      return { status: 'default', source: 'default', projectName, config: DEFAULT_CONFIG };
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'default', source: 'default', projectName, config: DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: 'invalid',
      source: 'default',
      projectName,
      error: `Failed to parse ${CONFIG_REL_PATH}: ${reason}`,
      config: DEFAULT_CONFIG,
    };
  }

  const result = godmodeConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'invalid',
      source: 'default',
      projectName,
      error: formatZodError(result.error),
      config: DEFAULT_CONFIG,
    };
  }

  return {
    status: 'loaded',
    source: 'config',
    projectName: result.data.project?.name ?? projectName,
    config: result.data,
  };
}

/**
 * Load and sanitize the selected project's role/agent config into the
 * renderer-facing pane view. Never throws: a missing file yields defaults, and a
 * malformed file yields a visible error state with defaults so the renderer stays
 * functional (issue #3 acceptance).
 */
export function getConfigState(): ProjectConfigState {
  const loaded = loadConfig();
  return {
    status: loaded.status,
    source: loaded.source,
    error: loaded.error,
    projectName: loaded.projectName,
    panes: loaded.status === 'loaded' ? panesFromConfig(loaded.config) : DEFAULT_PANES,
  };
}
