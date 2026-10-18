import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The rehearsal's stand-in model: an OpenAI-shaped server that a machine's pi
// is pointed at through its own `models.json`, so the whole remote story —
// an orchestrator asked to start work, an agent that does it and says it is
// done — runs with no network and no key. It keeps nothing between requests:
// what it answers is read off the conversation it is sent.
//
// - **The orchestrator** (its request offers `tade_task_create`) understands
//   three sentences a person types on a machine's tab: `start <project>/<name>:
//   <intent>` creates the task and starts its agent, `hand <project>/<name> to
//   <machine>` hands it over, and `watch <extension>.<watch> on <project>`
//   turns a watch on. Anything else is "Noted.".
// - **An agent** (its request offers `bash`) waits `workSeconds`, so it is seen
//   working, commits a line to WORK.md with its task's own trailer, runs its
//   checks where it is offered `checks_run`, then calls `tade_done`.
//
// The rehearsal test starts it in-process (`startStandIn`); on a box the
// rehearsal script runs this file with Node: `node stand-in-model.ts`, with
// REHEARSAL_MODEL_PORT and REHEARSAL_WORK_SECONDS.

/** The provider and model id pi is given: `rehearsal/stand-in`. */
export const STAND_IN = { provider: 'rehearsal', model: 'stand-in' } as const

export interface StandIn {
  url: string
  /** How many requests it answered, by who asked: `orchestrator` or `agent`. */
  asked: { orchestrator: number; agent: number }
  close(): Promise<void>
}

type Message = { role?: string; content?: unknown }
type Answer = { text: string } | { tool: string; args: Record<string, unknown> }

/** The text of a message, whether its content is a string or parts. */
function textOf(message: Message | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part as { text?: string }).text ?? '').join('\n')
}

/** The first line of what the last tool answered, said back rather than claiming it worked. */
function lastAnswer(messages: Message[]): string {
  const answered = messages.findLast((one) => one.role === 'tool')
  return textOf(answered).split('\n')[0]?.trim() || 'Done.'
}

/** What the orchestrator does with the newest thing the person said: start, hand over, or watch. */
function orchestrate(messages: Message[]): Answer {
  const last = messages.map((one) => one.role).lastIndexOf('user')
  const said = textOf(messages[last])
  const step = messages.slice(last + 1).filter((one) => one.role === 'tool').length
  const start = /start ([a-z0-9][\w-]*)\/([a-z0-9][\w-]*): ([^\n]+)/.exec(said)
  if (start) {
    const [, project = '', name = '', intent = ''] = start
    if (step === 0) return { tool: 'tade_task_create', args: { project, name, intent } }
    if (step === 1) {
      return { tool: 'tade_run_start', args: { task: `${project}/${name}`, prompt: intent } }
    }
    return { text: lastAnswer(messages) }
  }
  const hand = /(hand ([a-z0-9][\w-]*\/[a-z0-9][\w-]*) to ([a-z0-9][\w-]*)[^\n]*)/.exec(said)
  if (hand) {
    const [, asked = '', task = '', machine = ''] = hand
    if (step === 0) return { tool: 'tade_task_move', args: { task, machine, asked } }
    return { text: lastAnswer(messages) }
  }
  const watch = /(watch ([a-z0-9][\w-]*\.[a-z0-9][\w-]*) on ([a-z0-9][\w-]*)[^\n]*)/.exec(said)
  if (watch) {
    const [, asked = '', id = '', project = ''] = watch
    if (step === 0) {
      return { tool: 'tade_watch_change', args: { watch: id, project, on: true, said: asked } }
    }
    return { text: lastAnswer(messages) }
  }
  return { text: 'Noted.' }
}

/**
 * What an agent does, turn by turn: work and commit, say it is done, close.
 * Told to push for a hand-over (`hand-over.ts`: "push it with `git push origin
 * HEAD:refs/heads/<branch>`"), it commits what it has, runs exactly that, and
 * ends its turn there without saying it is done — the work carries on on the
 * machine it was handed to.
 */
