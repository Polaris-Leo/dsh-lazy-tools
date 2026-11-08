/**
 * PTC tools:sdk filter helper for @studyzy/dsh-lazy-tools.
 *
 * In DeepSeek Harness Programmatic Tool Calling (PTC) mode, the model does not
 * receive native function-calling tool schemas. Instead, `dsh-tools` compiles
 * visible tool schemas into TypeScript SDK declarations in a section named `tools:sdk`.
 *
 * This helper filters out any tool declarations whose names are in `deferredNames`,
 * ensuring deferred tools do not bloat prompt tokens or expose unactivated tools
 * to the model, while keeping non-deferred and activated tools fully available.
 */

function filterSdkBlock(blockText: string, deferredNames: ReadonlySet<string>): string {
  const openBrace = blockText.indexOf('{')
  const closeBrace = blockText.lastIndexOf('}')
  if (openBrace < 0 || closeBrace < 0) return blockText
  const header = blockText.slice(0, openBrace + 1)
  const footer = blockText.slice(closeBrace)
  const body = blockText.slice(openBrace + 1, closeBrace)

  const members: { key: string; text: string }[] = []
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (i >= body.length) break

    const startMember = i
    while (i < body.length) {
      if (body.slice(i, i + 2) === '/*') {
        const endComment = body.indexOf('*/', i)
        if (endComment > 0) {
          i = endComment + 2
          while (i < body.length && /\s/.test(body[i])) i++
          continue
        }
      } else if (body.slice(i, i + 2) === '//') {
        const endLine = body.indexOf('\n', i)
        if (endLine > 0) {
          i = endLine + 1
          while (i < body.length && /\s/.test(body[i])) i++
          continue
        }
      }
      break
    }
    if (i >= body.length) break

    let key = ''
    if (body[i] === '\'' || body[i] === '"') {
      const quote = body[i++]
      const keyStart = i
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') i++
        i++
      }
      key = body.slice(keyStart, i)
      i++
    } else {
      const keyStart = i
      while (i < body.length && /[^:\s]/.test(body[i])) i++
      key = body.slice(keyStart, i)
    }

    let depthBrace = 0
    let depthParen = 0
    let depthBracket = 0
    let inString: string | null = null
    while (i < body.length) {
      const ch = body[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === inString) inString = null
      } else if (ch === '\'' || ch === '"' || ch === '`') {
        inString = ch
      } else if (ch === '{') depthBrace++
      else if (ch === '}') depthBrace--
      else if (ch === '(') depthParen++
      else if (ch === ')') depthParen--
      else if (ch === '[') depthBracket++
      else if (ch === ']') depthBracket--
      else if (ch === ';' && depthBrace <= 0 && depthParen <= 0 && depthBracket <= 0) {
        i++
        break
      }
      i++
    }
    const memberText = body.slice(startMember, i)
    if (key) {
      members.push({ key, text: memberText })
    }
  }

  const filtered = members.filter((m) => !deferredNames.has(m.key)).map((m) => m.text).join('\n  ')
  return header + (filtered ? '\n  ' + filtered + '\n' : '\n') + footer
}

/**
 * Filter `interface ToolArgsMap` and `interface ToolOutputMap` inside `tools:sdk` text.
 * @param text - the full rendered `tools:sdk` section content.
 * @param deferredNames - set of tool names currently deferred.
 * @returns the patched section text with deferred tools excluded.
 */
export function filterToolsSdkText(text: string, deferredNames: ReadonlySet<string>): string {
  if (typeof text !== 'string' || deferredNames.size === 0) return text
  let result = text

  // Filter ToolArgsMap
  const argsIdx = result.indexOf('interface ToolArgsMap {')
  if (argsIdx >= 0) {
    let depth = 0
    let endIdx = -1
    for (let i = argsIdx; i < result.length; i++) {
      if (result[i] === '{') depth++
      else if (result[i] === '}') {
        depth--
        if (depth === 0) {
          endIdx = i + 1
          break
        }
      }
    }
    if (endIdx > argsIdx) {
      const block = result.slice(argsIdx, endIdx)
      const filteredBlock = filterSdkBlock(block, deferredNames)
      result = result.slice(0, argsIdx) + filteredBlock + result.slice(endIdx)
    }
  }

  // Filter ToolOutputMap (if not folded to type alias by dsh-ptc-sdk-slim)
  const outIdx = result.indexOf('interface ToolOutputMap {')
  if (outIdx >= 0) {
    let depth = 0
    let endIdx = -1
    for (let i = outIdx; i < result.length; i++) {
      if (result[i] === '{') depth++
      else if (result[i] === '}') {
        depth--
        if (depth === 0) {
          endIdx = i + 1
          break
        }
      }
    }
    if (endIdx > outIdx) {
      const block = result.slice(outIdx, endIdx)
      const filteredBlock = filterSdkBlock(block, deferredNames)
      result = result.slice(0, outIdx) + filteredBlock + result.slice(endIdx)
    }
  }

  return result
}
