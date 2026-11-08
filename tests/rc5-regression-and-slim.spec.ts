import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { attachPresentAs, defineContentToolFixture, executeTool } from './fixture-tools.ts'
import * as LazyTools from '../src/index.ts'
import { DEFER_EXECUTE_TOOL_NAME, TOOL_SEARCH_NAME, type Config } from '../src/index.ts'
import { isGuardTool } from '../src/config.ts'
import { DEFAULT_ACTIVE_TOOLS } from '../src/preset.ts'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fixture(name: string, description: string, parameters: Record<string, unknown> = { input: { type: 'string' } }) {
  return defineContentToolFixture({
    name,
    description,
    parameters,
    async execute(args) {
      return [{ type: 'text', text: `ran:${name}:${JSON.stringify(args)}` }]
    },
  })
}

async function harness(config: Config = {}): Promise<{ ctx: Context; plugin: Fiber }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('ptcRuntime')
  ctx.ptcRuntime = { language: 'typescript', programFormat: 'function-body' }
  const plugin = await ctx.plugin(LazyTools, config)
  return { ctx, plugin }
}

async function createAgent(ctx: Context, id: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  attachPresentAs(agent)
  return agent
}

async function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: JsonValue,
  parent?: any,
): Promise<ToolExecutionResult> {
  return await executeTool(ctx, agent, name, args, parent, signal)
}

async function offered(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  return assembly.tools.map((schema) => schema.name).sort()
}

