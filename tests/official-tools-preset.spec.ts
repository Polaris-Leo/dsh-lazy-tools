import { describe, expect, it } from 'vitest'
import { compilePattern } from '../src/config.ts'
import { DEFAULT_ACTIVE_TOOLS, OFFICIAL_TOOL_NAMES, resolveDeferPatterns } from '../src/preset.ts'

/**
 * The shipped preset must never hide a host tool. Deferring one costs a
 * tool_search round trip and reads to the user as "the official plugin stopped
 * working", so this suite pins the whitelist against the scanned inventory.
 */
describe('shipped preset keeps the official host surface active', () => {
  it('lists every scanned official tool in the active set', () => {
    const active = new Set<string>(DEFAULT_ACTIVE_TOOLS as readonly string[])
    const missing = (OFFICIAL_TOOL_NAMES as readonly string[]).filter((name) => !active.has(name))
    expect(missing).toEqual([])
  })

  it('keeps the transports and gates the live profile depends on', () => {
    const { noDefer } = resolveDeferPatterns({})
    const matchers = (noDefer as readonly string[]).map((pattern) => compilePattern(pattern))
    const active = (name: string) => matchers.some((match) => match(name))
    for (const name of [
      'compress',
      'agy_tool',
      'agy_ask',
      'tool_search',
      'defer_execute_tool',
      'run_code',
      'spawn_teammate',
      'team_task_list',
      'memory_log',
      'grill_start',
      'undo_restore',
    ]) expect(active(name), name).toBe(true)
  })

  it('never puts an official tool on the deferred side of the default pair', () => {
    const { noDefer } = resolveDeferPatterns({})
    const active = new Set<string>(noDefer as readonly string[])
    const missing = (OFFICIAL_TOOL_NAMES as readonly string[]).filter((name) => !active.has(name))
    expect(missing).toEqual([])
  })

  it('still leaves third-party long tail tools deferrable', () => {
    const active = DEFAULT_ACTIVE_TOOLS as readonly string[]
    for (const name of ['canvas_get_state', 'match_skills', 'appwrite_call_tool']) {
      expect(active).not.toContain(name)
    }
  })
})
