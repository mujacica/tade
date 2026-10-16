import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  agentInfoOf,
  configOptionsOf,
  permissionAnswer,
  permissionAskOf,
  stopReasonOf,
  textOf,
  toolCallOf,
  updateOf,
} from '../src/protocol.ts'
import { Peer } from '../src/rpc.ts'

// ACP as Tade reads it, pinned at version 1 (schema-v1.25.0): what each shape
// the schema allows comes to, and that a shape it does not allow is null —
// an agent a version ahead says things this does not read, and skipping them
// is the whole of what it can do.

describe('reading what an ACP agent says', () => {
  it('reads what it can do, and how it signs in', () => {
    expect(
      agentInfoOf({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {} },
        },
        authMethods: [
          {
            id: 'login',
            name: 'Log in',
            type: 'terminal',
            args: ['login', 3],
            env: { A: 'b', N: 1 },
          },
          { id: 'key', name: 'API key', description: 'an env var' },
          { id: 'odd', name: 'Odd', type: 'carrier-pigeon' },
          { name: 'no id' },
        ],
        agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.64.0' },
      }),
    ).toEqual({
      protocolVersion: 1,
      loadSession: true,
      resumeSession: true,
      images: true,
      mcpHttp: true,
      authMethods: [
        { type: 'terminal', id: 'login', name: 'Log in', args: ['login'], env: { A: 'b' } },
        { type: 'agent', id: 'key', name: 'API key', description: 'an env var' },
      ],
      name: 'Gemini CLI',
      version: '0.64.0',
    })
    // The least an agent may say: a version, and every capability off.
    expect(agentInfoOf({ protocolVersion: 1 })).toMatchObject({
      loadSession: false,
      resumeSession: false,
      authMethods: [],
      name: null,
    })
    expect(agentInfoOf({})).toBeNull()
    expect(agentInfoOf('hello')).toBeNull()
  })

  it('reads the choices a session offers, grouped or not, and only the ones Tade can set', () => {
    expect(
      configOptionsOf([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'flash',
          options: [
            { group: 'fast', name: 'Fast', options: [{ value: 'flash', name: 'Flash' }] },
            { value: 'pro' },
          ],
        },
        { id: 'yolo', name: 'Yolo', type: 'boolean', currentValue: false },
        { id: 'broken', type: 'select' },
      ]),
    ).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        current: 'flash',
        values: [
          { value: 'flash', name: 'Flash' },
          { value: 'pro', name: 'pro' },
        ],
      },
    ])
    expect(configOptionsOf(null)).toBeNull()
  })

  it('reads every update Tade acts on, and nothing it does not know', () => {
    const read = (update: Record<string, unknown>) =>
      updateOf({ sessionId: 's', update })?.update ?? null
    expect(
      read({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
    ).toEqual({
      kind: 'you',
      text: 'hi',
    })
    expect(
      read({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }),
    ).toEqual({
      kind: 'thought',
      text: 'hm',
    })
    expect(
      read({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: '', mimeType: 'x' },
      }),
    ).toBeNull()
    expect(
      read({
        sessionUpdate: 'plan',
        entries: [{ content: 'one', status: 'completed' }, { content: 'two' }, {}],
      }),
    ).toEqual({
      kind: 'plan',
      entries: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'pending' },
      ],
    })
    expect(read({ sessionUpdate: 'session_info_update', title: 'Fix login' })).toEqual({
      kind: 'titled',
      title: 'Fix login',
    })
    expect(read({ sessionUpdate: 'session_info_update', updatedAt: 'now' })).toBeNull()
    expect(read({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 1 } })).toEqual({
      kind: 'usage',
      used: 1,
      size: 2,
      cost: null,
    })
    expect(read({ sessionUpdate: 'usage_update', used: 1 })).toBeNull()
    expect(read({ sessionUpdate: 'notice', severity: 'warning', title: 'rate limited' })).toEqual({
      kind: 'notice',
      severity: 'warning',
      title: 'rate limited',
    })
    expect(read({ sessionUpdate: 'notice', title: '' })).toBeNull()
    expect(read({ sessionUpdate: 'config_option_update', configOptions: [] })).toEqual({
      kind: 'config',
      options: [],
    })
    expect(
      read({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'failed', error: 'x' }),
    ).toEqual({
      kind: 'compaction',
      status: 'failed',
      error: 'x',
    })
    expect(read({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeNull()
    expect(read({ sessionUpdate: 'tool_call' })).toBeNull()
    expect(updateOf({ update: {} })).toBeNull()
    expect(updateOf(null)).toBeNull()
  })

  it('reads a tool call: its kind, its files and what it answered', () => {
    expect(
      toolCallOf({
        toolCallId: 't',
        title: 'Edit a.ts',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'a.ts', line: 3 }, {}],
        content: [
          { type: 'diff', path: 'b.ts', newText: '' },
          { type: 'content', content: { type: 'resource_link', uri: 'file:///c.ts', name: 'c' } },
          { type: 'terminal', terminalId: 'x' },
        ],
      }),
    ).toEqual({
      id: 't',
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'completed',
      paths: ['a.ts', 'b.ts'],
      rawInput: undefined,
      output: 'edited b.ts\nfile:///c.ts',
    })
    expect(
      toolCallOf({ toolCallId: 't', kind: 'teleport', status: 'maybe', rawOutput: 'raw' }),
    ).toMatchObject({
      kind: null,
      status: null,
      output: 'raw',
    })
    expect(textOf({ type: 'audio' })).toBeNull()
  })

  it('reads why a turn ended, and nothing it does not know', () => {
    for (const reason of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) {
      expect(stopReasonOf({ stopReason: reason })).toBe(reason)
    }
    expect(stopReasonOf({ stopReason: 'bored' })).toBeNull()
    expect(stopReasonOf(null)).toBeNull()
  })

  it('answers a permission request for once, for always only where that is all there is', () => {
    const ask = permissionAskOf({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'Run ls', kind: 'execute' },
      options: [
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'once', name: 'Once', kind: 'allow_once' },
        { optionId: 'nope', name: 'Never', kind: 'reject_always' },
        { name: 'no id' },
      ],
    })
    expect(ask?.options.map((one) => one.optionId)).toEqual(['always', 'once', 'nope'])
    const options = ask?.options ?? []
    expect(permissionAnswer(options, true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    })
    expect(permissionAnswer(options, false)).toEqual({
      outcome: { outcome: 'selected', optionId: 'nope' },
    })
    expect(permissionAnswer(options.slice(0, 1), true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    })
    expect(permissionAnswer([], true)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(permissionAskOf({ sessionId: 's' })).toBeNull()
  })
})

