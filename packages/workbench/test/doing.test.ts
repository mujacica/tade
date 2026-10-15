import { describe, expect, it } from 'vitest'
import { Doings } from '../src/doing.ts'

const call = (callId: string, writes?: string[]) => ({
  type: 'tool_call' as const,
  run: 'app/a/agent',
  at: 10,
  callId,
  tool: 'Edit',
  input: {},
  ...(writes ? { writes } : {}),
})
const result = (callId: string, ok: boolean, at = 20) => ({
  type: 'tool_result' as const,
  run: 'app/a/agent',
  at,
  callId,
  ok,
  summary: '',
})

describe('what an agent wrote', () => {
  it('is a file its harness said a call wrote, once the call worked, by task', () => {
    const doings = new Doings()
    doings.called('app/a/agent', 'app/a', call('1', ['src/x.ts']), 'src/x.ts')
    doings.called('app/a/agent', 'app/a', call('2', ['src/y.ts']), 'src/y.ts')
    doings.called('app/a/agent', 'app/a', call('3'), 'ls')
    expect(doings.wroteBy()).toEqual(new Map())
    doings.answered('app/a/agent', result('1', true))
    doings.answered('app/a/agent', result('2', false))
    doings.answered('app/a/agent', result('3', true))
    expect(doings.wroteBy()).toEqual(new Map([['app/a', [{ path: 'src/x.ts', at: 20 }]]]))
    expect(doings.of('app/a/agent').did.map((did) => did.ok)).toEqual([true, false, true])
  })

  it('keeps the newest time a file was written, and outlives the run', () => {
    const doings = new Doings()
    doings.called('app/a/agent', 'app/a', call('1', ['src/x.ts']), '')
    doings.answered('app/a/agent', result('1', true, 20))
    doings.called('app/a/agent', 'app/a', call('2', ['src/x.ts']), '')
    doings.answered('app/a/agent', result('2', true, 30))
    doings.forget('app/a/agent')
    expect(doings.has('app/a/agent')).toBe(false)
    expect(doings.wroteBy()).toEqual(new Map([['app/a', [{ path: 'src/x.ts', at: 30 }]]]))
  })
})
