import { describe, expect, it } from 'vitest'
import * as wire from '../src/protocol.ts'

// What every transport that talks to a real server says, and what it makes of
// what comes back. Pure, so it is a table: the shapes a server can answer
// with are exactly the place where "anything unfamiliar is left out, never
// thrown over" either holds or does not.

describe('what Tade says', () => {
  it('asks for a conversation, declaring nothing it does not want to be asked for', () => {
    const hello = wire.initialize(1)
    expect(hello.method).toBe('initialize')
    expect(hello.params?.protocolVersion).toBe(wire.PROTOCOL_VERSION)
    // No sampling, no elicitation, no roots: refused by not being offered,
    // which is the only refusal that cannot be argued with.
    expect(hello.params?.capabilities).toEqual({})
    expect(wire.CLIENT_CAPABILITIES).toEqual({})
  })

  it('asks a call to say how it is going, under the id of the call itself', () => {
    const call = wire.callTool(7, 'search', { q: 'a' })
    expect(call.params?.name).toBe('search')
    expect(call.params?.arguments).toEqual({ q: 'a' })
    const meta = call.params?._meta as { progressToken?: number } | undefined
    expect(meta?.progressToken).toBe(7)
  })

  it('says which call was given up on, so nothing is left waiting out there', () => {
    const stop = wire.cancelled(7, 'Tade gave up on it')
    expect(stop.method).toBe('notifications/cancelled')
    expect(stop.params?.requestId).toBe(7)
    expect(stop.id).toBeUndefined()
  })
})

describe('what a server says back', () => {
  const cases: [string, string, boolean][] = [
    ['an answer', '{"jsonrpc":"2.0","id":1,"result":{}}', true],
    ['a refusal', '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no"}}', true],
    ['a notification', '{"jsonrpc":"2.0","method":"notifications/progress"}', true],
    ['a banner', 'listening on stdio', false],
    ['half a line', '{"jsonrpc":"2.0","id"', false],
    ['a list', '[1,2,3]', false],
    ['nothing at all', '', false],
    ['an id with no answer', '{"jsonrpc":"2.0","id":4}', false],
    ['null', 'null', false],
  ]
  for (const [what, line, read] of cases) {
    it(`reads ${what} as ${read ? 'a message' : 'nothing'}`, () => {
      expect(wire.parse(line) !== null).toBe(read)
    })
  }

  it('takes an error apart without believing anything in it', () => {
    const message = wire.parse('{"id":1,"error":{"code":"nope"}}')
    expect(message?.error?.message).toBe('it would not say why')
    expect(message?.error?.code).toBeUndefined()
  })

  it('says what the server called itself, and never invents a name for it', () => {
    expect(wire.about({ serverInfo: { name: 'Linear', version: '2.0' } })).toEqual({
      title: 'Linear',
      version: '2.0',
    })
    expect(wire.about({}).title).toBe('a server')
    expect(wire.about(undefined).version).toBe('')
  })
})

describe('what it offers', () => {
  const list = {
    tools: [
      { name: 'good', description: 'a tool', inputSchema: { type: 'object' } },
      { name: 'titled', title: 'said in its title', inputSchema: { type: 'object' } },
      { description: 'no name at all', inputSchema: { type: 'object' } },
      { name: 'stringy', description: 'parameters that are not', inputSchema: 'nope' },
      { name: 'listy', description: 'parameters that are a list', inputSchema: [] },
      'not a tool at all',
      null,
    ],
  }

  it('keeps what a harness could register and leaves out what none could', () => {
    expect(wire.tools(list).map((tool) => tool.name)).toEqual(['good', 'titled'])
  })

  it('takes a title for a description rather than offering a tool with no words', () => {
    expect(wire.tools(list)[1]?.description).toBe('said in its title')
  })

  it('is an empty list for an answer that says nothing about tools', () => {
    expect(wire.tools({})).toEqual([])
    expect(wire.tools({ tools: 'lots' })).toEqual([])
    expect(wire.tools(undefined)).toEqual([])
  })

  it('says where the rest of a long list is, and nothing when there is no rest', () => {
    expect(wire.more({ nextCursor: 'page-2' })).toBe('page-2')
    expect(wire.more({ nextCursor: '' })).toBeNull()
    expect(wire.more({})).toBeNull()
  })
})

describe('what a call came to', () => {
  it('reads text out of what it answered with', () => {
    expect(
      wire.outcome({
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toEqual({ text: 'one\ntwo', failed: false })
  })

  it('is an answer when the server calls it a failure, not a throw', () => {
    const said = wire.outcome({
      content: [{ type: 'text', text: 'it did not work' }],
      isError: true,
    })
    expect(said.failed).toBe(true)
    expect(said.text).toBe('it did not work')
  })

  it('says what came back that was not text, rather than looking like success', () => {
    expect(wire.outcome({ content: [{ type: 'image', data: '…' }] }).text).toBe('[image]')
  })

  it('falls back to what it answered structurally, rather than to nothing', () => {
    expect(wire.outcome({ structuredContent: { rows: 2 } }).text).toBe('{"rows":2}')
  })

  it('is empty and not a throw for an answer with nothing in it', () => {
    expect(wire.outcome({})).toEqual({ text: '', failed: false })
    expect(wire.outcome(undefined)).toEqual({ text: '', failed: false })
  })
})

describe('how a call says it is going', () => {
  it('prefers the words the server wrote to the number it counted', () => {
    expect(wire.progress({ progressToken: 1, message: 'reading rows', progress: 2 })).toBe(
      'reading rows',
    )
    expect(wire.progress({ progressToken: 1, progress: 2, total: 5 })).toBe('2 of 5')
    expect(wire.progress({ progressToken: 1, progress: 2 })).toBe('2')
    expect(wire.progress({ progressToken: 1 })).toBeNull()
  })

  it('only ever belongs to a call Tade made', () => {
    expect(wire.progressFor({ progressToken: 7 })).toBe(7)
    // A token Tade never handed out belongs to nothing here.
    expect(wire.progressFor({ progressToken: 'theirs' })).toBeNull()
    expect(wire.progressFor(undefined)).toBeNull()
  })
})
