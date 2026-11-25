import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAccount, WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { GrokAdapter, HOOK_PATH, MCP_PATH, runSocket, STATUSLINE_PATH } from '../src/adapter.ts'
import { missedPath } from '../src/missed.ts'
import { sessionIdFor } from '../src/record.ts'

// The adapter without Grok: its hooks, status line and tool server are run as
// the processes Grok would run, against the adapter's socket, and what it
// types is kept instead of reaching a terminal. What Grok itself does with
// them is `live-lane.test.ts`, against the real binary.

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Run a script the way Grok runs a hook: JSON in, JSON (or nothing) out. */
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

/** A hook's event as Grok sends it: its own fields beside Claude Code's. */
function event(name: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hookEventName: name.replace(/[A-Z]/g, (c, at) => (at ? '_' : '') + c.toLowerCase()),
    hook_event_name: name,
    session_id: 'abc',
    sessionId: 'abc',
    cwd: '/work',
    permission_mode: 'bypassPermissions',
    ...fields,
  })
}

/** A stand-in `grok` that says how it was started, for reading the launch line back. */
function standIn(dir: string): string {
  const bin = join(dir, 'grok')
  writeFileSync(
    bin,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own expansion, not a template
    '#!/bin/sh\nprintf "%s\\n" "GROK_HOME=$GROK_HOME" "XAI_API_KEY=${XAI_API_KEY-unset}" "CLAUDECODE=${CLAUDECODE-unset}" "$@"\n',
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('GrokAdapter', () => {
  let adapter: GrokAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  const setUp = async (approvals: 'bypass' | 'policy' = 'bypass', account?: HarnessAccount) => {
    const typed: string[] = []
    const grokHome = account?.dir ?? tmp('tade-grok-account-')
    const runDir = tmp('tade-grok-runs-')
    const one = new GrokAdapter({
      runDir,
      grokHome,
      home: tmp('tade-grok-home-'),
      approvals,
      ...(account ? { account } : {}),
      type: async (_run, text) => {
        typed.push(text)
      },
    })
    adapter = one
    const cwd = tmp('tade-grok-cwd-')
    const spec = { run: 'app/refunds/agent', task: 'app/refunds', cwd, prompt: '' }
    const signals: WorkerSignal[] = []
    one.onSignal(spec.run, (signal) => signals.push(signal))
    await one.supervise(spec)
    const env = {
      TADE_RUN_SOCKET: runSocket(runDir, spec.run),
      TADE_APPROVALS: approvals,
      TADE_RUN_ID: spec.run,
      TADE_TASK_ID: spec.task,
    }
    return { one, spec, signals, env, typed, grokHome, runDir }
  }

  describe('the line that starts it', () => {
    it('starts a session under the task’s id, and comes back to it once Grok has it', async () => {
      const bin = standIn(tmp('tade-grok-bin-'))
      const grokHome = tmp('tade-grok-account-')
      const one = new GrokAdapter({
        runDir: tmp('tade-grok-runs-'),
        grokHome,
        bin,
        home: tmp('tade-grok-home-'),
      })
      adapter = one
      const spec = {
        run: 'app/a/agent',
        task: 'app/a',
        cwd: tmp('tade-grok-cwd-'),
        prompt: 'do the thing',
        model: { provider: 'xai', id: 'xai/grok-4.6' },
        thinking: 'off' as const,
        extras: { instructions: 'You run in Tade.' },
      }
      const said = (launch = one.launchSpec(spec)) =>
        execFileSync(launch.command, [...launch.args, ...(launch.opening ?? [])], {
          env: { ...process.env, ...launch.env, XAI_API_KEY: 'sk-theirs', CLAUDECODE: '1' },
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
      const id = sessionIdFor(spec.task)
      const first = said()
      expect(first.slice(0, 3)).toEqual([
        `GROK_HOME=${grokHome}`,
        'XAI_API_KEY=unset',
        'CLAUDECODE=unset',
      ])
      expect(first.slice(3)).toEqual([
        '-s',
        id,
        '--rules',
        'You run in Tade.',
        '--permission-mode',
        'bypassPermissions',
        '-m',
        'grok-4.6',
        '--reasoning-effort',
        'none',
        'do the thing',
      ])
      // Grok has the session now: the same line comes back to it.
      mkdirSync(join(grokHome, 'sessions', encodeURIComponent(spec.cwd), id), { recursive: true })
      expect(said().slice(3, 5)).toEqual(['-r', id])
      // And a reopen says nothing first.
      expect(one.launchSpec({ ...spec, prompt: '' }).opening).toBeUndefined()
    })

    it('pays with an API-key account’s key, read by its command, never written on the line', async () => {
      const bin = standIn(tmp('tade-grok-bin-'))
      // As `secretCommand` is: a command that prints the key from where Tade keeps it.
      const kept = join(tmp('tade-grok-keys-'), 'key')
      writeFileSync(kept, 'sk-from-tade\n')
      const account: HarnessAccount = {
        name: 'xai',
        dir: tmp('tade-grok-account-'),
        kind: 'api-key',
        key: `cat '${kept}'`,
      }
      const one = new GrokAdapter({
        runDir: tmp('tade-grok-runs-'),
        bin,
        account,
        home: tmp('tade-grok-home-'),
      })
      adapter = one
      const launch = one.launchSpec({
        run: 'a/b/agent',
        task: 'a/b',
        cwd: tmp('tade-grok-cwd-'),
        prompt: '',
      })
      expect(launch.args.join(' ')).not.toContain('sk-from-tade')
      const out = execFileSync(launch.command, launch.args, {
        env: { ...process.env, ...launch.env },
        encoding: 'utf8',
      })
      expect(out).toContain('XAI_API_KEY=sk-from-tade')
      expect(one.capabilities.spend.usd).toBe('exact')
      expect(one.signIn()).toBeNull()
    })

    it('switches off what Grok would bring in from Claude Code and Cursor, and its updater', async () => {
      const { one, spec } = await setUp()
      const env = one.launchSpec(spec).env
      expect(env).toMatchObject({
        GROK_CLAUDE_HOOKS_ENABLED: 'false',
        GROK_CLAUDE_MCPS_ENABLED: 'false',
        GROK_CURSOR_HOOKS_ENABLED: 'false',
        GROK_CURSOR_MCPS_ENABLED: 'false',
        GROK_DISABLE_AUTOUPDATER: '1',
      })
    })
  })

  describe('its account folder', () => {
    it('holds Tade’s hooks, tool server and status line, and trusts the folder it works in', async () => {
      const { grokHome, spec } = await setUp('policy')
      const hooks = JSON.parse(readFileSync(join(grokHome, 'hooks', 'tade.json'), 'utf8'))
      expect(Object.keys(hooks.hooks)).toEqual(
        expect.arrayContaining([
          'SessionStart',
          'PreToolUse',
          'Stop',
          'StopFailure',
          'StopCancelled',
        ]),
      )
      expect(hooks.hooks.PreToolUse[0].hooks[0]).toMatchObject({
        timeout: 86_400,
        failClosed: true,
      })
      expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain(HOOK_PATH)
      const config = readFileSync(join(grokHome, 'config.toml'), 'utf8')
      expect(config).toContain('[mcp_servers.tade]')
      expect(config).toContain(MCP_PATH)
      expect(config).toContain(STATUSLINE_PATH)
      const trusted = readFileSync(join(grokHome, 'trusted_folders.toml'), 'utf8')
      expect(trusted).toContain(`[folders."${realpathSync(spec.cwd)}"]`)
      expect(trusted).toContain('trusted = true')
    })

    it('lets a broken hook through under bypass, where nothing was going to be held', async () => {
      const { grokHome } = await setUp('bypass')
      const hooks = JSON.parse(readFileSync(join(grokHome, 'hooks', 'tade.json'), 'utf8'))
      expect(hooks.hooks.PreToolUse[0].hooks[0].failClosed).toBeUndefined()
    })

    it('signs in with grok login in its own folder, and asks for a code where there is no browser', async () => {
      const { one, grokHome } = await setUp()
      expect(one.signIn({ browser: true })?.launch).toEqual({
        command: 'grok',
        args: ['login'],
        env: { GROK_HOME: grokHome },
      })
      expect(one.signIn({ browser: false })?.launch.args).toEqual(['login', '--device-auth'])
    })
  })

  describe('what its hooks say', () => {
    it('says it started, its turn, and its title', async () => {
      const { signals, env } = await setUp()
      await run(HOOK_PATH, event('SessionStart', { source: 'new' }), env)
      await run(
        HOOK_PATH,
        event('UserPromptSubmit', { prompt: 'please fix the refunds page', promptId: 'p1' }),
        env,
      )
      expect(signals.map((s) => s.type)).toEqual(['started', 'turn_started', 'titled'])
      expect(signals[0]).toMatchObject({ sessionId: 'abc' })
      expect(signals[2]).toMatchObject({ title: 'fix the refunds page' })
    })

    it('holds a tool call under approvals and says Tade’s answer back as Grok reads one', async () => {
      const { one, signals, env, spec } = await setUp('policy')
      await run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'go', promptId: 'p1' }), env)
      const hook = run(
        HOOK_PATH,
        event('PreToolUse', {
          tool_name: 'run_terminal_command',
          tool_input: { command: 'rm -rf build', description: 'clean' },
          tool_use_id: 'call_1',
        }),
        env,
      )
      await until(() => signals.some((s) => s.type === 'permission_request'))
      expect(signals.find((s) => s.type === 'permission_request')).toMatchObject({
        requestId: 'call_1',
        tool: 'run_terminal_command',
        summary: 'run_terminal_command: rm -rf build',
      })
      expect(one.effectOf('run_terminal_command')).toBe('exec')
      await one.decide(spec.run, 'call_1', { allow: false, reason: 'not here' })
      const { stdout } = await hook
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'not here',
        },
      })
    })

    it('says a call of one of Tade’s own tools by its own name, with its own input', async () => {
      const { signals, env } = await setUp()
      // Reached through Grok's `use_tool`, whose input is still around the tool's.
      await run(
        HOOK_PATH,
        event('PreToolUse', {
          tool_name: 'tade__checks_run',
          tool_input: { tool_name: 'tade__checks_run', tool_input: { related: true } },
          tool_use_id: 'c2',
        }),
        env,
      )
      expect(signals.find((s) => s.type === 'tool_call')).toMatchObject({
        tool: 'checks_run',
        input: { related: true },
      })
    })

    it('begins once, whichever of its first hooks reaches Tade first, and a late one undoes nothing', async () => {
      const { signals, env } = await setUp()
      // Each hook is its own process: on a loaded machine the prompt's can win.
      await run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'go', promptId: 'p1' }), env)
      await run(HOOK_PATH, event('SessionStart', { source: 'new' }), env)
      await run(HOOK_PATH, event('Stop', { reason: 'end_turn', promptId: 'p1' }), env)
      expect(signals.map((s) => s.type).filter((t) => t !== 'titled')).toEqual([
        'started',
        'turn_started',
        'turn_done',
        'idle',
      ])
    })

    it('ends a turn once for each of the three ways Grok ends one, and never for a closing session', async () => {
      const { signals, env } = await setUp()
      const begin = (id: string) =>
        run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'go', promptId: id }), env)
      await begin('p1')
      await run(
        HOOK_PATH,
        event('Stop', { reason: 'end_turn', promptId: 'p1', last_assistant_message: 'Done.' }),
        env,
      )
      await begin('p2')
      await run(
        HOOK_PATH,
        event('StopFailure', { promptId: 'p2', error: 'rate_limit', errorDetails: '429' }),
        env,
      )
      await begin('p3')
      await run(
        HOOK_PATH,
        event('StopCancelled', { promptId: 'p3', reason: 'user_interrupt' }),
        env,
      )
      // As the session closes, a Stop with no turn behind it.
      await run(HOOK_PATH, event('Stop', { reason: 'shutdown' }), env)
      const ends = signals.filter((s) => s.type === 'turn_done')
      expect(ends.map((s) => ('status' in s ? s.status : null))).toEqual(['ok', 'error', 'aborted'])
      expect(ends[1]).toMatchObject({ reason: 'rate_limit: 429' })
      expect(signals.find((s) => s.type === 'message')).toMatchObject({ text: 'Done.' })
    })

    it('takes a late word about a turn that is over for nothing', async () => {
      const { signals, env } = await setUp()
      await run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'go', promptId: 'p2' }), env)
      // A cancelled turn's report, dispatched off Grok's loop, after the next began.
      await run(HOOK_PATH, event('StopCancelled', { promptId: 'p1' }), env)
      expect(signals.some((s) => s.type === 'turn_done')).toBe(false)
    })

    it('says how full its context is, from what its status line was given', async () => {
      const { signals, env } = await setUp()
      await run(
        STATUSLINE_PATH,
        JSON.stringify({
          model: { id: 'grok-4.6', display_name: 'Grok 4.6' },
          context_window: {
            context_window_size: 500_000,
            context_tokens: 60_000,
            used_percentage: 12,
          },
        }),
        env,
      )
      expect(signals.find((s) => s.type === 'context')).toMatchObject({
        tokens: 60_000,
        percent: 12,
      })
    })
  })

  describe('a window that was not there', () => {
    it('keeps the end of a turn nobody heard, and says it once to the window that comes back', async () => {
      const runDir = tmp('tade-grok-runs-')
      const socket = runSocket(runDir, 'app/away/agent')
      const env = { TADE_RUN_SOCKET: socket, TADE_APPROVALS: 'bypass' }
      // Nobody listening: what ended is left beside the socket.
      await run(HOOK_PATH, event('Stop', { reason: 'end_turn' }), env)
      await run(HOOK_PATH, event('Stop', { reason: 'shutdown' }), env)
      expect(JSON.parse(readFileSync(missedPath(socket), 'utf8')).event.reason).toBe('end_turn')
      const one = new GrokAdapter({
        runDir,
        grokHome: tmp('tade-grok-acct-'),
        home: tmp('tade-grok-home-'),
      })
      adapter = one
      const signals: WorkerSignal[] = []
      const spec = {
        run: 'app/away/agent',
        task: 'app/away',
        cwd: tmp('tade-grok-cwd-'),
        prompt: '',
      }
      one.onSignal(spec.run, (signal) => signals.push(signal))
      await one.supervise({ ...spec, alreadyRunning: true })
      await until(() => signals.some((s) => s.type === 'idle'))
      expect(signals.map((s) => s.type)).toEqual(['turn_done', 'idle'])
    })
  })

  describe('what is said to it', () => {
    it('types a message pasted, then Enter, and stops a turn with Ctrl+C, clearing the line after', async () => {
      const { one, spec, env, typed, signals } = await setUp()
      await run(HOOK_PATH, event('SessionStart', { source: 'new' }), env)
      await one.prompt(spec.run, 'two\nlines')
      expect(typed.slice(-2)).toEqual(['\x1b[200~two\nlines\x1b[201~', '\r'])
      await run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'two', promptId: 'p1' }), env)
      await one.abort(spec.run)
      expect(typed.slice(-2)).toEqual(['\x03', '\x03'])
      expect(signals.filter((s) => s.type === 'turn_done')).toEqual([
        expect.objectContaining({ status: 'aborted' }),
      ])
      // Grok's own word that it stopped, after Tade's: not a second end.
      await run(HOOK_PATH, event('StopCancelled', { promptId: 'p1' }), env)
      expect(signals.filter((s) => s.type === 'turn_done')).toHaveLength(1)
    })
  })

  describe('what it used', () => {
    it('says a count that failed rather than dropping it', async () => {
      const warnings: string[] = []
      const grokHome = tmp('tade-grok-account-')
      const runDir = tmp('tade-grok-runs-')
      const one = new GrokAdapter({
        runDir,
        grokHome,
        bin: standIn(tmp('tade-grok-bin-')),
        home: tmp('tade-grok-home-'),
        onWarning: (message) => warnings.push(message),
      })
      adapter = one
      const spec = { run: 'app/c/agent', task: 'app/c', cwd: tmp('tade-grok-cwd-'), prompt: '' }
      await one.supervise(spec)
      // A record that is there and cannot be read: a folder where the file goes.
      mkdirSync(join(grokHome, 'sessions', 'x', sessionIdFor(spec.task), 'updates.jsonl'), {
        recursive: true,
      })
      const env = { TADE_RUN_SOCKET: runSocket(runDir, spec.run), TADE_RUN_ID: spec.run }
      await run(HOOK_PATH, event('UserPromptSubmit', { prompt: 'go', promptId: 'p1' }), env)
      await until(() => warnings.some((w) => w.startsWith('could not count')))
      expect(warnings.find((w) => w.startsWith('could not count'))).toMatch(/EISDIR/)
    })
  })

  describe('its tool server', () => {
    it('says what an agent left before it says the task is done', async () => {
      const { signals, env, one, spec } = await setUp()
      one.onSignal(spec.run, (signal) => {
        if (signal.type === 'extension_call') {
          void one.answer(spec.run, signal.callId, { ok: true, text: 'parked 1' })
        }
      })
      const server = spawn(process.execPath, [MCP_PATH], { env: { ...process.env, ...env } })
      let out = ''
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      const send = (m: unknown) => server.stdin.write(`${JSON.stringify(m)}\n`)
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'tade_done',
          arguments: {
            summary: 'did it',
            leftovers: [{ title: 'a flaky test', why: 'it flakes' }],
          },
        },
      })
      await until(() => out.includes('"id":3'), 10_000)
      server.kill()
      const calls = signals.filter((s) => s.type === 'extension_call' || s.type === 'done')
      expect(calls.map((s) => s.type)).toEqual(['extension_call', 'done'])
      expect(calls[0]).toMatchObject({ tool: 'tade_leftovers' })
      expect(out).toContain('"name":"tade_done"')
    })

    /** The tool server started on its own, as Grok would start it: what it said, and how it ended. */
    const serve = (env: Record<string, string>, lines: string[] = []) => {
      const server = spawn(process.execPath, [MCP_PATH], {
        env: { ...process.env, TADE_RUN_SOCKET: '', ...env },
      })
      const said = { out: '', err: '', code: undefined as number | null | undefined }
      server.stdout.on('data', (chunk: Buffer) => {
        said.out += chunk.toString('utf8')
      })
      server.stderr.on('data', (chunk: Buffer) => {
        said.err += chunk.toString('utf8')
      })
      server.on('exit', (code) => {
        said.code = code
      })
      for (const line of lines) server.stdin.write(`${line}\n`)
      return { server, said }
    }

    it('says a list of tools it could not read, and still offers its own', async () => {
      const missing = join(tmp('tade-grok-tools-'), 'gone.json')
      const { server, said } = serve({ TADE_EXTENSION_TOOLS: missing }, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      ])
      await until(() => said.out.includes('"id":1') && said.err.includes(missing), 10_000)
      server.kill()
      expect(said.err).toContain(`could not read the extension tools in ${missing}`)
      expect(said.err).toContain('ENOENT')
      expect(said.out).toContain('"name":"tade_done"')
    })

    it('answers a line that is not JSON with a parse error', async () => {
      const { server, said } = serve({}, ['not json'])
      await until(() => said.out.includes('-32700'), 10_000)
      server.kill()
      expect(JSON.parse(said.out.trim())).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700 },
      })
    })

    it('says why the server a headless run was handed could not be started', async () => {
      const dir = tmp('tade-grok-handed-')
      const missing = join(dir, 'gone.mcp.json')
      const gone = serve({ TADE_GROK_MCP: missing })
      await until(() => gone.said.code !== undefined, 10_000)
      expect(gone.said.code).toBe(1)
      expect(gone.said.err).toContain(`could not read ${missing}`)
      const empty = join(dir, 'empty.mcp.json')
      writeFileSync(empty, JSON.stringify({ mcpServers: {} }))
      const none = serve({ TADE_GROK_MCP: empty })
      await until(() => none.said.code !== undefined, 10_000)
      expect(none.said.code).toBe(1)
      expect(none.said.err).toContain(`${empty} names no MCP server this can start`)
    })
  })
})
