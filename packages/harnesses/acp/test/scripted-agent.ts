import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// A scripted ACP agent: speaks the Agent Client Protocol on its standard input
// and output the way a real one does, with no model behind it. What it does
// with a prompt is chosen by the prompt's words, so a test says what should
// happen in the instruction it sends:
//
//   "say <words>"     answers <words>, in two chunks
//   "run <command>"   asks permission to run <command>, runs it (or not) and says how it went
//   "edit <path>"     edits <path> without asking
//   "slow"            takes a few seconds, so it can be stopped
//   "refuse"          ends the turn refusing
//   "cost <dollars>"  says the session has cost that much
//   "die"             exits in the middle of the turn
//
// Every message it receives is appended to $ACP_SCRIPT_LOG, one JSON line
// each, so a test can read what Tade sent. $ACP_SCRIPT_CAPS picks what it can
// do: `load`, `resume`, `models`, `auth` (comma-separated).

const LOG = process.env.ACP_SCRIPT_LOG
const CAPS = new Set((process.env.ACP_SCRIPT_CAPS ?? '').split(',').filter(Boolean))

let next = 1000
let signedIn = !CAPS.has('auth')
const sessions = new Set<string>()
const waiting = new Map<number, (result: unknown) => void>()
let cancelled = false
let model = 'small'

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const update = (sessionId: string, body: Record<string, unknown>) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } })
const ask = (method: string, params: unknown) =>
  new Promise<unknown>((resolve) => {
    const id = next++
    waiting.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function options() {
  if (!CAPS.has('models')) return undefined
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'small', name: 'Small' },
        { value: 'large', name: 'Large' },
      ],
    },
  ]
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (LOG) appendFileSync(LOG, `${line}\n`)
  const message = JSON.parse(line) as {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: unknown
  }
  if (message.method === undefined && message.id !== undefined) {
    waiting.get(message.id)?.(message.result)
    waiting.delete(message.id)
    return
  }
  void handle(message.id, message.method ?? '', message.params ?? {})
})

async function handle(id: number | undefined, method: string, params: Record<string, unknown>) {
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message: text } })
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: CAPS.has('load'),
          promptCapabilities: { image: false },
          sessionCapabilities: CAPS.has('resume') ? { resume: {} } : {},
        },
        authMethods: CAPS.has('auth') ? [{ id: 'browser', name: 'Sign in with a browser' }] : [],
        agentInfo: { name: 'scripted', version: '0.0.1' },
      })
    case 'authenticate':
      signedIn = true
      return reply({})
    case 'session/new': {
      if (!signedIn) return fail(-32000, 'Authentication required')
      const sessionId = `sess-${sessions.size + 1}`
      sessions.add(sessionId)
      return reply({ sessionId, configOptions: options() })
    }
    case 'session/resume':
    case 'session/load': {
      const sessionId = String(params.sessionId)
      sessions.add(sessionId)
      if (method === 'session/load') {
        // Load replays the conversation, which a client must not take for news.
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed' },
        })
      }
      return reply({ configOptions: options() })
    }
    case 'session/set_config_option':
      model = String(params.value)
      return reply({ configOptions: options() })
    case 'session/cancel':
      cancelled = true
      return
    case 'session/prompt':
      return reply(await prompt(String(params.sessionId), params.prompt as { text?: string }[]))
    default:
      if (id !== undefined) fail(-32601, `no ${method}`)
  }
}

async function prompt(sessionId: string, blocks: { text?: string }[]) {
  cancelled = false
  const text = blocks.at(-1)?.text ?? ''
  const [verb, ...rest] = text.split(' ')
  const arg = rest.join(' ')
  const say = (words: string) =>
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: words },
    })
  switch (verb) {
    case 'say': {
      const half = Math.ceil(arg.length / 2)
      say(arg.slice(0, half))
      say(arg.slice(half))
      update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 10000 })
      return { stopReason: 'end_turn' }
    }
    case 'run': {
      const call = {
        toolCallId: 'call-1',
        title: `Run ${arg}`,
        kind: 'execute',
        rawInput: { command: arg },
      }
      update(sessionId, { sessionUpdate: 'tool_call', status: 'pending', ...call })
      const answer = (await ask('session/request_permission', {
        sessionId,
        toolCall: call,
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })) as { outcome: { outcome: string; optionId?: string } }
      const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes'
      if (answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: allowed ? 'completed' : 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: allowed ? 'ran it' : 'not allowed' } },
        ],
      })
      say(allowed ? 'done' : 'it was refused')
      return { stopReason: 'end_turn' }
    }
    case 'edit':
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-2',
        title: `Edit ${arg}`,
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: arg }],
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        status: 'completed',
        content: [{ type: 'diff', path: arg, newText: 'x' }],
      })
      say('edited')
      return { stopReason: 'end_turn' }
    case 'slow':
      for (let i = 0; i < 100 && !cancelled; i++) await sleep(50)
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
    case 'refuse':
      return { stopReason: 'refusal' }
    case 'cost':
      update(sessionId, {
        sessionUpdate: 'usage_update',
        used: 500,
        size: 1000,
        cost: { amount: Number(arg), currency: 'USD' },
      })
      say(`on ${model}`)
      return { stopReason: 'end_turn' }
    case 'die':
      process.exit(3)
      break
    default:
      say(`heard: ${text}`)
      return { stopReason: 'end_turn' }
  }
  return { stopReason: 'end_turn' }
}
