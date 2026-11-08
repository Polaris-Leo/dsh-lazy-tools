/**
 * dsh-lazy-tools: CodeBuddy-style deferred tool loading for DeepSeek Harness.
 *
 * A pure exposure-control plugin: it keeps deferred tools out of the tool list
 * the MODEL sees, and lets the model re-discover them on demand via
 * `tool_search` (keyword or exact-name lookup) or activate one by name via
 * `defer_execute_tool`. A `tools/pre-execute` listener blocks direct calls to
 * not-yet-loaded deferred tools with a pointer back to the search tools.
 *
 * Hiding happens at DSH 0.2.2's per-scope restriction layer: every agent gets
 * its own `agent.ctx.tools.restrict({ deny })` mask over the inherited tool
 * set. That one view feeds the model-facing declarations, the PTC `tools:sdk`
 * prompt section, and dispatch, so a masked tool is invisible everywhere at
 * once. Restrictions mask INHERITED tools, which is exactly where an agent
 * preset mounts its rows — the preset generation scope is the agent scope's
 * parent — so one call masks preset tools exactly like host or MCP tools. The
 * plugin still never registers, replaces, or shadows a deferred tool; it only
 * masks names it does not own.
 *
 * This plugin does NOT own or implement any deferred tool. Deferred tools are
 * ordinary registry tools; the plugin only observes their schemas in the
 * assembly for discovery. Works with any model/provider — it is purely
 * agent-layer.
 *
 * A **zero-config install is useful out of the box**: the shipped preset defers
 * the long tail and keeps a coding core callable — `read`, `write`, `edit`,
 * `bash`, `glob`, `grep`, `web_search`, `web_fetch`, `ask_user_question`,
 * `skill`, plus the search/execute guards. Configuration is only needed to
 * change that default (CodeBuddy semantics, precedence `noDefer` > `defer`):
 *
 * ```yaml
 * - id: lazy-tools
 *   name: '@studyzy/dsh-lazy-tools'
 *   config:
 *     defer: ['Defer(fetch_*)', 'web_search']
 *     noDefer: ['bash']
 * ```
 *
 * Naming either `defer` or `noDefer` replaces the preset entirely, so
 * `defer: []` keeps its meaning of "defer nothing" — which is also how the
 * mechanism is switched off wholesale.
 *
 * **Auto-tuning** (on by default) additionally derives a **per-project**
 * configuration from that project's own session history: the first session that
 * reports a working directory triggers one scan of the last 30 days of that
 * project's `tool/call` events, and the top 20 tools by use become the active
 * set while everything else is deferred. `defer_execute_tool` arguments count as
 * usage of the tool they activate, so a repeatedly-activated tool promotes
 * itself out of the deferred set. A project with fewer than 200 in-window calls
 * is left untouched rather than tuned on noise, and a ranking that already
 * matches the stored override is not rewritten. Set `autoTune: false` to opt
 * out.
 *
 * Configuration resolves in two layers: **project override > global config**.
 * The `defer`/`noDefer` you write here is the global rule, honored by every
 * project; a project that auto-tuning has measured gets its own override in
 * `~/.dsh/lazy-tools/projects.json`, which replaces the pattern pair for that
 * project only. Hand-written global rules are therefore never clobbered by a
 * scan of some other repository.
 * @module @studyzy/dsh-lazy-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { applyDefaultPreset, isGuardTool, resolveDeferConfig, type LazyToolsConfig } from './config.ts'
import { buildTools, type LoadStatus, type ToolsAccess } from './tools.ts'
import { autoTune, describeOutcome, resolveAutoTuneOptions } from './autotune.ts'
import { applyProjectOverride, readProjectOverride, readStoreSync } from './project-config.ts'
import { DEFAULT_MIN_SAMPLES, DEFAULT_TOP_N, DEFAULT_WINDOW_DAYS } from './history.ts'
// Ambient declarations for the optional settings service and the Loader's
// volatile-update event; imported for their types only, never for values.
import './settings.ts'

/** Cordis plugin name. */
export const name = 'lazy-tools'
/** Services required to install a lazy surface on every live agent. */
export const inject = ['agents', 'tools']

/** Model-facing discovery and activation tool names. */
export const TOOL_SEARCH_NAME = 'tool_search'
export const DEFER_EXECUTE_TOOL_NAME = 'defer_execute_tool'

