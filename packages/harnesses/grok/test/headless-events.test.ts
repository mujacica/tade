import { describe, expect, it } from 'vitest'
import { headlessArgs, headlessEnv, headlessEvent } from '../src/headless.ts'

// What `grok -p --output-format streaming-json` prints, read without Grok:
// each line as Grok 1.0.92 printed it, against a scripted model.

describe('a headless turn’s stream', () => {
  it('reads its words, the tool it called and what came back', () => {
    expect(headlessEvent('{"type":"text","data":"Finished here."}')).toEqual({
      kind: 'text',
      text: 'Finished here.',
    })
    expect(
      headlessEvent(
        '{"type":"tool_call","toolCallId":"call_5","title":"run_terminal_command","kind":"execute","status":"pending","toolName":"run_terminal_command","rawInput":{"command":"echo hi","description":"try"},"content":[],"locations":[]}',
      ),
    ).toEqual({
      kind: 'call',
      callId: 'call_5',
      tool: 'run_terminal_command',
      input: { command: 'echo hi', description: 'try' },
    })
    expect(
      headlessEvent(
        '{"type":"tool_call_update","toolCallId":"call_5","status":"failed","content":[{"type":"content","content":{"type":"text","text":"Hook denied: refused in Tade"}}],"rawOutput":null,"locations":[]}',
      ),
    ).toEqual({
      kind: 'result',
      callId: 'call_5',
      ok: false,
      summary: 'Hook denied: refused in Tade',
    })
  })

  it('reads how full the prompt of each call was, and what the turn used at its end', () => {
    expect(
      headlessEvent(
        '{"type":"usage","usage":{"input_tokens":800,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":0,"reasoning_tokens":0}}',
      ),
    ).toEqual({ kind: 'used', prompt: 1000 })
    expect(
      headlessEvent(
        '{"type":"end","stopReason":"end_turn","sessionId":"s","usage":{"input_tokens":1600,"cache_read_input_tokens":400,"cache_creation_input_tokens":0,"output_tokens":100,"reasoning_tokens":0,"total_tokens":2100},"num_turns":1,"modelUsage":{"fake-model":{"inputTokens":1600,"outputTokens":100,"modelCalls":2}}}',
      ),
    ).toEqual({
      kind: 'end',
      stop: 'end_turn',
      usage: { input: 1600, output: 100, cacheRead: 400, cacheWrite: 0 },
      usd: 0,
      model: 'fake-model',
    })
  })

  it('reads what went wrong, and nothing out of a line it does not know', () => {
    expect(headlessEvent('{"type":"error","message":"Couldn\'t set model"}')).toEqual({
      kind: 'error',
      message: "Couldn't set model",
    })
    expect(headlessEvent('{"type":"available_commands","tools":[]}')).toBeNull()
    expect(headlessEvent('Error: plain words')).toBeNull()
  })
})

describe('a headless turn’s line', () => {
  it('starts the session the first time, comes back to it after, and is never gated', () => {
    const args = headlessArgs({
      prompt: 'hi',
      session: 'id-1',
      going: false,
      model: 'grok-4.6',
      effort: null,
      rules: 'You are Tade.',
      extra: [],
    })
    expect(args.slice(0, 4)).toEqual(['-p', 'hi', '-s', 'id-1'])
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    expect(args.slice(-4)).toEqual(['-m', 'grok-4.6', '--rules', 'You are Tade.'])
    expect(
      headlessArgs({
        prompt: 'x',
        session: 'id-1',
        going: true,
        model: null,
        effort: null,
        rules: null,
        extra: [],
      }).slice(2, 4),
    ).toEqual(['-r', 'id-1'])
  })

  it('stands the account folder’s hooks down, and names the tool server it was handed', () => {
    const env = headlessEnv(
      { PATH: '/bin', TADE_RUN_SOCKET: '/tmp/parent.sock', TADE_APPROVALS: 'policy' },
      { run: 'o/agent', task: 'o', cwd: '/w', prompt: '' },
      '/runs/tade-tools.mcp.json',
    )
    expect(env.TADE_RUN_SOCKET).toBeUndefined()
    expect(env.TADE_APPROVALS).toBeUndefined()
    expect(env.TADE_GROK_MCP).toBe('/runs/tade-tools.mcp.json')
    expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe('false')
  })
})
