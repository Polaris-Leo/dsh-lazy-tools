import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, executeTool } from './fixture-tools.ts'
import * as LazyTools from '../src/index.ts'
import { DEFER_EXECUTE_TOOL_NAME, TOOL_SEARCH_NAME, type Config } from '../src/index.ts'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fixture(name: string, description: string) {
  return defineContentToolFixture({
    name,
    description,
    parameters: {},
    async execute() { return [{ type: 'text', text: `ran:${name}` }] },
  })
}

async function harness(config: Config = {}): Promise<{ ctx: Context; plugin: Fiber }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const plugin = await ctx.plugin(LazyTools, config)
  return { ctx, plugin }
}

async function createAgent(ctx: Context, id: string): Promise<Agent> {
  return await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

async function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: JsonValue,
): Promise<ToolExecutionResult> {
  return await executeTool(ctx, agent, name, args, undefined, signal)
}

/** Tool names the model would actually be offered on the next request. */
async function offered(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  return assembly.tools.map(schema => schema.name).sort()
}

/**
 * Mount a stand-in for the Web/Desktop agent-preset plane: a scope that OWNS
 * the model-facing tools and sits ABOVE the agent, so nothing it registers is
 * visible in the global registry the plugin could read.
 */
async function mountPresetScope(ctx: Context, agent: Agent, tools: string[]) {
  const key = {}
  bindScopeParent(agent, key)
  await ctx.plugin({
    name: 'test-agent-preset',
    inject: ['tools'],
    apply(presetHost) {
      const preset = createScope(presetHost, key)
      for (const name of tools) preset.ctx.tools.register(fixture(name, `${name} from the agent preset`))
    },
  })
}