function work(messages: Message[], tools: readonly unknown[], seconds: number): Answer {
  const turns = messages.filter((one) => one.role === 'assistant').length
  const task = /Tade-Task: ([A-Za-z0-9_./-]+)/.exec(JSON.stringify(messages))?.[1] ?? 'unknown'
  const told = messages
    .filter((one) => one.role === 'user')
    .slice(1)
    .map(textOf)
    .join('\n')
  const push = /`(git push origin HEAD:refs\/heads\/[\w./-]+)`/.exec(told)?.[1]
  if (push !== undefined) {
    const pushed = JSON.stringify(messages.filter((one) => one.role === 'assistant')).includes(push)
    if (pushed) return { text: 'Pushed: the work is on origin.' }
    const commit = `git add -A && (git diff --cached --quiet || git commit -q -m 'Work in progress, handed over' -m 'Tade-Task: ${task}')`
    return { tool: 'bash', args: { command: `${commit} && ${push}` } }
  }
  if (turns === 0) {
    const command = [
      `sleep ${seconds}`,
      `printf 'worked on %s\\n' '${task}' >> WORK.md`,
      'git add WORK.md',
      `git commit -q -m 'Work done in the rehearsal' -m 'Tade-Task: ${task}'`,
    ].join(' && ')
    return { tool: 'bash', args: { command } }
  }
  // Its checks, where Tade offers them, as an agent is told to before it is done.
  const checks = tools.includes('checks_run') ? 1 : 0
  if (turns === 1 && checks === 1) return { tool: 'checks_run', args: { wait: 120 } }
  if (turns === 1 + checks) {
    return { tool: 'tade_done', args: { summary: `rehearsal work on ${task}, committed` } }
  }
  return { text: 'Done: the work is committed.' }
}

const USAGE = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 }

export async function startStandIn(
  opts: { port?: number; workSeconds?: number } = {},
): Promise<StandIn> {
  const asked = { orchestrator: 0, agent: 0 }
  const seconds = opts.workSeconds ?? 1
  const server: Server = createServer((req, res) => {
    res.on('error', () => {})
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: STAND_IN.model, object: 'model' }] }))
        return
      }
      let request: {
        tools?: { function?: { name?: string } }[]
        messages?: Message[]
        stream?: boolean
      } = {}
      try {
        request = JSON.parse(body)
      } catch {
        // An empty conversation, answered as one: "Noted.".
      }
      const tools = (request.tools ?? []).map((tool) => tool.function?.name)
      const messages = request.messages ?? []
      let answer: Answer = { text: 'Noted.' }
      if (tools.includes('tade_task_create')) {
        asked.orchestrator++
        answer = orchestrate(messages)
      } else if (tools.includes('bash')) {
        asked.agent++
        answer = work(messages, tools, seconds)
      }
      const call =
        'tool' in answer
          ? [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: 'function',
                function: { name: answer.tool, arguments: JSON.stringify(answer.args) },
              },
            ]
          : null
      const finish = call ? 'tool_calls' : 'stop'
      const content = 'text' in answer ? answer.text : null
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stand-in',
            object: 'chat.completion',
            model: STAND_IN.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content, ...(call ? { tool_calls: call } : {}) },
                finish_reason: finish,
              },
            ],
            usage: USAGE,
          }),
        )
        return
      }
      const delta = call ? { role: 'assistant', tool_calls: call } : { role: 'assistant', content }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
        { choices: [], usage: USAGE },
      ]) {
        const frame = {
          id: 'chatcmpl-stand-in',
          object: 'chat.completion.chunk',
          model: STAND_IN.model,
        }
        res.write(`data: ${JSON.stringify({ ...frame, ...chunk })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** pi's `models.json` in `dir` (its agent directory), naming the stand-in at `url`. */
export function writeStandInModels(dir: string, url: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        [STAND_IN.provider]: {
          baseUrl: url,
          api: 'openai-completions',
          apiKey: 'rehearsal',
          models: [
            {
              id: STAND_IN.model,
              name: 'Rehearsal stand-in',
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.REHEARSAL_MODEL_PORT ?? 11434)
  const workSeconds = Number(process.env.REHEARSAL_WORK_SECONDS ?? 45)
  const running = await startStandIn({ port, workSeconds })
  process.stdout.write(`the rehearsal's stand-in model, at ${running.url}\n`)
}
