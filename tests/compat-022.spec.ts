/**
 * DSH 0.2.2-rc.1 Compatibility and Integration Specification.
 *
 * Verifies real @deepseek-ai/dsh-tools (0.2.2-rc.1) interfaces:
 * - Real `defineTool` registration without mock fixtures
 * - Batch `tools.execute` pipeline invocation
 * - Global deferred tools hidden from agent schemas and system prompt assemblies
 * - Direct execution blocked with deferred hint
 * - Activation via `tool_search` and `defer_execute_tool`
 * - Visible and executable after activation
 * - Strict agent isolation across concurrent agents
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolBatchResult, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as LazyTools from '../src/index.ts'
import { DEFER_EXECUTE_TOOL_NAME, TOOL_SEARCH_NAME, type Config } from '../src/index.ts'

const contexts: Context[] = []
const signal = new AbortController().signal
let callOrdinal = 0

afterEach(async () => {
  callOrdinal = 0
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
})

/**
 * Define a production-grade ToolDefinition using DSH 0.2.2-rc.1's real `defineTool`.
 */
function createRealTool(name: string, description: string, echoText = `ran:${name}`): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: {
      input: {
        type: 'string',
        description: 'Optional input payload',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      return args.input ? `${echoText}:${args.input}` : echoText
    },
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

/**
 * Execute tool calls using real DSH 0.2.2-rc.1 batch `tools.execute` pipeline.
 */
async function executeBatch(
  ctx: Context,
  agent: Agent,
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
): Promise<ToolBatchResult> {
  callOrdinal += 1
  return await ctx.tools.execute({
    calls: calls.map((c, idx) => ({
      id: ToolCallId(`compat-022-${callOrdinal}-${idx}`),
      name: c.name,
      arguments: c.args ?? {},
    })),
    agent,
    signal,
  })
}

/** Tool names the model is offered in the assembled system prompt. */
async function offered(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  return assembly.tools.map((schema) => schema.name).sort()
}

describe('DSH 0.2.2-rc.1 real interface integration and agent isolation', () => {
  it('hides global tools from agent schemas and offered list by default, blocking direct calls with hint', async () => {
    const { ctx } = await harness()
    const globalTool = createRealTool('database_query', 'Query database contents')
    ctx.tools.register(globalTool)

    const agent = await createAgent(ctx, 'agent-hide-test')

    // Guard tools are present, global deferred tool is hidden
    const offeredTools = await offered(ctx, agent)
    expect(offeredTools).toContain(TOOL_SEARCH_NAME)
    expect(offeredTools).toContain(DEFER_EXECUTE_TOOL_NAME)
    expect(offeredTools).not.toContain('database_query')

    const schemaNames = ctx.tools.schemas(agent).map((s) => s.name)
    expect(schemaNames).not.toContain('database_query')

    // Direct execution is intercepted by pre-execute guard and denied with hint
    const batchResult = await executeBatch(ctx, agent, [
      { name: 'database_query', args: { input: 'SELECT * FROM users' } },
    ])
    expect(batchResult.results).toHaveLength(1)
    const callResult = batchResult.results[0].result
    expect(callResult.isError).toBe(true)
    expect(callResult.error?.message).toMatch(
      /Tool "database_query" is deferred and not yet loaded. Call tool_search with tool_names: \["database_query"\] first, or use defer_execute_tool to activate it\./,
    )
  })

  it('activates deferred tool via tool_search and makes it visible and executable', async () => {
    const { ctx } = await harness()
    const codeSearchTool = createRealTool('code_search', 'Search source code files')
    const fileIndexTool = createRealTool('file_index', 'Index project files')
    ctx.tools.register(codeSearchTool)
    ctx.tools.register(fileIndexTool)

    const agent = await createAgent(ctx, 'agent-search-test')

    // Initially neither tool is offered
    let offeredTools = await offered(ctx, agent)
    expect(offeredTools).not.toContain('code_search')
    expect(offeredTools).not.toContain('file_index')

    // Activate code_search via tool_search
    const searchResult = await executeBatch(ctx, agent, [
      { name: TOOL_SEARCH_NAME, args: { tool_names: ['code_search'] } },
    ])
    expect(searchResult.results[0].result.isError).toBe(false)
    const searchValue = searchResult.results[0].result.value as {
      matches: Array<{ name: string; status: string }>
      remainingDeferred: number
    }
    expect(searchValue.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'code_search', status: 'loaded' }),
      ]),
    )

    // Verify code_search is now offered and in schemas, while file_index remains withheld
    offeredTools = await offered(ctx, agent)
    expect(offeredTools).toContain('code_search')
    expect(offeredTools).not.toContain('file_index')

    // Execute activated code_search
    const execResult = await executeBatch(ctx, agent, [
      { name: 'code_search', args: { input: 'find_symbol' } },
    ])
    expect(execResult.results[0].result.isError).toBe(false)
    expect(execResult.results[0].result.value).toBe('ran:code_search:find_symbol')

    // file_index is still deferred and blocked
    const blockedResult = await executeBatch(ctx, agent, [
      { name: 'file_index', args: { input: 'all' } },
    ])
    expect(blockedResult.results[0].result.isError).toBe(true)
    expect(blockedResult.results[0].result.error?.message).toContain('file_index')
  })

  it('activates deferred tool via defer_execute_tool by exact name', async () => {
    const { ctx } = await harness()
    const gitTool = createRealTool('git_commit', 'Commit git changes')
    ctx.tools.register(gitTool)

    const agent = await createAgent(ctx, 'agent-defer-exec-test')

    expect(await offered(ctx, agent)).not.toContain('git_commit')

    // Activate using defer_execute_tool
    const activateResult = await executeBatch(ctx, agent, [
      { name: DEFER_EXECUTE_TOOL_NAME, args: { toolName: 'git_commit' } },
    ])
    expect(activateResult.results[0].result.isError).toBe(false)
    const activateValue = activateResult.results[0].result.value as { toolName: string; status: string }
    expect(activateValue.toolName).toBe('git_commit')
    expect(activateValue.status).toBe('loaded')

    // Now offered and executable
    expect(await offered(ctx, agent)).toContain('git_commit')
    const execResult = await executeBatch(ctx, agent, [
      { name: 'git_commit', args: { input: 'fix typo' } },
    ])
    expect(execResult.results[0].result.isError).toBe(false)
    expect(execResult.results[0].result.value).toBe('ran:git_commit:fix typo')
  })

  it('strictly isolates tool activation and restrictions between different agents', async () => {
    const { ctx } = await harness()
    const isolatedTool = createRealTool('secure_vault', 'Access isolated secure vault')
    ctx.tools.register(isolatedTool)

    const agentAlpha = await createAgent(ctx, 'agent-alpha')
    const agentBeta = await createAgent(ctx, 'agent-beta')

    // Both agents start with secure_vault deferred
    expect(await offered(ctx, agentAlpha)).not.toContain('secure_vault')
    expect(await offered(ctx, agentBeta)).not.toContain('secure_vault')

    // Agent Alpha activates secure_vault
    const alphaSearch = await executeBatch(ctx, agentAlpha, [
      { name: TOOL_SEARCH_NAME, args: { tool_names: ['secure_vault'] } },
    ])
    expect(alphaSearch.results[0].result.isError).toBe(false)

    // Agent Alpha now sees secure_vault and can execute it
    expect(await offered(ctx, agentAlpha)).toContain('secure_vault')
    expect(ctx.tools.schemas(agentAlpha).map((s) => s.name)).toContain('secure_vault')

    const alphaExec = await executeBatch(ctx, agentAlpha, [
      { name: 'secure_vault', args: { input: 'token-alpha' } },
    ])
    expect(alphaExec.results[0].result.isError).toBe(false)
    expect(alphaExec.results[0].result.value).toBe('ran:secure_vault:token-alpha')

    // Agent Beta must remain untouched and isolated:
    // secure_vault MUST NOT be in offered or schemas for Agent Beta
    expect(await offered(ctx, agentBeta)).not.toContain('secure_vault')
    expect(ctx.tools.schemas(agentBeta).map((s) => s.name)).not.toContain('secure_vault')

    // Agent Beta direct call must still be blocked by pre-execute guard
    const betaBlocked = await executeBatch(ctx, agentBeta, [
      { name: 'secure_vault', args: { input: 'token-beta' } },
    ])
    expect(betaBlocked.results[0].result.isError).toBe(true)
    expect(betaBlocked.results[0].result.error?.message).toMatch(
      /Tool "secure_vault" is deferred and not yet loaded/,
    )

    // Agent Beta independently activates secure_vault
    const betaActivate = await executeBatch(ctx, agentBeta, [
      { name: DEFER_EXECUTE_TOOL_NAME, args: { toolName: 'secure_vault' } },
    ])
    expect(betaActivate.results[0].result.isError).toBe(false)

    // Agent Beta now sees and can execute secure_vault
    expect(await offered(ctx, agentBeta)).toContain('secure_vault')
    const betaExec = await executeBatch(ctx, agentBeta, [
      { name: 'secure_vault', args: { input: 'token-beta' } },
    ])
    expect(betaExec.results[0].result.isError).toBe(false)
    expect(betaExec.results[0].result.value).toBe('ran:secure_vault:token-beta')
  })

  it('handles multi-call batch with mixed active and deferred tools in a single turn', async () => {
    const { ctx } = await harness()
    const activeTool = createRealTool('active_tool', 'Already active tool')
    const deferredTool = createRealTool('deferred_tool', 'Deferred tool')
    ctx.tools.register(activeTool)
    ctx.tools.register(deferredTool)

    const agent = await createAgent(ctx, 'agent-mixed-batch')

    // Activate active_tool only
    await executeBatch(ctx, agent, [
      { name: TOOL_SEARCH_NAME, args: { tool_names: ['active_tool'] } },
    ])

    // Execute both in a single batch call array
    const batchResult = await executeBatch(ctx, agent, [
      { name: 'active_tool', args: { input: 'call-1' } },
      { name: 'deferred_tool', args: { input: 'call-2' } },
    ])

    expect(batchResult.results).toHaveLength(2)

    // First call succeeded
    expect(batchResult.results[0].result.isError).toBe(false)
    expect(batchResult.results[0].result.value).toBe('ran:active_tool:call-1')

    // Second call failed with deferred warning
    expect(batchResult.results[1].result.isError).toBe(true)
    expect(batchResult.results[1].result.error?.message).toMatch(
      /Tool "deferred_tool" is deferred and not yet loaded/,
    )
  })
})
