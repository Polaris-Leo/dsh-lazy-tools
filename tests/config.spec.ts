import { describe, it, expect } from 'vitest'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import {
  applyDefaultPreset,
  compilePattern,
  DEFAULT_ACTIVE_TOOLS,
  DEFER_ALL_ENTRY,
  parseEntry,
  resolveDeferConfig,
  type LazyToolsConfig,
} from '../src/config.ts'

const ALL_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'glob',
  'web_search',
  'tool_search',
  'defer_execute_tool',
  RUN_CODE_NAME,
  'agy_tool',
]

/** Core tools plus a few long-tail ones, for the preset assertions. */
const PRESET_CATALOG = [
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'read_image',
  'codex_sketch',
  'todo_write',
  'subagent',
  'web_search',
  'tool_search',
  'defer_execute_tool',
  RUN_CODE_NAME,
]

function resolve(cfg: LazyToolsConfig): { defer: string[]; noDefer: string[] } {
  const r = resolveDeferConfig(ALL_TOOLS, cfg)
  return { defer: [...r.deferNames].sort(), noDefer: [...r.noDeferNames].sort() }
}

describe('parseEntry', () => {
  it('bare name defers in the defer list', () => {
    expect(parseEntry('bash', 'defer')).toEqual({ action: 'defer', pattern: 'bash' })
  })

  it('bare name nodefers in the noDefer list', () => {
    expect(parseEntry('bash', 'noDefer')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('defaults bare names to defer', () => {
    expect(parseEntry('glob')).toEqual({ action: 'defer', pattern: 'glob' })
  })

  it('parses Defer(...) wrapped entry', () => {
    expect(parseEntry('Defer(fetch_*)', 'noDefer')).toEqual({ action: 'defer', pattern: 'fetch_*' })
  })

  it('parses NoDefer(...) wrapped entry', () => {
    expect(parseEntry('NoDefer(bash)', 'defer')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('is case-insensitive for modifiers', () => {
    expect(parseEntry('defer(bash)')).toEqual({ action: 'defer', pattern: 'bash' })
    expect(parseEntry('NoDefer(bash)')).toEqual({ action: 'noDefer', pattern: 'bash' })
  })

  it('rejects nested modifiers', () => {
    expect(parseEntry('Defer(NoDefer(bash))')).toBeNull()
    expect(parseEntry('NoDefer(Defer(bash))')).toBeNull()
  })

  it('rejects empty modifiers', () => {
    expect(parseEntry('Defer()')).toBeNull()
    expect(parseEntry('NoDefer()')).toBeNull()
  })

  it('rejects blank input', () => {
    expect(parseEntry('   ')).toBeNull()
    expect(parseEntry('')).toBeNull()
  })
})

describe('compilePattern', () => {
  it('matches exact names without wildcards', () => {
    const m = compilePattern('bash')
    expect(m('bash')).toBe(true)
    expect(m('bashful')).toBe(false)
  })

  it('matches leading wildcards', () => {
    const m = compilePattern('fetch_*')
    expect(m('fetch_a')).toBe(true)
    expect(m('fetch_')).toBe(true)
    expect(m('fetch_util')).toBe(true)
    expect(m('other')).toBe(false)
  })

  it('matches trailing wildcards', () => {
    const m = compilePattern('*_search')
    expect(m('web_search')).toBe(true)
    expect(m('_search')).toBe(true)
    expect(m('search')).toBe(false)
  })

  it('Defer(*) matches everything', () => {
    const m = compilePattern('*')
    expect(m('anything')).toBe(true)
    expect(m('')).toBe(true)
  })

  it('escapes regex metacharacters in literal segments', () => {
    const m = compilePattern('mcp__github__*')
    expect(m('mcp__github__pr')).toBe(true)
    expect(m('mcp__x')).toBe(false)
  })
})

describe('resolveDeferConfig', () => {
  it('resolves exactly the patterns it is given, with no implicit policy', () => {
    // `resolveDeferConfig` is the compiler, not the policy: the shipped preset
    // is applied by `applyDefaultPreset` before this point, so an empty list
    // here genuinely means "defer nothing".
    const r = resolve({})
    expect(r.defer).toEqual([])
  })

  it('defers a bare tool name', () => {
    const r = resolve({ defer: ['glob'] })
    expect(r.defer).toEqual(['glob'])
  })

  it('noDefer bare name protects against Defer(*)', () => {
    const r = resolve({ defer: ['Defer(*)'], noDefer: ['bash'] })
    // bash must stay active; guards never deferred; everything else deferred.
    expect(r.defer).toEqual(['edit', 'glob', 'read', 'web_search', 'write'])
    expect(r.noDefer).toEqual(['bash'])
  })

  it('NoDefer(...) wrapped name wins over Defer(*)', () => {
    const r = resolve({ defer: ['Defer(*)'], noDefer: ['NoDefer(bash)'] })
    expect(r.defer).toEqual(['edit', 'glob', 'read', 'web_search', 'write'])
    expect(r.noDefer).toEqual(['bash'])
  })

  it('guard tools are never deferred', () => {
    const r = resolve({ defer: ['Defer(*)'] })
    expect(r.defer.includes('tool_search')).toBe(false)
    expect(r.defer.includes('defer_execute_tool')).toBe(false)
    // The reserved PTC transport is the only tool a ptc-mode agent sees, so it
    // must survive Defer(*) too.
    expect(r.defer.includes(RUN_CODE_NAME)).toBe(false)
    expect(r.defer.includes('agy_tool')).toBe(false)
    // Everything else, bash included, is deferred.
    expect(r.defer).toContain('bash')
  })

  it('an empty defer list is how the mechanism is switched off', () => {
    // There is no separate enable/disable flag: `defer: []` already says
    // "defer nothing", so a boolean could only ever contradict the list.
    const r = resolve({ defer: [] })
    expect(r.defer).toEqual([])
    expect(r.noDefer).toEqual([])
  })
})

describe('applyDefaultPreset', () => {
  it('ships a zero-config preset: defer everything, keep the coding core callable', () => {
    const patterns = applyDefaultPreset({})
    expect(patterns.defer).toEqual([DEFER_ALL_ENTRY])
    expect(patterns.noDefer).toEqual([...DEFAULT_ACTIVE_TOOLS])

    // The compiled result must leave exactly the core callable and defer the
    // long tail.
    const compiled = resolveDeferConfig(PRESET_CATALOG, patterns)
    // read_image is a host tool and stays active; only third-party heavy tools defer
    expect([...compiled.deferNames].sort()).toEqual(['codex_sketch'])
    // Tool-slim keep strategy keeps common basic tools (including subagent, todo_write) active
    expect(PRESET_CATALOG.filter((name) => !compiled.deferNames.has(name)).sort()).toEqual([
      'bash',
      'defer_execute_tool',
      'edit',
      'glob',
      'grep',
      'read',
      'read_image',
      'run_code',
      'subagent',
      'todo_write',
      'tool_search',
      'web_search',
      'write',
    ])
  })

  it('retains DEFAULT_ACTIVE_TOOLS as baseline when only Defer(*) is configured', () => {
    const patterns = applyDefaultPreset({ defer: [DEFER_ALL_ENTRY] })
    expect(patterns.defer).toEqual([DEFER_ALL_ENTRY])
    expect(patterns.noDefer).toEqual([...DEFAULT_ACTIVE_TOOLS])

    const compiled = resolveDeferConfig(PRESET_CATALOG, patterns)
    expect([...compiled.deferNames].sort()).toEqual(['codex_sketch'])
    expect(compiled.noDeferNames.has('read')).toBe(true)
    expect(compiled.noDeferNames.has('grep')).toBe(true)
  })

  it('retains DEFAULT_ACTIVE_TOOLS as baseline when defer-only is configured', () => {
    const patterns = applyDefaultPreset({ defer: ['read_image'] })
    expect(patterns.defer).toEqual(['read_image'])
    // An explicitly deferred tool leaves the baseline whitelist.
    expect(patterns.noDefer).toEqual(DEFAULT_ACTIVE_TOOLS.filter((name) => name !== 'read_image'))

    const compiled = resolveDeferConfig(PRESET_CATALOG, patterns)
    expect([...compiled.deferNames]).toEqual(['read_image'])
    expect(compiled.noDeferNames.has('read')).toBe(true)
    expect(compiled.noDeferNames.has('grep')).toBe(true)
  })

  it('lets explicit noDefer override the default active whitelist', () => {
    const patterns = applyDefaultPreset({ defer: [DEFER_ALL_ENTRY], noDefer: ['bash'] })
    expect(patterns.defer).toEqual([DEFER_ALL_ENTRY])
    expect(patterns.noDefer).toEqual(['bash'])
  })

  it('keeps an explicit empty defer meaning "defer nothing"', () => {
    const patterns = applyDefaultPreset({ defer: [] })
    expect(patterns.defer).toEqual([])
    expect(patterns.noDefer).toEqual([...DEFAULT_ACTIVE_TOOLS])
    expect(resolveDeferConfig(PRESET_CATALOG, patterns).deferNames.size).toBe(0)
  })

  it('lets an explicit empty pair clear both lists', () => {
    const patterns = applyDefaultPreset({ defer: [], noDefer: [] })
    expect(patterns.defer).toEqual([])
    expect(patterns.noDefer).toEqual([])
    expect(resolveDeferConfig(PRESET_CATALOG, patterns).deferNames.size).toBe(0)
  })

  it('lets an explicit noDefer stand alone', () => {
    const patterns = applyDefaultPreset({ noDefer: ['bash'] })
    expect(patterns.defer).toEqual([])
    expect(patterns.noDefer).toEqual(['bash'])
  })
})