describe('DSH 0.2.1-rc.5 & tool-slim keep strategy regression', () => {
  it('keeps all tool-slim resident tools callable by default without deferring', async () => {
    const { ctx } = await harness()

    // Register representative tools from all tool-slim categories
    const residentTools = [
      'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'working_directory',
      'present', 'ask_user_question', 'todo_write',
      'subagent', 'subagent_fork', 'spawn_teammate', 'swarm_dispatch', 'team_task_create',
      'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
      'delegate_task', 'delegation_status',
      'session_search', 'job_kill', 'terminal_read',
      'undo_list', 'undo_restore', 'undo_snapshot', 'undo_recent',
      'update_goal', 'create_goal', 'get_goal', 'load_workspace_dependencies',
      'grill_confirm', 'memory_search',
      'mcp_connector_session_tools', 'mcp_connector_status',
      'dsh_diagnose_plugin_load', 'dsh_check_effect_mode', 'dsh_hot_reload',
      'web_search', 'web_fetch', 'skill',
    ]

    for (const name of residentTools) {
      ctx.tools.register(fixture(name, `Resident tool ${name}`))
    }

    const agent = await createAgent(ctx, 'agent-tool-slim')
    const active = await offered(ctx, agent)

    for (const name of residentTools) {
      expect(active).toContain(name)
    }

    // Direct calls to resident tools should succeed immediately without deferral warning
    const testDirect = await execute(ctx, agent, 'read', { input: 'test.txt' })
    expect(testDirect.isError).toBe(false)
  })

  it('defers non-essential high-overhead plugin tools and provides activation hint', async () => {
    const { ctx } = await harness()

    const heavyTools = [
      'codex_sketch',
      'codex_image_generate',
      'deck_context',
      'deck_issue_create',
      'chatgpt_connectors_call',
      'keel_spec',
      'diff_approval_annotate',
      'mcp__dramaclaw__split_scenes',
    ]

    for (const name of heavyTools) {
      ctx.tools.register(fixture(name, `Heavy tool ${name}`))
    }

    const agent = await createAgent(ctx, 'agent-heavy-defer')
    const active = await offered(ctx, agent)

    for (const name of heavyTools) {
      expect(active).not.toContain(name)
    }

    // Direct execution to deferred tool is blocked with descriptive hint
    const blocked = await execute(ctx, agent, 'codex_sketch', { input: 'design' })
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected blocked execution')
    expect(blocked.error.message).toMatch(/Tool "codex_sketch" is deferred and not yet loaded/)
    expect(blocked.error.message).toContain('tool_search')
    expect(blocked.error.message).toContain('defer_execute_tool')
  })

  it('guarantees AGY tools are never deferred, never blocked, and support dynamic recall', async () => {
    const { ctx } = await harness()

    expect(isGuardTool('agy_tool')).toBe(true)
    expect(isGuardTool('agy_ask')).toBe(true)
    expect(isGuardTool('agy:dispatch')).toBe(true)
    expect(isGuardTool('run_code')).toBe(true)

    ctx.tools.register(fixture('agy_tool', 'AGY bridge tool'))
    ctx.tools.register(fixture('agy_ask', 'AGY ask prompt'))
    ctx.tools.register(fixture('codex_image_generate', 'Heavy deferred image generation'))

    const agent = await createAgent(ctx, 'agent-agy')
    const active = await offered(ctx, agent)

    expect(active).toContain('agy_tool')
    expect(active).toContain('agy_ask')
    expect(active).not.toContain('codex_image_generate')

    // AGY tool executes freely
    const agyRun = await execute(ctx, agent, 'agy_tool', { input: 'agy-op' })
    expect(agyRun.isError).toBe(false)

    // Dynamic recall: AGY activates deferred tool via tool_search
    const searchRes = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['codex_image_generate'] })
    expect(searchRes.isError).toBe(false)
    expect((searchRes.value as any).matches[0]).toMatchObject({
      name: 'codex_image_generate',
      status: 'loaded',
    })

    // Now codex_image_generate is offered and directly callable
    const activeAfter = await offered(ctx, agent)
    expect(activeAfter).toContain('codex_image_generate')

    const deferredRun = await execute(ctx, agent, 'codex_image_generate', { input: 'generate prompt' })
    expect(deferredRun.isError).toBe(false)
  })

  it('strictly preserves permission boundaries and restriction layers', async () => {
    const { ctx } = await harness()

    ctx.tools.register(fixture('normal_tool', 'Normal tool'))
    ctx.tools.register(fixture('restricted_admin_tool', 'Restricted admin tool'))

    const handle = await ctx.agents.create({
      sessionId: SessionId('agent-restricted-boundary'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup(agentCtx) {
        // Enforce strict deny boundary on this agent
        agentCtx.tools.restrict({ deny: ['restricted_admin_tool'] })
      },
    })

    // tool_search must not bypass restriction boundary
    const searchRes = await execute(ctx, handle.agent, TOOL_SEARCH_NAME, { tool_names: ['restricted_admin_tool'] })
    expect(searchRes.isError).toBe(false)
    expect((searchRes.value as any).matches[0]).toMatchObject({
      name: 'restricted_admin_tool',
      status: 'unavailable',
    })

    // defer_execute_tool must not bypass restriction boundary
    const execRes = await execute(ctx, handle.agent, DEFER_EXECUTE_TOOL_NAME, { toolName: 'restricted_admin_tool' })
    expect(execRes.isError).toBe(false)
    expect((execRes.value as any).status).toBe('unavailable')

    // Restricted tool must never appear in offered list
    const active = await offered(ctx, handle.agent)
    expect(active).not.toContain('restricted_admin_tool')

    await handle.dispose()
  })

  it('measures baseline vs candidate schema size in PTC and Native modes', async () => {
    const { ctx } = await harness()

    // Create a realistic tool catalog simulating the 140+ tools found in real DSH desktop profile
    const simulatedTools: { name: string; desc: string; params: Record<string, unknown> }[] = []

    // 1. Core resident tools (~40 tools)
    for (const tool of DEFAULT_ACTIVE_TOOLS) {
      const baseName = tool.replace('*', '')
      // run_code is the reserved PTC transport: never register a mock for it.
      if (baseName === 'run_code') continue
      simulatedTools.push({
        name: baseName,
        desc: `Description for resident tool ${baseName}`,
        params: {
          path: { type: 'string', description: 'File or target path' },
          options: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
        },
      })
    }

    // 2. High overhead plugin tools with large schemas (codex, deck, mcp, schedule, etc.)
    const heavyPluginTools = [
      {
        name: 'codex_sketch',
        desc: 'Generate interactive web application sketches and high-fidelity prototype diagrams with canvas integration',
        params: {
          action: { type: 'string', enum: ['init', 'draw', 'export', 'diff', 'patch'] },
          canvasData: { type: 'object', additionalProperties: false, properties: { layers: { type: 'array', items: { type: 'string' } } } },
          styling: { type: 'object', additionalProperties: false, properties: { theme: { type: 'string' }, width: { type: 'number' } } },
          targetFormats: { type: 'array', items: { type: 'string', enum: ['png', 'svg', 'json', 'pdf'] } },
        },
      },
      {
        name: 'codex_image_generate',
        desc: 'Advanced multi-modal generative image diffusion tool with prompting engineering and conditioning',
        params: {
          prompt: { type: 'string', description: 'Image generation prompt' },
          negativePrompt: { type: 'string' },
          attachmentId: { type: 'string' },
          seed: { type: 'number' },
          steps: { type: 'number' },
          guidance: { type: 'number' },
          modelVariant: { type: 'string', enum: ['sdxl', 'flux', 'dall-e-3', 'custom'] },
        },
      },
      {
        name: 'deck_issue_create',
        desc: 'Create trackable engineering deck issues with dependencies, source attachments, milestones and assignees',
        params: {
          title: { type: 'string' },
          text: { type: 'string' },
          source: { type: 'string' },
          kind: { type: 'string', enum: ['bug', 'feature', 'refactor', 'task'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          metadata: { type: 'object', additionalProperties: false, properties: { estimate: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } } },
        },
      },
      {
        name: 'deck_map_plan_create',
        desc: 'Create architecture dependency plan graphs with visual node connections and execution constraints',
        params: {
          title: { type: 'string' },
          nodes: { type: 'array', items: { type: 'string' } },
          edges: { type: 'array', items: { type: 'string' } },
        },
      },
      {
        name: 'chatgpt_connectors_call',
        desc: 'Call external ChatGPT connector plugins and API integrations with schema validation',
        params: {
          name: { type: 'string' },
          endpoint: { type: 'string' },
          payload: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } } },
        },
      },
      {
        name: 'keel_spec',
        desc: 'Formal specification generator and verification suite for multi-service architectures',
        params: {
          template: { type: 'string' },
          fields: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } },
          strictMode: { type: 'boolean' },
        },
      },
      {
        name: 'mcp__dramaclaw__split_scenes',
        desc: 'Parse, segment and analyze multi-character screenplay script into scene blocks with beat detection',
        params: {
          scriptText: { type: 'string' },
          sceneTypes: { type: 'array', items: { type: 'string' } },
          minDuration: { type: 'number' },
        },
      },
    ]

    for (const t of heavyPluginTools) {
      simulatedTools.push(t)
    }

    for (const st of simulatedTools) {
      ctx.tools.register(fixture(st.name, st.desc, st.params))
    }

    const agent = await createAgent(ctx, 'agent-measurement')
    agent.ctx.tools.presentAs('ptc')

    // 1. Measure Candidate (with lazy-tools keep strategy)
    const candidateAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    const candidateSdkSection = candidateAssembly.sections.find((s) => s.name === 'tools:sdk')
    const candidateSdkLen = candidateSdkSection?.text.length ?? 0

    // 2. Measure Baseline (without lazy-tools filtering)
    // To measure baseline, get raw unfiltered SDK rendering
    const rawSchemas = ctx.tools.schemas(agent)
    // Baseline character count if all schemas were rendered in PTC tools:sdk
    let baselineSdkApproxLen = 0
    for (const s of rawSchemas) {
      baselineSdkApproxLen += JSON.stringify(s).length + s.name.length * 3 + (s.description?.length ?? 0)
    }

    const candidateEstimatedTokens = Math.round(candidateSdkLen / 4.5)
    const baselineEstimatedTokens = Math.round((baselineSdkApproxLen + candidateSdkLen) / 4.5)
    const tokensSaved = baselineEstimatedTokens - candidateEstimatedTokens

    console.log('\n--- Tool Schema Size Measurement ---')
    console.log(`Total tools registered in host: ${simulatedTools.length}`)
    console.log(`Candidate active tools in prompt: ${candidateSdkSection?.text.split('\n').filter(l => l.includes(': {')).length ?? 0}`)
    console.log(`Candidate tools:sdk character length: ${candidateSdkLen} (~${candidateEstimatedTokens} tokens)`)
    console.log(`Baseline tools:sdk character length: ${candidateSdkLen + baselineSdkApproxLen} (~${baselineEstimatedTokens} tokens)`)
    console.log(`Estimated Token Savings per step: ~${tokensSaved} tokens (${Math.round((tokensSaved / baselineEstimatedTokens) * 100)}% reduction)`)
    console.log('------------------------------------\n')

    expect(tokensSaved).toBeGreaterThan(0)
    expect(candidateSdkSection?.text).not.toContain('codex_sketch')
    expect(candidateSdkSection?.text).not.toContain('codex_image_generate')
    expect(candidateSdkSection?.text).toContain('read')
    expect(candidateSdkSection?.text).toContain('bash')
    expect(candidateSdkSection?.text).toContain('subagent')
  })
})
