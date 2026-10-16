import { spawn } from 'node:child_process'
import { emitKeypressEvents } from 'node:readline'
import { WORKER_ENV, type WorkerCommand } from '@tade/harnesses-core'
import { AcpClient, type Drawn, type Said } from './client.ts'
import { animating, drawn, emptyScreen, frame, paintFor, type Screen, signalled } from './draw.ts'
import { chooseAgent, readLaunch } from './launch.ts'
import { Link } from './link.ts'
import { recordedInSync } from './record.ts'

// What runs in an ACP agent's lane: Tade's own program, standing where the
// agent's terminal would be, since an ACP agent has none.
//
//   node lane.ts <launch.json> [opening instruction]
//
// It starts the agent as its own child and speaks ACP to it (`client.ts`),
// reports to Tade over the run's supervision socket (`link.ts`) when Tade is
// there and carries on when it is not, and draws the conversation in this
// terminal (`draw.ts`) with a line to type on — Enter sends, Escape stops the
// turn, ctrl+c throws away what was typed. The lane outlives the window
// exactly as far as its driver lets it, and the agent with it, because the
// agent is this process's child and dies with it.

const [launchPath, opening = ''] = process.argv.slice(2)
if (!launchPath) {
  process.stderr.write('usage: lane.ts <launch.json> [opening instruction]\n')
  process.exit(2)
}

const RUN = process.env[WORKER_ENV.run] ?? ''
const SOCKET = process.env[WORKER_ENV.socket]
/** Decided at launch and never when Tade goes: see `TADE_APPROVALS`. */
const GATED = process.env[WORKER_ENV.approvals] === 'policy'

const out = process.stdout
const tty = out.isTTY === true
const paint = paintFor(tty && !process.env.NO_COLOR)
let screen: Screen = emptyScreen()
/** How many lines at the bottom are drawn again in place. */
let liveRows = 0

function draw(): void {
  const width = Math.max(20, (out.columns || 80) - 1)
  const rows = tty ? out.rows || 24 : Number.MAX_SAFE_INTEGER
  const now = Date.now()
  const next = frame(screen, width, rows, paint, now)
  if (!tty) {
    // Not a terminal: what is finished, as lines, and nothing drawn again.
    for (const line of next.print) out.write(`${line}\n`)
    screen = { ...screen, printed: next.printed }
    return
  }
  let text = ''
  if (liveRows > 1) text += `\x1b[${liveRows - 1}A`
  text += '\r\x1b[J'
  for (const line of next.print) text += `${line}\r\n`
  text += next.live.join('\r\n')
  out.write(text)
  liveRows = next.live.length
  screen = { ...screen, printed: next.printed }
}

let drawing: NodeJS.Timeout | null = null
function redraw(): void {
  draw()
  if (animating(screen) && !drawing) {
    drawing = setInterval(() => {
      draw()
      if (!animating(screen) && drawing) {
        clearInterval(drawing)
        drawing = null
      }
    }, 100)
  }
}

const show = (event: Drawn) => {
  screen = drawn(screen, event)
  redraw()
}

let launch: ReturnType<typeof readLaunch>
try {
  launch = readLaunch(launchPath)
} catch (err) {
  process.stderr.write(`Tade could not start this agent: ${(err as Error).message}\n`)
  process.exit(1)
}
const { recorded, lines: history } = recordedInSync(launch.record)
const chosen = chooseAgent(launch, recorded.agent)

// What was said before, from the record, so a lane opened again is not blank.
for (const line of history.slice(-200)) {
  if (line.type === 'sent') screen = drawn(screen, { kind: 'you', text: line.text })
  else if (line.type === 'reply')
    screen = signalled(screen, { type: 'message', text: line.text }, 0)
}

/** Decisions waiting on Tade, by request id. */
const deciding = new Map<string, (decision: { allow: boolean; reason: string }) => void>()

let client: AcpClient | null = null

const link = SOCKET
  ? new Link({
      path: SOCKET,
      onCommand: (command) => obey(command),
      onConnect: () => {
        // Before its session is open the client says `started` itself.
        if (!client?.sessionId) return
        link?.send({
          type: 'started',
          run: RUN,
          at: Date.now(),
          sessionId: client.sessionId,
          model: client.modelName,
          thinking: null,
        })
        link?.send({ type: client.working ? 'turn_started' : 'idle', run: RUN, at: Date.now() })
      },
      onDisconnect: () => {
        // A gate with nobody at the other end refuses: approvals are on.
        for (const [, decide] of deciding) {
          decide({ allow: false, reason: 'Tade is not reachable, and approvals are on' })
        }
        deciding.clear()
      },
    })
  : null

function say(said: Said): void {
  link?.send({ ...said, run: RUN, at: Date.now() })
  screen = signalled(screen, said, Date.now())
  redraw()
}