/** Plugin config surface (validated by schemastery). */
export interface Config {
  /** Tool names / `Defer(pattern)` entries to defer. Bare names = `Defer(name)`. */
  defer?: string[]
  /** Tool names / `NoDefer(pattern)` entries that must stay active. */
  noDefer?: string[]
  /** Tune `defer`/`noDefer` from this project's session history. Default true. */
  autoTune?: boolean
  /** Days of history the auto-tune ranking covers. Default 30. */
  autoTuneWindowDays?: number
  /** How many top-ranked tools auto-tune keeps active. Default 20. */
  autoTuneTopN?: number
  /** In-window calls a project needs before auto-tune rewrites anything. Default 200. */
  autoTuneMinSamples?: number
}

/**
 * Schemastery validation and defaults for {@link Config}.
 *
 * Every field is `.volatile()`, which is what lets the Web/Desktop settings
 * page edit it: the settings plane projects only volatile fields into its
 * forms, and a volatile write swaps the live Config in place instead of
 * remounting the plugin. Volatility is a projection policy, so it does not by
 * itself make this plugin re-read `config` — see {@link configSnapshot}.
 *
 * The schema is deliberately unannotated: `.volatile()` changes the schema's
 * output type to a reference, so pinning it to `z<Config>` would be a type
 * error and hiding that behind a cast would lose the very distinction
 * {@link LiveConfig} exists to encode.
 */
export const Config = z.object({
  // `default(undefined)` keeps an absent key absent instead of materializing it
  // as the preset, which is what lets apply() tell "unconfigured" from an
  // explicit `defer: []` ("defer nothing"). The cast covers a default the
  // typings do not model; the key is simply absent at runtime.
  //
  // The shipped preset is deliberately NOT spelled as a schema default. A
  // schema default is injected into every configuration the Loader resolves,
  // not just an empty one, so `defer: ['glob']` would silently also gain the
  // preset's `noDefer` core — protecting `glob` instead of deferring it, the
  // exact opposite of what "naming a key replaces the preset" promises. The
  // settings form shows the preset through the client's own resolution instead
  // (see `./client/controller.ts`), which is display-only and cannot alter
  // what the plugin enforces.
  defer: z.array(z.string()).default(undefined as unknown as string[]).volatile(),
  noDefer: z.array(z.string()).default(undefined as unknown as string[]).volatile(),
  autoTune: z.boolean().default(true).volatile(),
  autoTuneWindowDays: z.number().default(DEFAULT_WINDOW_DAYS).volatile(),
  autoTuneTopN: z.number().default(DEFAULT_TOP_N).volatile(),
  autoTuneMinSamples: z.number().default(DEFAULT_MIN_SAMPLES).volatile(),
})

/**
 * {@link Config} as `apply` actually receives it: every field is volatile, so
 * every field arrives as a reference the Loader swaps in place on a live edit.
 */
export type LiveConfig = {
  [K in keyof Required<Config>]: { get(): Exclude<Config[K], undefined> }
}

/** Render one thrown value for a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the plugin's current configuration as plain data.
 *
 * Every {@link Config} field is `.volatile()`, so what `apply` receives is not
 * a value but a reference object the Loader swaps in place when a settings save
 * commits. Reading `config.defer` directly would hand back a reference, and
 * snapshotting it once at install would freeze the process on its startup
 * configuration — a settings-page save would appear to do nothing until the
 * plugin was remounted. Every consumer in this module goes through this
 * function, which re-reads on each call.
 * @param config - the live config handed to `apply`.
 * @returns the current values as a plain, snapshot-independent object.
 */
function configSnapshot(config: LiveConfig): Config {
  return {
    defer: config.defer.get(),
    noDefer: config.noDefer.get(),
    autoTune: config.autoTune.get(),
    autoTuneWindowDays: config.autoTuneWindowDays.get(),
    autoTuneTopN: config.autoTuneTopN.get(),
    autoTuneMinSamples: config.autoTuneMinSamples.get(),
  }
}

/** One agent's owned tools, catalog, and search state. */
interface AgentState {
  readonly agent: Agent
  /** Every schema the unrestricted registry view offers this scope — deferred ones included. */
  catalog: ToolSchema[]
  /** Catalog names still withheld from the model (patterns minus activations). */
  deferredNames: Set<string>
  /** Names this agent activated; they stay offered across assemblies. */
  readonly activated: Set<string>
  removePreExecute: (() => void) | undefined
  removeTools: (() => void)[]
  /** This agent's own mask over inherited tools, while one is in force. */
  removeRestriction: (() => void) | undefined
  /** Deny list the live mask was built from; empty when no mask is in force. */
  restrictionSignature: string
}

