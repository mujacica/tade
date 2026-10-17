import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  CodexAdapter,
  catalogIn,
  contextFor,
  describeToolCall,
  effortOf,
  HOOK_PATH,
  MCP_PATH,
  methodIn,
  runSocket,
  toolName,
  writesOf,
} from '../src/adapter.ts'
import { missedPath } from '../src/missed.ts'
import { rememberThread, threadOf } from '../src/sessions.ts'
import { toml } from '../src/toml.ts'

// The adapter without Codex: its hooks and tool server are run as the
// processes Codex would run, against the adapter's socket, and what it types
// is kept instead of reaching a terminal. A turn Tade draws itself is run
// against a `codex` that prints the events a real one prints.

// A bound on "never", not a measurement: every wait here is on a real `sh`
// starting, writing a file or dying, and five seconds of that on a machine
// running other suites was a test of the machine ("is ended on shutdown",
// red at load 13 and green alone). The message says which wait it was.
async function until(check: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${check}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Run a script the way Codex runs a hook: JSON in, JSON (or nothing) out. */
function run(
  script: string,
  input: string,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('exit', (code) => resolve({ stdout, code }))
    child.stdin.end(input)
  })
}

/**
 * Ask the window over a run's socket from here, as a hook does: `sent` once
 * the question is on its way and the loop has turned for the window to read
 * it, `reply` once it is answered.
 */
function askAt(socket: string, request: unknown): { sent: Promise<void>; reply: Promise<unknown> } {
  const asking = connect(socket)
  const sent = new Promise<void>((resolve) => {
    asking.on('connect', () =>
      asking.write(`${JSON.stringify(request)}\n`, () => setImmediate(resolve)),
    )
  })
  const reply = new Promise<unknown>((resolve, reject) => {
    let buffer = ''
    asking.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\n')
      if (end < 0) return
      resolve(JSON.parse(buffer.slice(0, end)))
      asking.destroy()
    })
    asking.on('error', reject)
  })
  return { sent, reply }
}

