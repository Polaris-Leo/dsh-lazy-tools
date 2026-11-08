import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { attachPresentAs, defineContentToolFixture, executeTool } from './fixture-tools.ts'
import * as LazyTools from '../src/index.ts'
import { DEFER_EXECUTE_TOOL_NAME, TOOL_SEARCH_NAME, type Config } from '../src/index.ts'
import { filterToolsSdkText } from '../src/ptc-filter.ts'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fixture(name: string, description: string) {
  return defineContentToolFixture({
    name,
    description,
    parameters: {
      input: { type: 'string', description: 'test input' },
    },
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
  // Provide mock PTC runtime so dsh-tools can render tools:sdk in PTC mode
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

describe('filterToolsSdkText unit tests', () => {
  it('returns untouched string if text is empty or deferred set is empty', () => {
    expect(filterToolsSdkText('', new Set(['bash']))).toBe('')
    expect(filterToolsSdkText('interface ToolArgsMap {}', new Set())).toBe('interface ToolArgsMap {}')
  })

  it('filters deferred tool from ToolArgsMap and ToolOutputMap while keeping active tools and comments', () => {
    const rawSdk = `
interface ToolArgsMap {
  /**
   * Run bash command
   */
  bash: {
    command: string;
  };
  /**
   * Search tools on demand
   */
  tool_search: {
    query: string;
  };
  /**
   * Deferred database query
   */
  db_query: {
    sql: string;
  };
}
interface ToolOutputMap {
  bash: {
    stdout: string;
  };
  tool_search: {
    matches: unknown[];
  };
  db_query: {
    rows: unknown[];
  };
}
type ToolName = keyof ToolOutputMap
`
    const filtered = filterToolsSdkText(rawSdk, new Set(['db_query']))

    expect(filtered).not.toContain('db_query')
    expect(filtered).not.toContain('Deferred database query')
    expect(filtered).toContain('bash:')
    expect(filtered).toContain('Run bash command')
    expect(filtered).toContain('tool_search:')
    expect(filtered).toContain('type ToolName = keyof ToolOutputMap')
  })

  it('handles quoted tool identifiers correctly', () => {
    const rawSdk = `
interface ToolArgsMap {
  'custom-tool-1': {
    foo: string;
  };
  'custom-tool-2': {
    bar: string;
  };
}
interface ToolOutputMap {
  'custom-tool-1': {
    ok: boolean;
  };
  'custom-tool-2': {
    ok: boolean;
  };
}
`
    const filtered = filterToolsSdkText(rawSdk, new Set(['custom-tool-1']))
    expect(filtered).not.toContain('custom-tool-1')
    expect(filtered).toContain("'custom-tool-2': {")
  })

  it('handles folded ToolOutputMap from dsh-ptc-sdk-slim', () => {
    const rawSdk = `
interface ToolArgsMap {
  bash: {
    cmd: string;
  };
  slow_fetch: {
    url: string;
  };
}
type ToolOutputMap = { [K in keyof ToolArgsMap]: unknown };
type ToolName = keyof ToolOutputMap
`
    const filtered = filterToolsSdkText(rawSdk, new Set(['slow_fetch']))
    expect(filtered).not.toContain('slow_fetch')
    expect(filtered).toContain('bash:')
    expect(filtered).toContain('type ToolOutputMap = { [K in keyof ToolArgsMap]: unknown };')
  })
})

describe('PTC mode integration in LazyTools', () => {
  it('hides deferred tools from tools:sdk in PTC mode while keeping active tools and run_code', async () => {
    const { ctx } = await harness({ defer: ['slow_tool'] })
    ctx.tools.register(fixture('fast_tool', 'Fast callable tool'))
    ctx.tools.register(fixture('slow_tool', 'Slow deferred tool'))

    const agent = await createAgent(ctx, 'ptc-agent-1')
    agent.ctx.tools.presentAs('ptc')

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })

    // In PTC mode, assembly.tools only contains run_code
    expect(assembly.tools.map((t) => t.name)).toEqual([RUN_CODE_NAME])

    // tools:sdk section is present and filtered
    const sdkSection = assembly.sections.find((s) => s.name === 'tools:sdk')
    expect(sdkSection).toBeDefined()
    expect(sdkSection?.text).toContain('fast_tool')
    expect(sdkSection?.text).toContain(TOOL_SEARCH_NAME)
    expect(sdkSection?.text).toContain(DEFER_EXECUTE_TOOL_NAME)
    expect(sdkSection?.text).not.toContain('slow_tool')
  })

  it('denies direct nested calls to deferred tools before activation, and allows after activation', async () => {
    const { ctx } = await harness({ defer: ['deferred_op'] })
    ctx.tools.register(fixture('active_op', 'Directly active operation'))
    ctx.tools.register(fixture('deferred_op', 'Deferred operation'))

    const agent = await createAgent(ctx, 'ptc-agent-2')
    agent.ctx.tools.presentAs('ptc')

    // Initial assemble: deferred_op is withheld
    const firstAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    const sdk1 = firstAssembly.sections.find((s) => s.name === 'tools:sdk')?.text
    expect(sdk1).not.toContain('deferred_op')
    expect(sdk1).toContain('active_op')

    const parentToken = Symbol('ptc-parent-run-code') as any

    // Sub-dispatch inside run_code to deferred_op is blocked with hint
    const blocked = await execute(ctx, agent, 'deferred_op', { input: 'test' }, parentToken)
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected blocked execution')
    expect(blocked.error.message).toMatch(/Tool "deferred_op" is deferred and not yet loaded/)

    // Activate tool via defer_execute_tool (also nested inside run_code)
    const activated = await execute(ctx, agent, DEFER_EXECUTE_TOOL_NAME, { toolName: 'deferred_op' }, parentToken)
    expect(activated.isError).toBe(false)

    // Next assemble: deferred_op is now visible in tools:sdk!
    const secondAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    const sdk2 = secondAssembly.sections.find((s) => s.name === 'tools:sdk')?.text
    expect(sdk2).toContain('deferred_op')

    // Subsequent sub-dispatch is permitted
    const success = await execute(ctx, agent, 'deferred_op', { input: 'hello' }, parentToken)
    expect(success.isError).toBe(false)
  })

  it('re-ranks correctly when new tools are added dynamically to the registry in PTC mode', async () => {
    const { ctx } = await harness({ defer: ['Defer(late_*)'] })
    ctx.tools.register(fixture('base_tool', 'Base tool'))

    const agent = await createAgent(ctx, 'ptc-agent-3')
    agent.ctx.tools.presentAs('ptc')

    // Dynamically register late_fetch tool
    ctx.tools.register(fixture('late_fetch', 'Dynamically registered tool matching defer pattern'))

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    const sdk = assembly.sections.find((s) => s.name === 'tools:sdk')?.text
    expect(sdk).toContain('base_tool')
    expect(sdk).not.toContain('late_fetch')

    const parentToken = Symbol('ptc-parent') as any
    const blocked = await execute(ctx, agent, 'late_fetch', { input: 'ping' }, parentToken)
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected blocked execution')
    expect(blocked.error.message).toContain('late_fetch')
  })
})