function obey(command: WorkerCommand): void {
  if (!client) return
  switch (command.type) {
    case 'steer':
    case 'queue':
      client.send(command.message)
      return
    case 'abort':
      client.cancel()
      return
    case 'shutdown':
      end(0)
      return
    case 'decision':
      deciding.get(command.requestId)?.({ allow: command.allow, reason: command.reason })
      deciding.delete(command.requestId)
      return
    case 'model':
      if (command.provider && command.provider !== chosen.agent?.id) {
        say({
          type: 'problem',
          text: `a conversation stays with the agent it is in, so it cannot move to ${command.provider}`,
        })
        return
      }
      void client.setModel(command.id)
      return
    default:
      // A name, a thinking level, a tool's answer: not this lane's to act on.
      return
  }
}

async function gate(ask: {
  requestId: string
  tool: string
  input: unknown
  summary: string
}): Promise<{ allow: boolean; reason: string }> {
  // Nothing is held under `bypass`: that is the mode's promise.
  if (!GATED) return { allow: true, reason: '' }
  if (!link?.connected)
    return { allow: false, reason: 'Tade is not reachable, and approvals are on' }
  const decided = new Promise<{ allow: boolean; reason: string }>((resolve) => {
    deciding.set(ask.requestId, resolve)
  })
  say({ type: 'permission_request', ...ask })
  const decision = await decided
  say({
    type: 'permission_resolved',
    requestId: ask.requestId,
    allowed: decision.allow,
    reason: decision.reason,
  })
  return decision
}

/** The agent's own sign-in, in this terminal, with the drawing paused while it runs. */
function signInHere(method: { args: string[]; env: Record<string, string> }): Promise<boolean> {
  const agent = chosen.agent
  if (!agent) return Promise.resolve(false)
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  out.write('\r\n')
  liveRows = 0
  return new Promise((resolve) => {
    const child = spawn(agent.command, method.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...method.env },
      stdio: 'inherit',
    })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      resolve(code === 0)
    })
  })
}

let ended = false
function end(code: number): void {
  if (ended) return
  ended = true
  client?.stop()
  link?.close()
  if (drawing) clearInterval(drawing)
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  if (tty) out.write('\r\n')
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => end(0))

// The line you type on.
if (process.stdin.isTTY) {
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  let pasting = false
  process.stdin.on(
    'keypress',
    (
      chunk: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
    ) => {
      const name = key?.name
      if (name === 'paste-start') pasting = true
      else if (name === 'paste-end') pasting = false
      else if ((name === 'return' || name === 'enter') && !pasting) {
        const text = screen.draft
        screen = { ...screen, draft: '' }
        if (text.trim()) client?.send(text)
      } else if ((name === 'return' || name === 'enter') && pasting) {
        screen = { ...screen, draft: `${screen.draft}\n` }
      } else if (name === 'escape') client?.cancel()
      else if (key?.ctrl && name === 'c') screen = { ...screen, draft: '' }
      else if (name === 'backspace')
        screen = { ...screen, draft: [...screen.draft].slice(0, -1).join('') }
      else if (chunk && !key?.ctrl && !key?.meta && chunk >= ' ') {
        screen = { ...screen, draft: screen.draft + chunk }
      }
      redraw()
    },
  )
  out.on('resize', () => redraw())
}

if (!chosen.agent) {
  show({ kind: 'problem', text: chosen.why })
  link?.send({ type: 'failed', run: RUN, at: Date.now(), error: chosen.why })
  // Kept on screen for whoever looks, and the lane ends so Tade sees it end.
  setTimeout(() => end(1), 2_000)
} else {
  const agent = chosen.agent
  show({ kind: 'note', text: `${agent.title}, over the Agent Client Protocol` })
  if (chosen.why) show({ kind: 'note', text: chosen.why })
  const env = { ...process.env }
  // Tade's socket is this lane's, and its tools reach the agent as an MCP server.
  delete env[WORKER_ENV.socket]
  client = new AcpClient({
    command: agent.command,
    args: agent.args,
    cwd: process.cwd(),
    env,
    agent: agent.id,
    record: launch.record,
    resume: recorded.agent === agent.id ? recorded.sessionId : null,
    model: launch.model ?? (recorded.agent === agent.id ? recorded.model : null),
    instructions: launch.instructions,
    mcpServers: launch.mcpServers,
    signal: (said) => {
      say(said)
      if (said.type === 'exited') setTimeout(() => end(said.code ?? 1), 500)
    },
    draw: show,
    gate,
    ...(process.stdin.isTTY ? { signInHere } : {}),
  })
  client
    .start()
    .then(() => {
      if (opening.trim()) client?.send(opening)
    })
    .catch(() => setTimeout(() => end(1), 2_000))
}