/**
 * Install per-agent lazy tool loading for every current and future agent.
 * @param ctx - plugin context carrying the agent and tool registries.
 * @param config - deferred-tool visibility patterns; every field is a live
 *   volatile reference, so read it through {@link configSnapshot}.
 */
export function apply(ctx: Context, config: LiveConfig): void {
  const states = new Map<Agent, AgentState>()
  const home = ctx.get('profileContext')?.home
  /**
   * Depth of registry mutations this plugin is performing itself. Every mask
   * swap fires `tools/change`; re-ranking from inside our own swap would loop.
   */
  let muting = 0

  // This plugin ships its own settings page (the browser half in ./client), so
  // it opts out of the settings plane's schema-derived automatic form. Without
  // this the same fields would also appear as a generated form, and a deployment
  // whose page is absent would still list the entry. Registration is optional:
  // a composition without the settings service runs the plugin unchanged, which
  // is why this rides a child inject rather than a hard dependency.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  /**
   * The operator's global configuration; the base for every project.
   *
   * Read fresh on every access rather than captured once, because a settings-page
   * save swaps the volatile Config in place and must take effect without a
   * restart. Deriving it is pure, so re-deriving per request is cheap.
   */
  function globalConfig(): LazyToolsConfig {
    return applyDefaultPreset(configSnapshot(config))
  }

  /** Resolve the configuration that applies to one agent's project. */
  function configFor(agent: Agent): LazyToolsConfig {
    const cwd = agent.session?.header.cwd
    if (cwd === undefined) return globalConfig()
    return projectConfigs.get(cwd) ?? globalConfig()
  }

  /**
   * Per-project configuration in force for this process, keyed by the session's
   * absolute working directory. An entry is present only for a project that has
   * an override on disk; every other project resolves to the global config.
   *
   * The store is read once at install so the first request of a session already
   * honors an existing override. A project tuned later in this same process is
   * refreshed after its write lands, so the new patterns take effect from the
   * next request rather than needing a restart.
   */
  const projectConfigs = new Map<string, LazyToolsConfig>()

  /**
   * Load every project override before the first session can be created. This
   * runs synchronously at install so an existing override is already in force
   * for a session's very first request — a partial read on the request path
   * would silently fall back to the global configuration instead.
   *
   * A missing or unreadable store is not an error: it just means every project
   * uses the global configuration.
   */
  try {
    const store = readStoreSync(home)
    for (const [cwd, override] of Object.entries(store.projects)) {
      projectConfigs.set(cwd, applyProjectOverride(globalConfig(), override))
    }
  } catch (error: unknown) {
    ctx.logger.warn(`lazy-tools: could not read project overrides (${errorMessage(error)}); using the global configuration`)
  }

  /**
   * Projects already tuned by this process. Auto-tuning runs at most once per
   * project: the first session that reports a working directory supplies the
   * project, and later sessions — including a `cwd` change — are not re-mined.
   * The promise is memoized before it settles so concurrent first sessions
   * cannot both start a scan.
   */
  const tunedProjects = new Map<string, Promise<void>>()

  /**
   * Mine one project's history and persist the resulting per-project override.
   *
   * Auto-tuning is a background optimization on the startup path, so every
   * failure is contained: it is logged and the project keeps using the global
   * configuration.
   * @param cwd - the project working directory reported by a session.
   */
  function tuneProject(cwd: string): void {
    const existing = tunedProjects.get(cwd)
    if (existing !== undefined) return
    // Resolve the window/top-N policy once per scan: a settings edit mid-scan
    // should not give one project's ranking two different bounds.
    const options = resolveAutoTuneOptions(configSnapshot(config), home)
    const run = (async (): Promise<void> => {
      try {
        const outcome = await autoTune(ctx, cwd, options)
        ctx.logger.info(describeOutcome(outcome, options.topN))
        if (outcome.kind !== 'applied') return
        // Re-read so the override this scan just wrote takes effect without a
        // restart, and re-rank every agent already sitting in this project.
        const override = await readProjectOverride(cwd, home)
        if (override === undefined) return
        projectConfigs.set(cwd, applyProjectOverride(globalConfig(), override))
        for (const state of states.values()) {
          if (state.agent.session?.header.cwd !== cwd) continue
          try {
            refresh(state)
          } catch (error: unknown) {
            ctx.logger.warn(`lazy-tools: re-rank after auto-tune failed (${errorMessage(error)}); keeping the previous catalog`)
          }
        }
      } catch (error: unknown) {
        ctx.logger.warn(`lazy-tools: auto-tune failed (${errorMessage(error)}); keeping the current configuration`)
      }
    })()
    tunedProjects.set(cwd, run)
  }

  /** Start auto-tuning for one agent's project, once per project. */
  function tuneForAgent(agent: Agent): void {
    if (!resolveAutoTuneOptions(configSnapshot(config), home).enabled) return
    const cwd = agent.session?.header.cwd
    if (cwd !== undefined) tuneProject(cwd)
  }

  /**
   * Re-rank one agent against a freshly read registry view. The catalog
   * becomes exactly what the unrestricted registry offers this scope —
   * whatever plane registered it — and the defer patterns in force for THIS
   * agent's project are re-applied over its names with the guards and this
   * agent's prior activations excluded.
   */
  function rank(state: AgentState, schemas: readonly ToolSchema[]): void {
    state.catalog = [...schemas]
    const { deferNames } = resolveDeferConfig(
      state.catalog.map((schema) => schema.name),
      configFor(state.agent),
    )
    state.deferredNames = new Set([...deferNames].filter((name) => !state.activated.has(name)))
  }

  /** Names a mask would hide: the deferred set minus the guard transports. */
  function denyNames(state: AgentState): string[] {
    return [...state.deferredNames].filter((name) => !isGuardTool(name))
  }

  /** Stable signature of a deny list, so a no-op refresh does not re-mask. */
  function signatureOf(deny: readonly string[]): string {
    return [...deny].sort().join('\n')
  }

  /**
   * Names a rejected `tools.restrict()` call reported as unknown. The error
   * lists only the offenders before its "known global tools" tail.
   */
  function unknownRestrictionNames(error: unknown): Set<string> {
    const names = new Set<string>()
    if (!(error instanceof Error)) return names
    const match = /unknown global tool(?:s)? ((?:"[^"]+"[,\s]*)+)/.exec(error.message)
    if (match === null) return names
    for (const quoted of match[1].matchAll(/"([^"]+)"/g)) names.add(quoted[1])
    return names
  }

  /** Lift this agent's mask and forget the signature it stood for. */
  function liftRestriction(state: AgentState): void {
    state.removeRestriction?.()
    state.removeRestriction = undefined
    state.restrictionSignature = ''
  }

  /**
   * Re-apply this agent's mask over inherited tools.
   *
   * A mask is the deferred set minus the guards: the guard pair lives in this
   * agent's OWN scope and is exempt by construction, and the reserved
   * `run_code` transport may not be named at all. Restrictions cannot be
   * edited in place, only lifted and re-added, and every registry mutation
   * fires `tools/change` — so the mask is replaced only when the deny set
   * actually moved, and the whole swap runs muted.
   *
   * Fail-open: a rejected mask (for example a name that is not inherited) is
   * logged and the call guard still withholds the deferred set.
   */
  function applyRestriction(state: AgentState): void {
    const deny = denyNames(state)
    const signature = signatureOf(deny)
    if (signature === state.restrictionSignature) return
    muting += 1
    try {
      liftRestriction(state)
      if (deny.length === 0) return
      let remaining = deny
      for (;;) {
        try {
          state.removeRestriction = state.agent.ctx.tools.restrict({ deny: remaining })
          state.restrictionSignature = signature
          return
        } catch (error: unknown) {
          // A tool registered in this agent's own scope is exempt from
          // restrictions and cannot be named; drop exactly those and mask the rest.
          const unknown = unknownRestrictionNames(error)
          const next = remaining.filter((name) => !unknown.has(name))
          if (next.length === 0 || next.length === remaining.length) {
            ctx.logger.warn(`lazy-tools: could not mask deferred tools (${errorMessage(error)}); the call guard still withholds them`)
            return
          }
          remaining = next
        }
      }
    } finally {
      muting -= 1
    }
  }

  /**
   * Read this scope's registry view with the plugin's own mask lifted.
   *
   * `schemas()` applies restrictions, so reading it while masked would shrink
   * the catalog to the already-visible set and silently drop every deferred
   * name from `tool_search`. The mask is lifted only for this read.
   */
  function schemasUnrestricted(state: AgentState): ToolSchema[] {
    if (state.removeRestriction === undefined) return ctx.tools.schemas(state.agent)
    muting += 1
    try {
      liftRestriction(state)
      return ctx.tools.schemas(state.agent)
    } finally {
      muting -= 1
    }
  }

  /** Re-rank one agent from its unrestricted view and refresh its mask. */
  function refresh(state: AgentState): void {
    rank(state, schemasUnrestricted(state))
    applyRestriction(state)
  }

  /** Build the per-agent {@link ToolsAccess} the two tools consume. */
  function buildAccess(state: AgentState): ToolsAccess {
    return {
      get catalog() { return state.catalog },
      get deferredNames() { return state.deferredNames },
      activate(names) {
        const statuses = new Map<string, LoadStatus>()
        const known = new Set(state.catalog.map((schema) => schema.name))
        for (const name of names) {
          if (!known.has(name)) {
            statuses.set(name, 'unavailable')
            continue
          }
          if (state.deferredNames.has(name)) {
            state.activated.add(name)
            state.deferredNames.delete(name)
            statuses.set(name, 'loaded')
            continue
          }
          statuses.set(name, 'already_loaded')
        }
        // Dropping names from the deferred set is a mask edit, not a re-rank:
        // the catalog and the patterns are unchanged.
        applyRestriction(state)
        return statuses
      },
    }
  }

  /** Attach search/execute tools and the call guard to one live agent. */
  function install(agent: Agent): void {
    if (states.has(agent)) return
    const state: AgentState = {
      agent,
      catalog: [],
      deferredNames: new Set(),
      activated: new Set(),
      removePreExecute: undefined,
      removeTools: [],
      removeRestriction: undefined,
      restrictionSignature: '',
    }
    states.set(agent, state)
    try {
      const access = buildAccess(state)
      const tools = buildTools(access)
      state.removeTools = [
        agent.ctx.tools.register(tools.toolSearch),
        agent.ctx.tools.register(tools.deferExecuteTool),
      ]
      refresh(state)
      // Block direct calls to not-yet-loaded deferred tools with a hint.
      state.removePreExecute = agent.ctx.on('tools/pre-execute', (exec, next) => {
        const toolName = exec.name
        if (isGuardTool(toolName)) return next()
        if (state.deferredNames.has(toolName)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `Tool "${toolName}" is deferred and not yet loaded. Call tool_search with tool_names: ["${toolName}"] first, or use defer_execute_tool to activate it.`,
          })
        }
        return next()
      })
    } catch (error: unknown) {
      states.delete(agent)
      for (const remove of state.removeTools) remove()
      state.removePreExecute?.()
      throw error
    }
  }

  /** Lift every registration owned for one exact agent. */
  function uninstall(agent: Agent): void {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    for (const remove of state.removeTools) remove()
    state.removePreExecute?.()
    liftRestriction(state)
  }

  // DSH 0.2.2 assembles the presentation without the tool declarations: the
  // model-facing list and the PTC `tools:sdk` section both come from the
  // restricted registry view this plugin masks per agent. There is nothing
  // left to filter here, so the old `system-prompt/assemble` listener is gone.
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    tuneForAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { uninstall(agent) })
  // Keep the mask and the search catalog current between requests — a tool
  // mounted by a preset or an MCP server does not wait for the next request.
  // Our own mask swaps fire this event too; `muting` keeps them from re-entering.
  // A failure here must not break the registry mutation that notified us.
  ctx.on('tools/change', () => {
    if (muting > 0) return
    for (const state of states.values()) {
      try {
        refresh(state)
      } catch (error: unknown) {
        ctx.logger.warn(`lazy-tools: re-rank failed (${errorMessage(error)}); keeping the previous catalog`)
      }
    }
  })
  // A settings-page save commits new values into this plugin's volatile config
  // and announces the changed paths here. Re-rank every live agent so the new
  // patterns take effect on the next request instead of the next restart.
  // `volatile-update` carries only the paths whose value actually moved, so a
  // no-op save does not churn the catalog.
  ctx.on('loader/volatile-update', () => {
    if (muting > 0) return
    for (const state of states.values()) {
      try {
        refresh(state)
      } catch (error: unknown) {
        ctx.logger.warn(`lazy-tools: re-rank after a configuration change failed (${errorMessage(error)}); keeping the previous catalog`)
      }
    }
  })
  for (const agent of ctx.agents.list()) {
    install(agent)
    tuneForAgent(agent)
  }
  ctx.effect(() => () => {
    for (const agent of states.keys()) uninstall(agent)
  }, 'lazy-tools: per-agent registrations')
}
