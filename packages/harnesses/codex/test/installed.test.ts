import { describe, expect, it } from 'vitest'
import { serversIn } from '../src/installed.ts'

// Codex's own config is the user's file: Tade reads which servers are in it
// so the window can say they are there, and never writes it.

describe('the MCP servers Codex loads by itself', () => {
  it('names each table under `mcp_servers`, once, in the order they appear', () => {
    expect(
      serversIn(
        [
          'model = "gpt-5"',
          '[mcp_servers.linear]',
          'command = "linear-mcp"',
          '[mcp_servers.linear.env]',
          'TOKEN = "x"',
          '[[mcp_servers.figma]]',
          '[projects."/src/shop"]',
          'trust_level = "trusted"',
        ].join('\n'),
      ),
    ).toEqual(['linear', 'figma'])
  })

  it('is none for a file with none, and never guesses at a shape it does not know', () => {
    expect(serversIn('')).toEqual([])
    expect(serversIn('[projects."/src/shop"]\ntrust_level = "trusted"\n')).toEqual([])
    expect(serversIn('mcp_servers = { linear = { command = "x" } }')).toEqual([])
  })
})
