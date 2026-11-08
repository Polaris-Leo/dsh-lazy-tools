/**
 * The shipped defer preset, in a module both halves of the plugin can load.
 *
 * These constants are consumed twice: the Host half enforces them when a
 * configuration names neither `defer` nor `noDefer`, and the browser half shows
 * them in the settings form for that same unconfigured state. Both need the
 * same values, so they live here rather than in `./config.ts`.
 *
 * That split is not cosmetic. `./config.ts` imports `RUN_CODE_NAME` from
 * `@deepseek-ai/dsh-tools` to build {@link GUARD_TOOLS}, and that is a
 * Host-only package: the browser's module table cannot resolve it, so a client
 * bundle that reached through `config.ts` would fail to load in the page. This
 * module deliberately imports nothing, which keeps the client's dependency
 * surface exactly the shell-provided externals.
 * @module @studyzy/dsh-lazy-tools/preset
 */

/**
 * The defer entry a fresh install uses: defer everything the guards do not
 * protect.
 */
export const DEFER_ALL_ENTRY = 'Defer(*)'

/**
 * Every model-facing tool the DSH host registers itself.
 *
 * Scanned from `app.asar → dsh/node_modules/@deepseek-ai/*` (all
 * `defineTool({ name })` sites) on 2026-11-06 under DSH 0.2.2-rc.1. Official
 * tools are NEVER deferred: hiding one costs the model a `tool_search` round
 * trip and reads to the user as "the official plugin stopped working", which is
 * exactly the failure this list exists to prevent. Re-scan after a host upgrade
 * (scripts/official-tool-names.mjs in this repo prints the same list).
 */
export const OFFICIAL_TOOL_NAMES = [
  // Filesystem, search & editing
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
  'glob',
  'grep',
  // Shell, terminal & workspace
  'bash',
  'pwsh',
  'working_directory',
  'load_workspace_dependencies',
  // Web, skills & interaction
  'web_search',
  'web_fetch',
  'skill',
  'present',
  'ask_user_question',
  'todo_write',
  // Official delegation surface
  'list_agents',
  'send_message',
  'wait_agent',
  'interrupt_agent',
  'spawn_teammate',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'list_subagent_models',
  // MCP resources
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  // Sessions, jobs & terminal sessions
  'session_search',
  'session_trace',
  'session_event_search',
  'session_event_trace',
  'session_event_read',
  'job_list',
  'job_output',
  'job_kill',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_list',
  'terminal_close',
  'terminal_signal',
  // Goals & scheduling
  'create_goal',
  'get_goal',
  'update_goal',
  'schedule_create',
  'schedule_list',
  'schedule_edit',
  'schedule_view',
  // Host maintenance
  'cordis_inspect_list',
  'cordis_inspect_query',
  'plugin_manager',
  'plugin_market',
  'ralph',
  'create_worktree',
] as const

/**
 * Tools a fresh install keeps directly callable: the whole official host surface
 * plus the community transports the live profile depends on (AGY bridge, Team
 * channel, grill gate, memory, undo, context compression). Everything else —
 * MCP servers' tools, optional third-party helpers — is deferred and loaded on
 * demand through `tool_search`.
 */
export const DEFAULT_ACTIVE_TOOLS = [
  ...OFFICIAL_TOOL_NAMES,
  // Context management: history compression runs every turn in long sessions.
  'compress',
  // Delegation transports (native Sub + AGY bridge + Team channel).
  'subagent*',
  'subagent_antigravity',
  'subagent_claude_code',
  'subagent_codex',
  'subagent_fork',
  'swarm*',
  'delegate_task',
  'delegation_*',
  'agy_*',
  'agy_tool',
  // Grill gate, memory, undo, MCP connector controls, host diagnostics.
  'grill*',
  'memory*',
  'undo_list',
  'undo_restore',
  'undo_snapshot',
  'undo_recent',
  'mcp_connector_session_tools',
  'mcp_connector_status',
  'dsh_diagnose_plugin_load',
  'dsh_check_effect_mode',
  'dsh_hot_reload',
  // Guard trio: deferring them would lock the model out of its own escape hatch.
  'tool_search',
  'defer_execute_tool',
  'run_code',
] as const

/** Resolved pattern pair after the shipped preset is applied. */
export interface DeferPatterns {
  /** Entries to defer. */
  readonly defer: readonly string[]
  /** Entries that must stay active. */
  readonly noDefer: readonly string[]
}

/**
 * Resolve the configured patterns, substituting the shipped preset when the
 * config names neither `defer` nor `noDefer`.
 *
 * A zero-config install must be useful out of the box: defer the long tail and
 * keep {@link DEFAULT_ACTIVE_TOOLS} callable. As long as `noDefer` is not
 * explicitly configured, {@link DEFAULT_ACTIVE_TOOLS} is retained as the baseline
 * active whitelist so that configuring `defer` alone does not wipe out core tools.
 *
 * This is the single source of that policy. The Host calls it on every request
 * to decide what to withhold; the settings form calls it to decide what to
 * display, so the shown value cannot drift from the enforced one.
 * @param config - the configured pair; an absent key stays `undefined`.
 * @returns the patterns to compile.
 */
export function resolveDeferPatterns(config: {
  defer?: readonly string[] | undefined
  noDefer?: readonly string[] | undefined
}): DeferPatterns {
  const unconfigured = config.defer === undefined && config.noDefer === undefined
  const defer = unconfigured ? [DEFER_ALL_ENTRY] : (config.defer ?? [])

  let noDefer: readonly string[]
  if (config.noDefer !== undefined) {
    noDefer = config.noDefer
  } else {
    // Retain DEFAULT_ACTIVE_TOOLS as the baseline whitelist,
    // excluding any tools that were explicitly targeted by defer.
    const explicitDefers = new Set(
      defer
        .map((entry) => {
          const match = /^Defer\((.+)\)$/i.exec(entry.trim())
          return match ? match[1].trim() : entry.trim()
        })
        .filter((pattern) => !pattern.includes('*')),
    )
    noDefer = DEFAULT_ACTIVE_TOOLS.filter((tool) => !explicitDefers.has(tool))
  }

  return { defer, noDefer }
}