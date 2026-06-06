import type {
  AgentAdapter,
  AgentCapabilities,
  AgentMode,
  AgentRegistryState,
  AgentRegistryStatus,
  AgentRole,
  CommandTemplateKind,
  RenderedCommand,
  RoleResolution,
  TemplateContext,
} from '../shared/types.js';
import { DEFAULT_CONFIG, loadConfig, type GodmodeConfig } from './config.js';

/**
 * Capability baseline per adapter, applied before per-agent overrides. Only the
 * `cli` adapter is launch-wired in v1; the others describe intent so the
 * registry can reason about lifecycle without core code branching on a vendor.
 */
const ADAPTER_CAPABILITY_DEFAULTS: Record<AgentAdapter, AgentCapabilities> = {
  cli: {
    interactive: true,
    supportsPty: true,
    canEditFiles: true,
    canReview: true,
    canOpenPr: true,
    canCommentOnPr: true,
  },
  mcp: {
    interactive: false,
    supportsPty: false,
    canEditFiles: true,
    canReview: true,
    canOpenPr: false,
    canCommentOnPr: false,
  },
  acp: {
    interactive: true,
    supportsPty: false,
    canEditFiles: true,
    canReview: true,
    canOpenPr: false,
    canCommentOnPr: false,
  },
  custom: {
    interactive: false,
    supportsPty: false,
    canEditFiles: false,
    canReview: false,
    canOpenPr: false,
    canCommentOnPr: false,
  },
};

const CAPABILITY_KEYS: (keyof AgentCapabilities)[] = [
  'interactive',
  'supportsPty',
  'canEditFiles',
  'canReview',
  'canOpenPr',
  'canCommentOnPr',
];

/**
 * Built-in command templates matching the GodMode harness workflow. Each is a
 * prompt string with `{{variable}}` placeholders resolved from
 * {@link TemplateContext}. Per-project `commands` config overrides any kind; an
 * omitted kind falls back to these safe defaults. Templates stay role-generic and
 * lead with the harness reading rules every fresh session must follow.
 */
export const DEFAULT_TEMPLATES: Record<CommandTemplateKind, string> = {
  builder_start:
    'Start a fresh builder session for {{projectName}}. Read AGENTS.md, docs/spec.md, ' +
    'and issue #{{issueNumber}} ({{issueTitle}}) plus relevant docs before implementing. ' +
    'Implement issue #{{issueNumber}}, test, commit, push, and open a PR.',
  reviewer_start:
    'Start a fresh review session as {{reviewerId}}. Read AGENTS.md, PR #{{prNumber}} ' +
    '({{prUrl}}) on branch {{branch}}, its linked issue, comments, and {{roleDoc}} before ' +
    'reviewing. Post findings as PR comments.',
  builder_fix:
    'Start a fresh fix session. Read PR #{{prNumber}} ({{prUrl}}) and the accepted blockers ' +
    'before changing code. Address the blockers, push, and comment on the PR.\n' +
    'Accepted blockers:\n{{blockers}}',
};

/** Resolve an agent's effective capabilities: adapter baseline + config overrides. */
export function resolveCapabilities(
  adapter: AgentAdapter,
  overrides?: Record<string, boolean>,
): AgentCapabilities {
  const resolved = { ...ADAPTER_CAPABILITY_DEFAULTS[adapter] };
  if (overrides) {
    for (const key of CAPABILITY_KEYS) {
      if (typeof overrides[key] === 'boolean') resolved[key] = overrides[key];
    }
  }
  return resolved;
}

const TEMPLATE_TOKEN = /\{\{(\w+)\}\}/g;

/**
 * Substitute `{{variable}}` tokens from `vars`. Unbound tokens are left intact
 * (so the preview reads as an explicit placeholder, not a silent blank) and
 * their names are returned, de-duplicated and in first-seen order, so the UI can
 * mark a render as not-yet-launchable.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): { prompt: string; missingVariables: string[] } {
  const missing: string[] = [];
  const prompt = template.replace(TEMPLATE_TOKEN, (match, name: string) => {
    const value = vars[name];
    if (value !== undefined && value !== '') return value;
    if (!missing.includes(name)) missing.push(name);
    return match;
  });
  return { prompt, missingVariables: missing };
}

/** Stringify the bound subset of a template context for substitution. */
function contextVars(context: TemplateContext): Record<string, string> {
  const vars: Record<string, string> = {};
  if (context.projectName) vars.projectName = context.projectName;
  if (context.issueNumber !== undefined) vars.issueNumber = String(context.issueNumber);
  if (context.issueTitle) vars.issueTitle = context.issueTitle;
  if (context.prNumber !== undefined) vars.prNumber = String(context.prNumber);
  if (context.prUrl) vars.prUrl = context.prUrl;
  if (context.branch) vars.branch = context.branch;
  if (context.reviewerId) vars.reviewerId = context.reviewerId;
  if (context.roleDoc) vars.roleDoc = context.roleDoc;
  if (context.blockers) vars.blockers = context.blockers;
  return vars;
}