describe('CodexAdapter', () => {
  let adapter: CodexAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  const setUp = async (approvals: 'bypass' | 'policy' = 'bypass') => {
    const typed: string[] = []
    const codexHome = tmp('tade-codex-account-')
    const runDir = tmp('tcx-')
    const made = new CodexAdapter({
      runDir,
      codexHome,
      home: tmp('tade-codex-home-'),
      bin: '/nonexistent/codex',
      approvals,
      type: async (_run, text) => {
        typed.push(text)
      },
    })
    adapter = made
    const cwd = tmp('tade-codex-cwd-')
    const spec = { run: 'app/refunds/agent', task: 'app/refunds', cwd, prompt: '' }
    const signals: WorkerSignal[] = []
    made.onSignal(spec.run, (signal) => signals.push(signal))
    await made.supervise(spec)
    const env = {
      TADE_RUN_SOCKET: runSocket(runDir, spec.run),
      TADE_APPROVALS: approvals,
      TADE_RUN_ID: spec.run,
    }
    const hook = (event: Record<string, unknown>) =>
      run(HOOK_PATH, JSON.stringify(event), env).then(({ stdout }) =>
        stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null,
      )
    const kinds = () => signals.map((signal) => signal.type)
    return { adapter: made, codexHome, typed, signals, kinds, hook, env, spec, runDir }
  }

  const started = (session = 'thread-1') => ({
    hook_event_name: 'SessionStart',
    session_id: session,
    model: 'gpt-5.6-terra',
  })

  describe('the line that starts it', () => {
    const line = (over: Record<string, unknown> = {}) => {
      const one = new CodexAdapter({
        runDir: '/runs',
        codexHome: '/accounts/work',
        home: tmp('tade-codex-home-'),
        bin: 'codex',
      })
      return one.launchSpec({
        run: 'app/refunds/agent',
        task: 'app/refunds',
        cwd: '/work/refunds',
        prompt: 'fix the flaky login test',
        ...over,
      })
    }

    it('says the first thing once, and never in the line written down', () => {
      const launch = line()
      expect(launch.args.join('\n')).not.toContain('fix the flaky login test')
      expect(launch.opening).toEqual(['fix the flaky login test'])
      expect(line({ prompt: '' }).opening).toBeUndefined()
      expect(line({ prompt: '' }).args).toEqual(launch.args)
    })

    it('keeps a picture a week, and takes it away with the next once it is older', () => {
      const one = new CodexAdapter({
        runDir: tmp('tade-codex-run-'),
        codexHome: '/accounts/work',
        home: tmp('tade-codex-home-'),
        bin: 'codex',
      })
      const shown = () =>
        /\[picture: (.+)\]/.exec(
          one.launchSpec({
            run: 'app/refunds/agent',
            task: 'app/refunds',
            cwd: '/work/refunds',
            prompt: 'look at this',
            images: [{ data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
          }).opening?.[0] ?? '',
        )?.[1] ?? ''
      const first = shown()
      const old = join(dirname(first), 'old.png')
      writeFileSync(old, 'png')
      const overAWeek = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
      utimesSync(old, overAWeek, overAWeek)
      const next = shown()
      expect(existsSync(old)).toBe(false)
      expect(readFileSync(first, 'utf8')).toBe('png')
      expect(readFileSync(next, 'utf8')).toBe('png')
    })

    it('looks for the thread this task talks in, and resumes it when there is one', () => {
      const launch = line()
      const script = launch.args[1] ?? ''
      expect(script).toContain('resume')
      // Where it looks is the note Tade keeps for this task, and nowhere else.
      expect(launch.args[3]).toMatch(/^\/runs\/codex\/[0-9a-f]+\/thread$/)
    })

    it('hands Codex its settings on the line rather than in anybody’s own config', () => {
      const args = line().args.join(' ')
      expect(args).toContain('hooks=')
      expect(args).toContain('mcp_servers=')
      expect(args).toContain('projects={"/work/refunds"={"trust_level"="trusted"}}')
      expect(args).toContain('--sandbox danger-full-access')
      expect(args).toContain('--ask-for-approval never')
      expect(args).toContain('--dangerously-bypass-hook-trust')
      // `--skip-git-repo-check` is `codex exec`'s alone: on the line that
      // draws a terminal, Codex refuses it and the lane holds a usage message.
      expect(args).not.toContain('--skip-git-repo-check')
    })

    it('says the model and the effort it was given, since a resumed thread keeps neither', () => {
      const args = line({ model: { id: 'openai/gpt-5.3-codex' }, thinking: 'xhigh' }).args
      expect(args).toContain('gpt-5.3-codex')
      expect(args.join(' ')).toContain('model_reasoning_effort="xhigh"')
    })

    it('tells the agent where to report, which run it is and which task', () => {
      const { env } = line()
      expect(env.TADE_RUN_SOCKET).toBeTruthy()
      expect(env.TADE_RUN_ID).toBe('app/refunds/agent')
      expect(env.TADE_TASK_ID).toBe('app/refunds')
      expect(env.CODEX_HOME).toBe('/accounts/work')
    })

    it('drops an API key inherited from somebody’s shell, so the account given pays', () => {
      expect(line().args[1]).toContain('unset CODEX_API_KEY OPENAI_API_KEY')
    })
  })

  describe('what its hooks say', () => {
    it('says the session started, writes down its thread, and says what Tade told it', async () => {
      const { adapter: one, hook, signals, runDir } = await setUp()
      const reply = await hook(started())
      expect(reply).toBeNull()
      await until(() => signals.some((signal) => signal.type === 'started'))
      expect(signals[0]).toMatchObject({ type: 'started', sessionId: 'thread-1' })
      expect(await threadOf('app/refunds', runDir)).toBe('thread-1')
      expect(await one.modelOf('app/refunds/agent')).toEqual({
        provider: 'openai',
        id: 'gpt-5.6-terra',
      })
    })

    it('names the work after the first thing it was asked, once', async () => {
      const { hook, signals, kinds } = await setUp()
      await hook(started())
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'please fix the flaky login test' })
      expect(kinds()).toContain('turn_started')
      expect(signals.find((signal) => signal.type === 'titled')).toMatchObject({
        title: 'fix the flaky login test',
        named: false,
      })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and now the logout one' })
      expect(signals.filter((signal) => signal.type === 'titled')).toHaveLength(1)
    })

    it('says a tool call and lets it through when nothing is gated', async () => {
      const { hook, signals } = await setUp('bypass')
      await hook(started())
      const reply = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
        tool_use_id: 'c1',
      })
      expect(reply).toBeNull()
      expect(signals.find((signal) => signal.type === 'tool_call')).toMatchObject({
        tool: 'Bash',
        callId: 'c1',
      })
      expect(signals.some((signal) => signal.type === 'permission_request')).toBe(false)
    })

    it('holds a tool call for a person, and refuses it in words Codex takes', async () => {
      const { adapter: one, hook, signals, spec } = await setUp('policy')
      await hook(started())
      const held = hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        tool_use_id: 'c2',
      })
      await until(() => signals.some((signal) => signal.type === 'permission_request'))
      const asked = signals.find((signal) => signal.type === 'permission_request')
      // Read back before anybody approves it: the command, not a paraphrase.
      expect(asked).toMatchObject({ summary: 'Bash: rm -rf /', requestId: 'c2' })
      await one.decide(spec.run, 'c2', { allow: false, reason: 'not that one' })
      expect(await held).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'not that one',
        },
      })
    })

    it('approves by saying nothing, which is the only approval Codex takes', async () => {
      const { adapter: one, hook, signals, spec } = await setUp('policy')
      await hook(started())
      const held = hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'c3',
      })
      await until(() => signals.some((signal) => signal.type === 'permission_request'))
      await one.decide(spec.run, 'c3', { allow: true })
      expect(await held).toBeNull()
    })

    it('refuses a held call rather than leaving it hanging when Tade lets go', async () => {
      const { adapter: one, hook, signals } = await setUp('policy')
      await hook(started())
      const held = hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'c4',
      })
      await until(() => signals.some((signal) => signal.type === 'permission_request'))
      await one.detach()
      expect(await held).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
    })

    it('says a turn ended, and that one cut short was cut short', async () => {
      const { hook, signals, kinds } = await setUp()
      await hook(started())
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' })
      expect(signals.find((signal) => signal.type === 'message')).toMatchObject({ text: 'done' })
      expect(signals.find((signal) => signal.type === 'turn_done')).toMatchObject({ status: 'ok' })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })
      await hook({ hook_event_name: 'Interrupt' })
      expect(signals.filter((signal) => signal.type === 'turn_done').at(-1)).toMatchObject({
        status: 'aborted',
      })
      expect(kinds().filter((kind) => kind === 'idle')).toHaveLength(2)
    })

    it('counts what a turn spent out of Codex’s own record, once it has one', async () => {
      const { adapter: one, hook, signals, codexHome, runDir } = await setUp()
      const dir = join(codexHome, 'sessions', '2026', '09', '21')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'rollout-2026-09-21T09-47-18-thread-1.jsonl'),
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 10,
                total_tokens: 110,
              },
              model_context_window: 1_000,
            },
            rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 7 } },
          },
        })}\n`,
      )
      await hook(started())
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' })
      const usage = signals.find((signal) => signal.type === 'usage')
      expect(usage).toMatchObject({ input: 60, cacheRead: 40, output: 10, tokens: 110, usd: 0 })
      expect(signals.find((signal) => signal.type === 'context')).toMatchObject({
        tokens: 110,
        percent: 11,
      })
      expect(one.limits()?.windows).toEqual([{ minutes: 300, used: 5, resetsAt: 7_000 }])
      expect(await threadOf('app/refunds', runDir)).toBe('thread-1')
    })
  })

  describe('a window that closes and opens again', () => {
    // Under tmux the agent goes on while Tade is closed, and every hook it runs
    // then finds nobody listening. The window that comes back is another
    // adapter on the same folders, taking the run back as the workbench does.
    const backAs = (
      was: Awaited<ReturnType<typeof setUp>>,
      approvals: 'bypass' | 'policy' = 'bypass',
    ) => {
      const warnings: string[] = []
      const typed: string[] = []
      const back = new CodexAdapter({
        runDir: was.runDir,
        codexHome: was.codexHome,
        home: tmp('tade-codex-home-'),
        bin: '/nonexistent/codex',
        approvals,
        type: async (_run, text) => {
          typed.push(text)
        },
        onWarning: (message) => warnings.push(message),
      })
      adapter = back
      const signals: WorkerSignal[] = []
      back.onSignal(was.spec.run, (signal) => signals.push(signal))
      return { back, signals, warnings, typed, kinds: () => signals.map((signal) => signal.type) }
    }
    const comeBack = async (
      was: Awaited<ReturnType<typeof setUp>>,
      how: { alreadyRunning?: boolean } = { alreadyRunning: true },
    ) => {
      const window = backAs(was)
      await window.back.supervise({ ...was.spec, ...how })
      return window
    }
    /** The thread's rollout as Codex wrote it down, by the time the window came back. */
    const rolledOut = (was: Awaited<ReturnType<typeof setUp>>, events: object[]) => {
      const dir = join(was.codexHome, 'sessions', '2026', '10', '17')
      mkdirSync(dir, { recursive: true })
      const text = events.map((event) => `${JSON.stringify(event)}\n`).join('')
      writeFileSync(join(dir, 'rollout-2026-10-17T09-00-00-thread-1.jsonl'), text)
    }
    const began = {
      timestamp: '2026-10-17T09:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    }
    const asked = {
      timestamp: '2026-10-17T09:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'commit and push' },
    }
    const calling = {
      timestamp: '2026-10-17T09:00:05.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["git","push"]}' },
    }
    const replied = {
      timestamp: '2026-10-17T09:00:12.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Pushed.' }],
      },
    }
    const ended = {
      timestamp: '2026-10-17T09:00:12.500Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }

    it('says a turn cut short while Tade was away once it is back, when it ended, and once', async () => {
      const was = await setUp()
      await was.hook(started())
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'commit and push' })
      await was.adapter.detach()
      const before = Date.now()
      // Nobody listening: the hook carries on as ever.
      expect(await was.hook({ hook_event_name: 'Interrupt' })).toBeNull()
      const after = Date.now()

      const { back, signals, kinds } = await comeBack(was)
      await until(() => kinds().includes('idle'))
      expect(kinds()).toEqual(['turn_done', 'idle'])
      expect(signals[0]).toMatchObject({ status: 'aborted', run: was.spec.run })
      // Stamped when it ended, not when it was said.
      expect(signals[0]?.at).toBeGreaterThanOrEqual(before)
      expect(signals[0]?.at).toBeLessThanOrEqual(after)

      // Said once: taken, so the next window back has nothing to add.
      expect(existsSync(missedPath(runSocket(was.runDir, was.spec.run)))).toBe(false)
      await back.detach()
      const again = await comeBack(was)
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>' })
      // Idle as it was taken back, with no turn left to say and none under way.
      expect(again.kinds()).toEqual(['idle', 'turn_started'])
    })

    it('says a turn begun since as under way, so its end is heard when it comes', async () => {
      const was = await setUp()
      await was.hook(started())
      await was.adapter.detach()
      await was.hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>' })

      const { signals, kinds } = await comeBack(was)
      await until(() => kinds().includes('turn_started'))
      expect(kinds()).toEqual(['turn_done', 'turn_started'])
      expect(signals[0]).toMatchObject({ status: 'ok' })
      // A turn this adapter never saw begin, ending with Tade there to hear it.
      await was.hook({ hook_event_name: 'Stop', last_assistant_message: 'Pushed.' })
      expect(kinds()).toEqual(['turn_done', 'turn_started', 'message', 'turn_done', 'idle'])
    })

    it('says it could not read what was left, rather than that no turn ended', async () => {
      const was = await setUp()
      await was.adapter.detach()
      writeFileSync(missedPath(runSocket(was.runDir, was.spec.run)), '{"at":')
      const { kinds, warnings } = await comeBack(was)
      expect(warnings).toEqual([expect.stringContaining('is not a turn that ended')])
      await until(() => kinds().length > 0)
      expect(kinds()).toEqual(['idle'])
    })

    it('says nothing of it to a launch, which is a new process, and forgets it', async () => {
      const was = await setUp()
      await was.adapter.detach()
      await was.hook({ hook_event_name: 'Stop' })
      const kept = missedPath(runSocket(was.runDir, was.spec.run))
      expect(existsSync(kept)).toBe(true)

      const launched = await comeBack(was, {})
      expect(existsSync(kept)).toBe(false)
      await was.hook(started())
      expect(launched.kinds()).toEqual(['started'])
    })
    it('says a run taken back between turns is idle, so what is said to it is typed rather than held', async () => {
      const was = await setUp()
      await was.hook(started())
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'commit and push' })
      await was.hook({ hook_event_name: 'Stop', last_assistant_message: 'Pushed.' })
      await was.adapter.detach()
      // It missed nothing: its turn ended with Tade there, and none began since.
      rolledOut(was, [began, asked, calling, replied, ended])

      const { back, kinds, typed } = await comeBack(was)
      await until(() => kinds().includes('idle'))
      expect(kinds()).toEqual(['idle'])
      await back.queue(was.spec.run, 'then open a PR')
      expect(typed.join('')).toContain('then open a PR')
    })

    it('says a run taken back in the middle of a turn is in one, since it began, and hears it end', async () => {
      const was = await setUp()
      await was.hook(started())
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'commit and push' })
      await was.adapter.detach()
      rolledOut(was, [began, asked, calling])

      const { back, signals, kinds, typed } = await comeBack(was)
      await until(() => kinds().includes('turn_started'))
      expect(kinds()).toEqual(['turn_started'])
      expect(signals[0]?.at).toBe(Date.parse(began.timestamp))
      await back.queue(was.spec.run, 'then open a PR')
      expect(typed).toEqual([])
      await was.hook({ hook_event_name: 'Stop', last_assistant_message: 'Pushed.' })
      await until(() => typed.join('').includes('then open a PR'))
      expect(kinds()).toEqual(['turn_started', 'message', 'turn_done', 'idle'])
    })

    it('holds a tool call that reaches it while it takes the run back for a person, rather than letting it through', async () => {
      const was = await setUp('policy')
      await was.hook(started())
      await was.adapter.detach()
      await was.hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
      await was.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'clean up' })
      // What was left is read once the window is listening, and before it has
      // the run: left as a pipe nobody has written to yet, it holds the window
      // there for as long as the test likes.
      const socket = runSocket(was.runDir, was.spec.run)
      const left = readFileSync(missedPath(socket), 'utf8')
      rmSync(missedPath(socket))
      execFileSync('mkfifo', [missedPath(socket)])
      const { back, signals, kinds } = backAs(was, 'policy')
      const taken = back.supervise({ ...was.spec, alreadyRunning: true })
      await until(() => existsSync(`${missedPath(socket)}.taking`))

      const call = askAt(socket, {
        kind: 'hook',
        event: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf build' },
          tool_use_id: 'c1',
        },
      })
      await call.sent
      await writeFile(`${missedPath(socket)}.taking`, left)
      await taken
      await until(() => kinds().includes('permission_request'))
      expect(signals.find((signal) => signal.type === 'permission_request')).toMatchObject({
        summary: 'Bash: rm -rf build',
      })
      await back.decide(was.spec.run, 'c1', { allow: false, reason: 'not that one' })
      expect(await call.reply).toMatchObject({
        output: { hookSpecificOutput: { permissionDecision: 'deny' } },
      })
    })
  })

  describe('a run whose session it never heard start', () => {
    it('hears a turn end all the same, as Claude Code does, rather than dropping it', async () => {
      // A SessionStart that took longer than its hook waits was answered by
      // nobody, so the run is still `starting` when the turn it began ends.
      const { hook, kinds } = await setUp()
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Pushed.' })
      expect(kinds()).toEqual(['message', 'turn_done', 'idle'])
    })
  })

  describe('what is said to it', () => {
    it('waits for the session before typing, and says what waited once it can', async () => {
      const { adapter: one, hook, typed, spec } = await setUp()
      await one.prompt(spec.run, 'start here')
      expect(typed).toEqual([])
      await hook(started())
      await until(() => typed.length > 0)
      expect(typed.join('')).toContain('start here')
    })

    it('holds a message until the turn it arrived in ends', async () => {
      const { adapter: one, hook, typed, spec } = await setUp()
      await hook(started())
      await until(() => typed.length >= 0)
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await one.queue(spec.run, 'and then the other one')
      expect(typed.join('')).not.toContain('and then the other one')
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' })
      await until(() => typed.join('').includes('and then the other one'))
    })

    it('renames its thread between turns, never in the middle of one', async () => {
      const { adapter: one, hook, typed, spec } = await setUp()
      await hook(started())
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await one.name(spec.run, 'refund flow')
      expect(typed.join('')).not.toContain('/rename')
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' })
      await until(() => typed.join('').includes('/rename refund flow'))
    })

    it('refuses a model or an effort rather than typing a command that changes a default', async () => {
      const { adapter: one, spec } = await setUp()
      await expect(one.setModel(spec.run, { id: 'gpt-5.3-codex' })).rejects.toThrow(
        /starts the agent again/,
      )
      await expect(one.setThinking(spec.run, 'high')).rejects.toThrow(/starts the agent again/)
    })
  })

  describe('the tools Tade lends it', () => {
    it('offers tade_done, tade_document_ready, tade_leftovers and whatever an extension gave it, and answers a call', async () => {
      const { adapter: one, env, spec, signals } = await setUp()
      const a = { title: 'a', where: 'src/a.ts:1', why: 'not mine', sure: 'certain' }
      const left = [a, { ...a, title: 'b', where: 'pnpm test' }]
      const tools = join(tmp('tade-codex-tools-'), 'tools.json')
      writeFileSync(
        tools,
        JSON.stringify([
          {
            name: 'deps_check',
            description: 'what is out of date',
            parameters: { type: 'object' },
          },
        ]),
      )
      const server = spawn(process.execPath, [MCP_PATH], {
        env: { ...process.env, ...env, TADE_EXTENSION_TOOLS: tools },
      })
      const lines: string[] = []
      let rest = ''
      server.stdout.on('data', (chunk: Buffer) => {
        rest += chunk.toString('utf8')
        for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
          lines.push(rest.slice(0, end))
          rest = rest.slice(end + 1)
        }
      })
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      await until(() => lines.length > 0)
      const listed = JSON.parse(lines[0] ?? '{}') as {
        result: { tools: { name: string }[] }
      }
      expect(listed.result.tools.map((tool) => tool.name)).toEqual([
        'deps_check',
        'tade_document_ready',
        'tade_leftovers',
        'tade_done',
      ])

      server.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'deps_check', arguments: {} },
        })}\n`,
      )
      await until(() => signals.some((signal) => signal.type === 'extension_call'))
      const call = signals.find((signal) => signal.type === 'extension_call')
      expect(call).toMatchObject({ tool: 'deps_check' })
      await one.answer(spec.run, (call as { callId: string }).callId, {
        ok: true,
        text: 'three are behind',
      })
      await until(() => lines.length > 1)
      expect(lines[1]).toContain('three are behind')

      server.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'tade_done', arguments: { summary: 'removed tests', leftovers: left } },
        })}\n`,
      )
      // What it left goes to Tade first, as `tade_leftovers`, and only then is it done.
      const called = () => signals.filter((signal) => signal.type === 'extension_call')[1]
      await until(() => called() !== undefined)
      expect(called()).toMatchObject({
        tool: 'tade_leftovers',
        input: { items: left, finishing: true },
      })
      expect(signals.some((signal) => signal.type === 'done')).toBe(false)
      const said = 'What you left is put to the orchestrator.'
      await one.answer(spec.run, (called() as { callId: string }).callId, { ok: true, text: said })
      await until(() => signals.some((signal) => signal.type === 'done'))
      expect(signals.find((signal) => signal.type === 'done')).toMatchObject({
        summary: 'removed tests',
      })
      await until(() => lines.length > 2)
      expect(lines[2]).toContain(`Tade has it: this task is finished. ${said}`)
      server.kill()
    })
  })

  describe('what Codex says about itself', () => {
    /** A `codex` that answers `login status` and `debug models` and nothing else. */
    const fakeAnswers = (lines: Record<string, string>): string => {
      const bin = join(tmp('tade-codex-fake-'), 'codex')
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          'case "$*" in',
          ...Object.entries(lines).map(
            ([match, said]) => `  ${match}) cat <<'SAID'\n${said}\nSAID\n  ;;`,
          ),
          '  *) exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
      )
      chmodSync(bin, 0o755)
      return bin
    }

    const withBin = (bin: string) => {
      const made = new CodexAdapter({
        runDir: tmp('tcx-'),
        codexHome: tmp('tade-codex-account-'),
        home: tmp('tade-codex-home-'),
        bin,
      })
      adapter = made
      return made
    }

    it('places a name among what Codex offers, and takes one that reads like a model', async () => {
      const one = withBin(
        fakeAnswers({
          '"debug models"': JSON.stringify({
            models: [
              { slug: 'gpt-5.6-terra', display_name: 'Terra' },
              { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
            ],
          }),
        }),
      )
      expect(await one.resolveModel('gpt-5.6-terra')).toEqual({
        ok: true,
        provider: 'openai',
        id: 'gpt-5.6-terra',
      })
      expect(await one.resolveModel('the terra model')).toMatchObject({ id: 'gpt-5.6-terra' })
      // The catalog is what Codex shows people, not everything it will run.
      expect(await one.resolveModel('gpt-5.3-codex')).toMatchObject({ id: 'gpt-5.3-codex' })
      expect(await one.resolveModel('opus 5')).toMatchObject({ ok: false })
    })

    it('says who it is signed in as, and that it is not, without throwing', async () => {
      const one = withBin(fakeAnswers({ '"login status"': 'Logged in using ChatGPT' }))
      expect(await one.account()).toMatchObject({ signedIn: true, method: 'chatgpt' })
      const out = withBin(fakeAnswers({ '"login status"': 'Not logged in' }))
      expect(await out.account()).toMatchObject({ signedIn: false, problem: 'not signed in yet' })
    })

    it('signs in by device code on a machine with no screen, as Codex itself says to', () => {
      const one = withBin('/nonexistent/codex')
      expect(one.signIn({ browser: true })?.launch.args).toEqual(['login'])
      const server = one.signIn({ browser: false })
      expect(server?.launch.args).toEqual(['login', '--device-auth'])
      expect(server?.how).toContain('security settings')
    })

    it('says Codex is not here rather than pretending it is', async () => {
      const one = withBin('/nonexistent/codex')
      const probe = await one.probe()
      expect(probe.ok).toBe(false)
      expect(probe.problems.join(' ')).toContain('not installed')
      expect(await one.account()).toMatchObject({ signedIn: false })
    })
  })

  describe('a turn Tade draws itself', () => {
    /** A `codex` that prints what a real one prints, and keeps what it was told. */
    const fakeCodex = (events: string[]): string => {
      const dir = tmp('tade-codex-fake-')
      const bin = join(dir, 'codex')
      writeFileSync(
        bin,
        ['#!/bin/sh', 'cat > "$0.said"', ...events.map((one) => `echo '${one}'`), ''].join('\n'),
      )
      chmodSync(bin, 0o755)
      return bin
    }

    it('runs an instruction as a turn on the same thread, and says what it did', async () => {
      const bin = fakeCodex([
        '{"type":"thread.started","thread_id":"thread-9"}',
        '{"type":"turn.started"}',
        '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls"}}',
        '{"type":"item.completed","item":{"id":"i1","type":"command_execution","exit_code":0,"status":"completed"}}',
        '{"type":"item.completed","item":{"id":"i2","type":"error","message":"`--dangerously-bypass-hook-trust` is enabled."}}',
        '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"three agents are running"}}',
        '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}}',
      ])
      const runDir = tmp('tcx-')
      const made = new CodexAdapter({
        runDir,
        codexHome: tmp('tade-codex-account-'),
        home: tmp('tade-codex-home-'),
        bin,
      })
      adapter = made
      const spec = {
        run: 'tade/orchestrator/agent',
        task: 'tade/orchestrator',
        cwd: tmp('tade-codex-cwd-'),
        prompt: '',
      }
      const signals: WorkerSignal[] = []
      made.onSignal(spec.run, (signal) => signals.push(signal))
      await made.start(spec)
      await made.prompt(spec.run, 'where are we')
      await until(() => signals.some((signal) => signal.type === 'idle'))
      const kinds = signals.map((signal) => signal.type)
      expect(kinds).toContain('turn_started')
      expect(signals.find((signal) => signal.type === 'message')).toMatchObject({
        text: 'three agents are running',
      })
      expect(signals.find((signal) => signal.type === 'tool_call')).toMatchObject({ tool: 'shell' })
      expect(signals.find((signal) => signal.type === 'usage')).toMatchObject({
        input: 60,
        cacheRead: 40,
        output: 9,
        usd: 0,
      })
      expect(signals.find((signal) => signal.type === 'turn_done')).toMatchObject({ status: 'ok' })
      // A warning about a flag Tade itself passed is not somebody's to fix.
      expect(signals.some((signal) => signal.type === 'problem')).toBe(false)
      // The thread it made is written down, so the next turn carries on in it.
      expect(await threadOf('tade/orchestrator', runDir)).toBe('thread-9')
      const said = readFileSync(`${bin}.said`, 'utf8')
      expect(said).toBe('where are we')
    })

    it('resumes the thread it already has rather than starting the conversation over', async () => {
      const bin = fakeCodex(['{"type":"turn.completed","usage":{"output_tokens":1}}'])
      const runDir = tmp('tcx-')
      await rememberThread('tade/orchestrator', runDir, 'thread-kept')
      const made = new CodexAdapter({
        runDir,
        codexHome: tmp('tade-codex-account-'),
        home: tmp('tade-codex-home-'),
        bin,
        args: ['--tade-args-marker'],
      })
      adapter = made
      const spec = {
        run: 'tade/orchestrator/agent',
        task: 'tade/orchestrator',
        cwd: tmp('tade-codex-cwd-'),
        prompt: 'hello again',
      }
      const signals: WorkerSignal[] = []
      made.onSignal(spec.run, (signal) => signals.push(signal))
      const handle = await made.start(spec)
      expect(handle.sessionId).toBe('thread-kept')
      await until(() => signals.some((signal) => signal.type === 'idle'))
    })

    it('says why it would not start rather than leaving a turn that never comes', async () => {
      const made = new CodexAdapter({
        runDir: tmp('tcx-'),
        codexHome: tmp('tade-codex-account-'),
        home: tmp('tade-codex-home-'),
        bin: '/nonexistent/codex',
      })
      adapter = made
      const spec = {
        run: 'tade/orchestrator/agent',
        task: 'tade/orchestrator',
        cwd: tmp('tade-codex-cwd-'),
        prompt: '',
      }
      const signals: WorkerSignal[] = []
      made.onSignal(spec.run, (signal) => signals.push(signal))
      await made.start(spec)
      await made.prompt(spec.run, 'anything')
      await until(() => signals.some((signal) => signal.type === 'failed'))
      expect(signals.find((signal) => signal.type === 'turn_done')).toMatchObject({
        status: 'error',
      })
    })
  })
})

describe('what Codex is told, and what it says back', () => {
  it('writes a setting as TOML Codex reads back as itself', () => {
    expect(toml({ a: 'x', b: 1, c: true, d: ['y'], e: { f: 'g' } })).toBe(
      '{"a"="x","b"=1,"c"=true,"d"=["y"],"e"={"f"="g"}}',
    )
    expect(toml('a "quoted" \\ path\nand a line')).toBe('"a \\"quoted\\" \\\\ path\\nand a line"')
    // A key with nothing behind it is left out: TOML has no null.
    expect(toml({ a: null, b: undefined, c: 1 })).toBe('{"c"=1}')
  })

  it('says what a tool does by what it is, including one it has never heard of', () => {
    const one = new CodexAdapter({ runDir: '/runs', home: tmp('tade-codex-home-') })
    expect(one.effectOf('shell')).toBe('exec')
    expect(one.effectOf('Bash')).toBe('exec')
    expect(one.effectOf('apply_patch')).toBe('write')
    expect(one.effectOf('read_file')).toBe('read')
    expect(one.effectOf('whatever_this_is')).toBe('other')
  })

  it('calls Tade’s own tools by their own names', () => {
    expect(toolName('mcp__tade__deps_check')).toBe('deps_check')
    expect(toolName('mcp__sentry__issues')).toBe('mcp__sentry__issues')
  })

  it('reads how Codex says it is signed in, and that it is not', () => {
    expect(methodIn('Logged in using ChatGPT\n')).toBe('chatgpt')
    expect(methodIn('Logged in using an API key - sk-abc\n')).toBe('an api key')
    expect(methodIn('Not logged in\n')).toBeNull()
    expect(methodIn('some other thing entirely')).toBeNull()
  })

  it('reads Codex’s catalog, leaves out what it hides, and invents nothing', () => {
    expect(
      catalogIn(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', context_window: 258_400 },
            { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
            { display_name: 'no slug at all' },
          ],
        }),
      ),
    ).toEqual([
      {
        id: 'openai/gpt-5.3-codex',
        provider: 'openai',
        name: 'GPT-5.3 Codex',
        contextWindow: 258_400,
      },
    ])
    expect(catalogIn('not json')).toEqual([])
    expect(catalogIn('{"models":"nope"}')).toEqual([])
  })

  it('takes the effort nearest what it was asked, since Codex has no "off"', () => {
    expect(effortOf('high')).toBe('high')
    expect(effortOf('off')).toBe('minimal')
  })

  it('names a held call exactly enough to read back', () => {
    expect(describeToolCall('shell', { command: ['rm', '-rf', 'build'] })).toBe(
      'shell: rm -rf build',
    )
    expect(describeToolCall('apply_patch', { path: 'src/app.ts' })).toBe('apply_patch src/app.ts')
  })

  it('says which files a patch writes, from its item or its hook', () => {
    expect(
      writesOf('apply_patch', {
        type: 'file_change',
        changes: [{ path: '/r/a.ts', kind: 'update' }],
      }),
    ).toEqual(['/r/a.ts'])
    expect(writesOf('apply_patch', { changes: { 'b.ts': { add: {} } } })).toEqual(['b.ts'])
    expect(
      writesOf('apply_patch', {
        command: [
          'apply_patch',
          '*** Begin Patch\n*** Update File: src/c.ts\n@@\n*** Add File: d.ts\n*** End Patch',
        ],
      }),
    ).toEqual(['src/c.ts', 'd.ts'])
    expect(writesOf('Edit', { file_path: '/r/e.ts' })).toEqual(['/r/e.ts'])
    expect(writesOf('shell', { command: ['ls'] })).toEqual([])
  })

  it('names the skills an extension ships, with where to read them', () => {
    const dir = tmp('tade-codex-skill-')
    const skill = join(dir, 'run-the-checks')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: run-the-checks\ndescription: how to run the checks\n---\n\nbody\n',
    )
    const told = contextFor({
      run: 'r',
      task: 't',
      cwd: '/x',
      prompt: '',
      extras: { instructions: 'You run inside Tade.', skills: [skill] },
    })
    expect(told).toContain('You run inside Tade.')
    expect(told).toContain('run-the-checks: how to run the checks')
    expect(told).toContain(join(skill, 'SKILL.md'))
  })

  it('names a skill by its folder when its own words cannot be read', () => {
    const dir = tmp('tade-codex-skill-')
    const skill = join(dir, 'nameless')
    mkdirSync(skill, { recursive: true })
    const told = contextFor({
      run: 'r',
      task: 't',
      cwd: '/x',
      prompt: '',
      extras: { skills: [skill] },
    })
    expect(told).toContain('nameless')
  })
})

describe('a turn Tade draws itself, when the window closes', () => {
  /** A `codex` whose turn never ends by itself, and which writes down where it is. */
  const stubborn = (): string => {
    const bin = join(tmp('tade-codex-fake-'), 'codex')
    writeFileSync(bin, '#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 600\n')
    chmodSync(bin, 0o755)
    return bin
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // A turn is a process of ours with no lane to carry on in: let go of rather
  // than ended, its pipes held Tade open after its window had closed.
  for (const how of ['detach', 'shutdown'] as const) {
    it(`is ended on ${how}, because nobody could find it again`, async () => {
      const bin = stubborn()
      const one = new CodexAdapter({
        runDir: tmp('tcx-'),
        codexHome: tmp('tade-codex-account-'),
        home: tmp('tade-codex-home-'),
        bin,
      })
      const spec = {
        run: 'tade/orchestrator/agent',
        task: 'tade/orchestrator',
        cwd: tmp('tade-codex-cwd-'),
        prompt: '',
      }
      await one.start(spec)
      await one.prompt(spec.run, 'where are we')
      await until(() => existsSync(`${bin}.pid`))
      const pid = Number(readFileSync(`${bin}.pid`, 'utf8'))
      expect(alive(pid)).toBe(true)
      await one[how]()
      expect(await one.list()).toEqual([])
      await until(() => !alive(pid))
    })
  }
})