describe('deferred tool loading', () => {
  it('hides deferred globals from the model-facing assembly and blocks a direct call with a hint', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'hidden')

    expect(await offered(ctx, agent)).toEqual(
      ['read_file', TOOL_SEARCH_NAME, DEFER_EXECUTE_TOOL_NAME].sort(),
    )
    const blocked = await execute(ctx, agent, 'glob', {})
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected blocked direct call')
    expect(blocked.error.message).toMatch(/deferred and not yet loaded/)
  })

  it('loads a tool via tool_search and offers it on the next request', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'search')

    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['glob'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'glob', status: 'loaded' }],
    })
    expect(await offered(ctx, agent)).toContain('glob')
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('activates a deferred tool by name via defer_execute_tool', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'activate')

    const activated = await execute(ctx, agent, DEFER_EXECUTE_TOOL_NAME, { toolName: 'glob' })
    expect(activated.isError ? undefined : activated.value).toMatchObject({
      toolName: 'glob',
      status: 'loaded',
    })
    expect(await offered(ctx, agent)).toContain('glob')
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('reports unavailable for a tool an independent restriction denies', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'] })
    ctx.tools.register(fixture('public_lookup', 'Find public records'))
    ctx.tools.register(fixture('secret_lookup', 'Find private secret records'))
    const handle = await ctx.agents.create({
      sessionId: SessionId('filtered'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup(agentCtx) { agentCtx.tools.restrict({ deny: ['secret_lookup'] }) },
    })

    const found = await execute(ctx, handle.agent, TOOL_SEARCH_NAME, { tool_names: ['secret_lookup'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'secret_lookup', status: 'unavailable' }],
    })
    expect(await offered(ctx, handle.agent)).not.toContain('secret_lookup')
    await handle.dispose()
  })

  it('reports unavailable for a name that does not exist', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    const agent = await createAgent(ctx, 'typo')

    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['reed_file'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'reed_file', status: 'unavailable' }],
    })
  })

  it('defers tools that live in an ancestor (agent-preset) scope, not the global registry', async () => {
    // The Web/Desktop surfaces register model-facing tools in the session's
    // preset scope, so the global registry reads zero of them. Deferral must
    // still see and hide them.
    const { ctx } = await harness({ defer: ['Defer(*)'], noDefer: [] })
    const agent = await createAgent(ctx, 'preset-plane')
    ctx.tools.register(fixture('global_echo', 'A host-plane tool'))

    await mountPresetScope(ctx, agent, ['read', 'bash', 'glob'])

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['global_echo'])
    expect(await offered(ctx, agent)).toEqual([TOOL_SEARCH_NAME, DEFER_EXECUTE_TOOL_NAME].sort())

    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['glob'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'glob', status: 'loaded' }],
    })
    expect(await offered(ctx, agent)).toContain('glob')
    expect(await offered(ctx, agent)).not.toContain('bash')
  })

  it('keeps noDefer tools from an ancestor scope offered', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'], noDefer: ['bash'] })
    const agent = await createAgent(ctx, 'preset-nodefer')
    await mountPresetScope(ctx, agent, ['bash', 'glob'])

    const names = await offered(ctx, agent)
    expect(names).toContain('bash')
    expect(names).not.toContain('glob')
  })

  it('picks up tools registered after the agent was created', async () => {
    const { ctx } = await harness({ defer: ['mcp_*'] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    const agent = await createAgent(ctx, 'late')

    ctx.tools.register(fixture('mcp_late', 'Late MCP-style remote capability'))
    expect(await offered(ctx, agent)).not.toContain('mcp_late')
    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['mcp_late'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'mcp_late', status: 'loaded' }],
    })
    expect(await offered(ctx, agent)).toContain('mcp_late')
  })

  it('noDefer keeps a tool active under Defer(*)', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'], noDefer: ['bash'] })
    ctx.tools.register(fixture('bash', 'Run a shell command'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'nodefer')

    const names = await offered(ctx, agent)
    expect(names).toContain('bash')
    expect(names).not.toContain('glob')
    const ran = await execute(ctx, agent, 'bash', {})
    expect(ran.isError).toBe(false)
  })

  it('an empty defer config leaves every tool offered and callable', async () => {
    // "Turn deferring off" is spelled `defer: []` — there is no separate switch,
    // because an empty list already says exactly this.
    const { ctx } = await harness({ defer: [] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'disabled')

    expect(await offered(ctx, agent)).toContain('glob')
    const ran = await execute(ctx, agent, 'glob', {})
    expect(ran.isError).toBe(false)
  })

  it('an empty defer config withholds nothing', async () => {
    const { ctx } = await harness({ defer: [] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    const agent = await createAgent(ctx, 'no-defer')

    ctx.tools.register(fixture('mcp_late', 'Late-registered capability'))
    const names = await offered(ctx, agent)
    expect(names).toContain('read_file')
    expect(names).toContain('mcp_late')
  })

  it('guard tools are never deferred even under Defer(*)', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'], noDefer: [] })
    ctx.tools.register(fixture('custom_tool', 'A custom tool'))
    const agent = await createAgent(ctx, 'guards')

    expect(await offered(ctx, agent)).toEqual([TOOL_SEARCH_NAME, DEFER_EXECUTE_TOOL_NAME].sort())
  })

  it('a zero-config install keeps the shipped core callable and defers the long tail', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(fixture('read', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    ctx.tools.register(fixture('read_image', 'Read an image'))
    ctx.tools.register(fixture('subagent', 'Spawn a subagent'))
    ctx.tools.register(fixture('codex_sketch', 'Heavy design tool'))

    // No configuration at all: the shipped preset must be in effect.
    await ctx.plugin(LazyTools)

    const agent = await createAgent(ctx, 'preset-default')
    const names = await offered(ctx, agent)
    expect(names).toContain('read')
    expect(names).toContain('glob')
    expect(names).toContain('subagent')
    expect(names).toContain(TOOL_SEARCH_NAME)
    expect(names).toContain(DEFER_EXECUTE_TOOL_NAME)
    expect(names).toContain('read_image')
    expect(names).not.toContain('codex_sketch')

    const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { tool_names: ['codex_sketch'] })
    expect(found.isError ? undefined : found.value).toMatchObject({
      matches: [{ name: 'codex_sketch', status: 'loaded' }],
    })
    expect(await offered(ctx, agent)).toContain('codex_sketch')
  })

  it('an explicit defer config replaces the shipped preset', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('read', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'preset-replaced')

    // glob ships in the preset core, but naming `defer` takes over completely.
    const names = await offered(ctx, agent)
    expect(names).toContain('read')
    expect(names).not.toContain('glob')
  })

  it('hot-loads existing agents and restores the original surface on plugin disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(fixture('read_file', 'Read a local file'))
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'hot-load')
    expect(await offered(ctx, agent)).toEqual(['glob', 'read_file'])

    const plugin = await ctx.plugin(LazyTools, { defer: ['glob'] })
    expect(await offered(ctx, agent)).not.toContain('glob')
    await plugin.dispose()
    expect(await offered(ctx, agent)).toEqual(['glob', 'read_file'])
  })

  it('leaves agents it never installed on untouched', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'unmanaged')

    // An agent that arrives while no plugin instance is mounted stays untouched.
    expect(await offered(ctx, agent)).toContain('glob')
  })

  it('handles duplicate lifecycle notifications and an already-uninstalled agent', async () => {
    const { ctx } = await harness({ defer: ['glob'] })
    ctx.tools.register(fixture('glob', 'Find files by pattern'))
    const agent = await createAgent(ctx, 'duplicate')
    expect(() => { ctx.emit('agent/created', { agent }) }).not.toThrow()
    expect(await offered(ctx, agent)).not.toContain('glob')
    ctx.emit('agent/disposed', { agent })
    expect(await offered(ctx, agent)).toContain('glob')
    expect(() => { ctx.emit('agent/disposed', { agent }) }).not.toThrow()
  })
  it('never defers or blocks agy_tool (AGY bridge mirror tool)', async () => {
    const { ctx } = await harness({ defer: ['Defer(*)'] })
    ctx.tools.register(fixture('agy_tool', 'Antigravity bridge mirror tool'))
    ctx.tools.register(fixture('some_tool', 'A deferred tool'))
    const agent = await createAgent(ctx, 'agy-test')

    // agy_tool is offered, some_tool is deferred
    const tools = await offered(ctx, agent)
    expect(tools).toContain('agy_tool')
    expect(tools).not.toContain('some_tool')

    // agy_tool is callable directly without being blocked
    const ran = await execute(ctx, agent, 'agy_tool', {})
    expect(ran.isError).toBe(false)
    if (!ran.isError) {
      expect(ran.value).toEqual([{ type: 'text', text: 'ran:agy_tool' }])
    }
  })

  it('calls downstream system-prompt/assemble waterfall listeners without vetoing the chain', async () => {
    const { ctx } = await harness({ defer: ['alpha'] })
    ctx.tools.register(fixture('alpha', 'deferred tool'))
    ctx.tools.register(fixture('beta', 'active tool'))
    const agent = await createAgent(ctx, 'downstream-test')

    let downstreamCalled = false
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      downstreamCalled = true
      const res = typeof next === 'function' ? await next() : assembly
      return {
        ...res,
        sections: [...(res.sections ?? []), { name: 'downstream:section', text: 'hello from downstream' }],
      }
    })

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(downstreamCalled).toBe(true)
    expect(assembly.sections?.some(s => s.name === 'downstream:section')).toBe(true)
    expect(assembly.tools.map(t => t.name)).not.toContain('alpha')
    expect(assembly.tools.map(t => t.name)).toContain('beta')
  })
})
