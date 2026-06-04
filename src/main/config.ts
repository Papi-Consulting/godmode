import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type {
  AgentRole,
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

/**
 * Safe defaults used when no config file exists or a present file fails
 * validation. Hermes/Claude/Codex appear here only as default display labels and
 * command hints, never as core identifiers (AGENTS.md BYOA rule).
 */
const DEFAULT_PANES: RolePaneConfig[] = [
  {
    paneId: 'head',
    roleKey: 'head',
    roleLabel: ROLE_LABEL.head,
    displayName: 'Hermes',
    agentId: 'hermes',
    commandHint: 'hermes',
  },
  {
    paneId: 'builder',
    roleKey: 'builder',
    roleLabel: ROLE_LABEL.builder,
    displayName: 'Claude Code',
    agentId: 'claude-code',
    commandHint: 'claude',
  },
  {
    paneId: 'reviewer_a',
    roleKey: 'reviewer_a',
    roleLabel: ROLE_LABEL.reviewer_a,
    displayName: 'Codex',
    agentId: 'codex',
    commandHint: 'codex',
    reviewerId: 'reviewer-a',
    roleDoc: 'docs/review/reviewer-a-correctness.md',
  },
  {
    paneId: 'reviewer_b',
    roleKey: 'reviewer_b',
    roleLabel: ROLE_LABEL.reviewer_b,
    displayName: 'Codex',
    agentId: 'codex',
    commandHint: 'codex',
    reviewerId: 'reviewer-b',
    roleDoc: 'docs/review/reviewer-b-architecture.md',
  },
];

const roleEntrySchema = z.object({
  agent: z.string().min(1),
  display_name: z.string().min(1),
  role_doc: z.string().min(1).optional(),
});

const headSchema = roleEntrySchema.extend({ pane: z.literal('head') });
const builderSchema = roleEntrySchema.extend({ pane: z.literal('builder') });
const reviewerSchema = roleEntrySchema.extend({
  id: z.string().min(1),
  pane: z.enum(['reviewer_a', 'reviewer_b']),
});

const agentDefSchema = z.object({
  adapter: z.enum(['cli', 'mcp', 'acp', 'custom']),
  command: z.string().min(1),
  mode: z.enum(['interactive', 'oneshot', 'oneshot_or_interactive']),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});

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

type GodmodeConfig = z.infer<typeof godmodeConfigSchema>;

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

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4).map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length > issues.length ? ` (+${error.issues.length - issues.length} more)` : '';
  return `Invalid ${CONFIG_REL_PATH}: ${issues.join('; ')}${more}`;
}

function defaultState(projectName?: string): ProjectConfigState {
  return { status: 'default', source: 'default', projectName, panes: DEFAULT_PANES };
}

function invalidState(error: string, projectName?: string): ProjectConfigState {
  return { status: 'invalid', source: 'default', error, projectName, panes: DEFAULT_PANES };
}

/**
 * Load and sanitize the selected project's role/agent config. Never throws: a
 * missing file yields defaults, and a malformed file yields a visible error
 * state with defaults so the renderer stays functional (issue #3 acceptance).
 */
export function getConfigState(): ProjectConfigState {
  const root = getSelectedProjectRoot();

  let projectName: string | undefined;
  try {
    if (!fs.statSync(root).isDirectory()) {
      return { status: 'unreadable', source: 'default', error: `Not a directory: ${root}`, panes: DEFAULT_PANES };
    }
    projectName = path.basename(root);
  } catch {
    return {
      status: 'unreadable',
      source: 'default',
      error: `Project root is not readable: ${root}`,
      panes: DEFAULT_PANES,
    };
  }

  const file = path.join(root, CONFIG_REL_PATH);
  let raw: string;
  try {
    if (!fs.statSync(file).isFile()) return defaultState(projectName);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultState(projectName);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return invalidState(`Failed to parse ${CONFIG_REL_PATH}: ${reason}`, projectName);
  }

  const result = godmodeConfigSchema.safeParse(parsed);
  if (!result.success) {
    return invalidState(formatZodError(result.error), projectName);
  }

  return {
    status: 'loaded',
    source: 'config',
    projectName: result.data.project?.name ?? projectName,
    panes: panesFromConfig(result.data),
  };
}