describe('JSON-RPC, one message a line', () => {
  it('asks and is answered, is asked and answers, and skips a line that is not a message', async () => {
    const toAgent = new PassThrough()
    const fromAgent = new PassThrough()
    const warned: string[] = []
    const told: string[] = []
    const peer = new Peer({
      input: fromAgent,
      output: toAgent,
      onRequest: async (method) => {
        if (method === 'boom') throw new Error('no such thing')
        return { echoed: method }
      },
      onNotification: (method) => told.push(method),
      onWarning: (message) => warned.push(message),
    })
    const written: unknown[] = []
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        written.push(JSON.parse(line))
    })
    const answer = peer.request('initialize', { protocolVersion: 1 })
    const failing = peer.request('session/new', {})
    fromAgent.write('banner from the agent\n')
    fromAgent.write(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n',
    )
    fromAgent.write('{"jsonrpc":"2.0","method":"session/update","params":{}}\n')
    fromAgent.write(
      '{"jsonrpc":"2.0","id":7,"method":"ask","params":{}}\n{"jsonrpc":"2.0","id":8,"method":"boom"}\n',
    )
    await expect(answer).resolves.toEqual({ ok: true })
    await expect(failing).rejects.toMatchObject({
      code: -32000,
      message: 'Authentication required',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(told).toEqual(['session/update'])
    expect(warned[0]).toContain('banner from the agent')
    expect(written).toContainEqual({ jsonrpc: '2.0', id: 7, result: { echoed: 'ask' } })
    expect(written).toContainEqual({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32603, message: 'no such thing' },
    })
    // The agent going away answers everything still waiting, with why.
    const waiting = peer.request('session/prompt', {})
    fromAgent.end()
    await expect(waiting).rejects.toThrow('the agent closed its output')
    await expect(peer.request('again', {})).rejects.toThrow(/the agent is gone/)
  })
})
