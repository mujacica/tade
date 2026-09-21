import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installedServers } from '../src/installed.ts'

// What Claude Code loads by itself, read and never adopted: the window lists
// these so nobody takes an agent's own tools for Tade's, and that is all.

function home(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tade-claude-own-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

describe('the MCP servers Claude Code loads by itself', () => {
  it('lists what a person added and what a project ships, each where it is', () => {
    const dir = home({
      '.claude.json': JSON.stringify({ mcpServers: { linear: {}, figma: {} }, other: 1 }),
      'src/.mcp.json': JSON.stringify({ mcpServers: { house: {} } }),
    })
    expect(installedServers(dir, join(dir, 'src'))).toEqual([
      { name: 'linear', where: '~/.claude.json (Claude Code)' },
      { name: 'figma', where: '~/.claude.json (Claude Code)' },
      { name: 'house', where: `${join(dir, 'src')}/.mcp.json (Claude Code)` },
    ])
  })

  it('is none where there is no file, and none where the file is not what it expected', () => {
    expect(installedServers(home({}))).toEqual([])
    expect(installedServers(home({ '.claude.json': 'not json at all' }))).toEqual([])
    expect(installedServers(home({ '.claude.json': '{"mcpServers": ["linear"]}' }))).toEqual([])
  })
})
