/**
 * Shared test fixtures and DSH 0.2.2-rc.1 compatibility helpers.
 */

import { defineTool, type ToolDefinition, type ToolExecutionResult, type ToolBatchResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId, type JsonValue, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
let ptcPlugin: any
try {
  const testkitPath = req.resolve('@deepseek-ai/dsh-agent-loop-testkit')
  const testkitReq = createRequire(testkitPath)
  ptcPlugin = testkitReq('@deepseek-ai/dsh-tool-executor-ptc')
} catch {
  // Ignore if unavailable
}

export { ptcPlugin }

export interface ContentToolFixtureOptions {
  name: string
  description: string
  parameters?: Record<string, unknown>
  execute?: (args: any, exec?: any) => Promise<any> | any
}

/**
 * Production-grade ToolDefinition using DSH 0.2.2-rc.1's `defineTool`.
 * Drop-in replacement for the deprecated defineContentToolFixture.
 */
export function defineContentToolFixture(options: ContentToolFixtureOptions): ToolDefinition {
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: (options.parameters as any) ?? {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (Array.isArray(value)) return value as ContentBlock[]
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      if (options.execute) {
        const res = await options.execute(args, exec)
        return res ?? null
      }
      return [{ type: 'text', text: `ran:${options.name}` }]
    },
  })
}

/**
 * Attach `presentAs('ptc')` support to agent.ctx.tools for tests written against earlier DSH APIs.
 */
export function attachPresentAs(agent: Agent): void {
  ;(agent.ctx.tools as any).presentAs = (mode: string) => {
    if (mode === 'ptc' && ptcPlugin?.PtcExecutor) {
      agent.ctx.tools.setExecutor(new ptcPlugin.PtcExecutor(agent.ctx))
    }
  }
}

let callOrdinal = 0

/**
 * Execute a single tool call via DSH 0.2.2-rc.1 tools.execute batch pipeline,
 * supporting PTC nested sub-calls when parent token is provided.
 */
export async function executeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: JsonValue = {},
  parent?: any,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  callOrdinal += 1
  const callId = ToolCallId(`lazy-tools-fixture-${callOrdinal}-${name}`)

  if (parent !== undefined) {
    const executor = (ctx.tools as any).selectExecutor?.(agent)
    if (executor?.pipeline) {
      const prep = await executor.pipeline.prepare({
        callId,
        name,
        arguments: args,
        agent,
        parent,
        signal,
      })
      if (prep.kind === 'dispatch') {
        const disp = await executor.pipeline.dispatch(prep.exec)
        return await executor.pipeline.complete(prep.exec, disp)
      } else {
        return await executor.pipeline.complete(prep.exec, prep)
      }
    }
  }

  const batchResult = await ctx.tools.execute({
    calls: [
      {
        id: callId,
        name,
        arguments: args,
      },
    ],
    agent,
    signal,
  })

  return batchResult.results[0].result
}

/**
 * Execute multiple tool calls in batch mode.
 */
export async function executeBatch(
  ctx: Context,
  agent: Agent,
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolBatchResult> {
  callOrdinal += 1
  return await ctx.tools.execute({
    calls: calls.map((c, idx) => ({
      id: ToolCallId(`lazy-tools-batch-${callOrdinal}-${idx}`),
      name: c.name,
      arguments: c.args ?? {},
    })),
    agent,
    signal,
  })
}