function deliveryFromMode(mode: AgentMode): RenderedCommand['delivery'] {
  return mode === 'oneshot' ? 'oneshot' : 'interactive';
}

/**
 * Render one auditable command. Producing it never launches anything — the
 * `commandLine` is the preview of how GodMode would start the bound agent, with
 * the prompt delivered per the agent's mode (streamed into the PTY for
 * interactive agents, passed as input for one-shot agents).
 */
function renderCommand(
  kind: CommandTemplateKind,
  role: AgentRole,
  agentId: string,
  config: GodmodeConfig,
  templates: Record<CommandTemplateKind, string>,
  context: TemplateContext,
): RenderedCommand {
  const agent = config.agents[agentId];
  const roleEntry =
    role === 'builder'
      ? config.roles.builder
      : role === 'head'
        ? config.roles.head
        : config.roles.reviewers.find((reviewer) => reviewer.pane === role);
  const displayName = roleEntry?.display_name ?? agentId;
  const project = context.projectName ?? '<selected-project>';
  const { prompt, missingVariables } = renderTemplate(templates[kind], contextVars(context));

  return {
    kind,
    role,
    agentId,
    displayName,
    adapter: agent.adapter,
    mode: agent.mode,
    command: agent.command,
    commandLine: `${agent.command} --project ${project}`,
    delivery: deliveryFromMode(agent.mode),
    prompt,
    missingVariables,
  };
}

/** Resolve every configured role into an adapter/capability object. */
export function buildRoleResolutions(config: GodmodeConfig): RoleResolution[] {
  const toResolution = (
    role: AgentRole,
    agentId: string,
    reviewerId?: string,
    roleDoc?: string,
  ): RoleResolution => {
    const agent = config.agents[agentId];
    return {
      role,
      agentId,
      displayName:
        role === 'head'
          ? config.roles.head.display_name
          : role === 'builder'
            ? config.roles.builder.display_name
            : config.roles.reviewers.find((reviewer) => reviewer.pane === role)?.display_name ?? agentId,
      adapter: agent.adapter,
      mode: agent.mode,
      capabilities: resolveCapabilities(agent.adapter, agent.capabilities),
      reviewerId,
      roleDoc,
    };
  };

  return [
    toResolution('head', config.roles.head.agent),
    toResolution('builder', config.roles.builder.agent),
    ...config.roles.reviewers.map((reviewer) =>
      toResolution(reviewer.pane, reviewer.agent, reviewer.id, reviewer.role_doc),
    ),
  ];
}

/**
 * Build the auditable command previews for a config: one builder start, one
 * start per configured reviewer, and one builder fix. Reviewer renders carry
 * their reviewer slug and role doc so the prompt reads role-scoped.
 */
export function buildPreview(
  config: GodmodeConfig,
  context: TemplateContext = {},
): RenderedCommand[] {
  const templates = { ...DEFAULT_TEMPLATES, ...config.commands };
  const builderAgent = config.roles.builder.agent;

  const reviewerCommands = config.roles.reviewers.map((reviewer) =>
    renderCommand('reviewer_start', reviewer.pane, reviewer.agent, config, templates, {
      ...context,
      reviewerId: reviewer.id,
      roleDoc: reviewer.role_doc ?? context.roleDoc,
    }),
  );

  return [
    renderCommand('builder_start', 'builder', builderAgent, config, templates, context),
    ...reviewerCommands,
    renderCommand('builder_fix', 'builder', builderAgent, config, templates, context),
  ];
}

/**
 * Resolve the agent registry for the selected project and render its auditable
 * command previews. Never throws: like {@link getConfigState}, a missing config
 * yields safe defaults, and an invalid/unreadable one yields defaults plus a
 * visible error so unknown adapter/role configs are surfaced rather than
 * silently dropped. `context` supplies issue/PR variables; unbound ones remain
 * visible placeholders in the preview (marked mock until a real run launches).
 */
export function getRegistryState(context: TemplateContext = {}): AgentRegistryState {
  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  const status: AgentRegistryStatus = loaded.status === 'loaded' ? 'ready' : loaded.status;
  const previewContext: TemplateContext = { projectName: loaded.projectName, ...context };

  return {
    status,
    source: loaded.source,
    error: loaded.error,
    roles: buildRoleResolutions(config),
    preview: buildPreview(config, previewContext),
  };
}
