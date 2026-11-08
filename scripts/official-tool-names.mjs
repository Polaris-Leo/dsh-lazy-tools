#!/usr/bin/env node
/**
 * Print every model-facing tool name the DSH host registers itself, so
 * src/preset.ts:OFFICIAL_TOOL_NAMES can be re-verified after a host upgrade.
 *
 * Reads app.asar directly (an Electron-process read of an inner asar path fails
 * with ENOENT, so run this with a plain Node binary). Usage:
 *   node scripts/official-tool-names.mjs [path/to/app.asar]
 */
import fs from 'node:fs'
import path from 'node:path'

const asar = process.argv[2]
  ?? 'D:/Users/ldc/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const hb = Buffer.alloc(jsonSize)
fs.readSync(fd, hb, 0, jsonSize, 16)
const header = JSON.parse(hb.toString('utf8'))
const dataOffset = 8 + headerSize

const files = new Map()
;(function walk(node, _prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = _prefix + '/' + name
    if (entry.files) walk(entry, full)
    else files.set(full, entry)
  }
})(header, '')

const readEntry = (p) => {
  const entry = files.get(p)
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
  return buf.toString('utf8')
}

const names = new Set()
for (const file of files.keys()) {
  if (!file.includes('/@deepseek-ai/') || !file.endsWith('.js')) continue
  let text
  try { text = readEntry(file) } catch { continue }
  if (!text.includes('defineTool(')) continue
  for (const m of text.matchAll(/defineTool\(\s*\{?[\s\S]{0,400}?name:\s*['"]([a-z][a-z0-9_]{1,40})['"]/g)) names.add(m[1])
}
fs.closeSync(fd)
console.log([...names].sort().join('\n'))
console.error('total', names.size)
