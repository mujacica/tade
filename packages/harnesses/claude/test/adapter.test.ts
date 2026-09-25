import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAccount, WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter, HOOK_PATH, MCP_PATH, runSocket } from '../src/adapter.ts'
import { sessionIdFor } from '../src/transcript.ts'

// The adapter without Claude Code: its hooks, status line and tool server are
// run as the processes Claude Code would run, against the adapter's socket,
// and what it types is kept instead of reaching a terminal.

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Run a script the way Claude Code runs a hook: JSON in, JSON (or nothing) out. */
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

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  const setUp = async (
    approvals: 'bypass' | 'policy' = 'bypass',
    /** A sign-in beside Claude Code's own: how the money it reports is decided. */
    account_?: HarnessAccount,
  ) => {
    const typed: string[] = []
    const account = tmp('tade-claude-account-')
    const runDir = tmp('tcc-')
    adapter = new ClaudeAdapter({
      runDir,
      configDir: account,
      home: tmp('tade-claude-home-'),
      approvals,
      ...(account_ ? { account: account_ } : {}),
      type: async (_run, text) => {
        typed.push(text)
      },
    })
    const cwd = tmp('tade-claude-cwd-')
    const spec = { run: 'app/refunds/agent', task: 'app/refunds', cwd, prompt: '' }
    const signals: WorkerSignal[] = []
    adapter.onSignal(spec.run, (signal) => signals.push(signal))
    await adapter.supervise(spec)
    const env = {
      TADE_RUN_SOCKET: runSocket(runDir, spec.run),
      TADE_APPROVALS: approvals,
      TADE_RUN_ID: spec.run,
    }
    const hook = (event: Record<string, unknown>) =>
      run(HOOK_PATH, JSON.stringify(event), env).then(({ stdout }) =>
        stdout ? JSON.parse(stdout) : null,
      )
    const kinds = () => signals.map((signal) => signal.type)
    return { adapter, account, typed, signals, kinds, hook, env, spec, runDir }
  }

  describe('the line that starts it', () => {
    it('starts or comes back to the task’s own session, and says the first thing once', () => {
      const one = new ClaudeAdapter({
        runDir: tmp('tcc-'),
        configDir: '/accounts/work',
        home: '/Users/someone',
      })
      const launch = one.launchSpec({
        run: 'app/refunds/agent',
        task: 'app/refunds',
        cwd: '/wt/refunds',
        prompt: 'fix the double charge',
        model: { provider: 'anthropic', id: 'anthropic/claude-sonnet-5' },
        thinking: 'off',
        title: 'Refunds',
      })
      expect(launch.command).toBe('/bin/sh')
      const [, script, , id, look, name, bin, ...rest] = launch.args
      expect(script).toContain('--resume')
      expect(script).toContain('unset ANTHROPIC_API_KEY')
      expect([id, look, name, bin]).toEqual([
        sessionIdFor('app/refunds'),
        '/accounts/work',
        'Refunds',
        'claude',
      ])
      // Several values follow it, so it comes first: never just before the prompt.
      expect(rest[0]).toBe('--mcp-config')
      expect(rest).toContain('bypassPermissions')
      expect(rest.join(' ')).toContain('--model claude-sonnet-5')
      // No "off": the least it has.
      expect(rest.join(' ')).toContain('--effort low')
      expect(launch.opening).toEqual(['fix the double charge'])
      expect(launch.env.CLAUDE_CONFIG_DIR).toBe('/accounts/work')
    })

    it('hands it hooks, a status line and Tade’s tools for this run alone', () => {
      const one = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: tmp('tade-claude-a-') })
      const launch = one.launchSpec({
        run: 'app/t/agent',
        task: 'app/t',
        cwd: '/wt/t',
        prompt: '',
        extras: { instructions: 'You run in Tade.', tools: '/tools.json' },
      })
      const given = (flag: string) => launch.args[launch.args.indexOf(flag) + 1] ?? ''
      const settings = JSON.parse(readFileSync(given('--settings'), 'utf8'))
      expect(Object.keys(settings.hooks)).toEqual(
        expect.arrayContaining([
          'SessionStart',
          'PreToolUse',
          'Stop',
          'StopFailure',
          'Notification',
        ]),
      )
      expect(settings.skipDangerousModePermissionPrompt).toBe(true)
      expect(settings.statusLine.command).toContain('statusline.ts')
      const mcp = JSON.parse(readFileSync(given('--mcp-config'), 'utf8'))
      expect(mcp.mcpServers.tade.args).toEqual([MCP_PATH])
      expect(mcp.mcpServers.tade.env.TADE_EXTENSION_TOOLS).toBe('/tools.json')
      expect(readFileSync(given('--append-system-prompt-file'), 'utf8')).toBe('You run in Tade.')
    })
  })

  describe('what its hooks say', () => {
    it('marks the folder it works in as trusted before it starts', async () => {
      const { account, spec } = await setUp()
      const state = JSON.parse(readFileSync(join(account, '.claude.json'), 'utf8'))
      expect(state.projects[spec.cwd]).toEqual({ hasTrustDialogAccepted: true })
    })

    it('says a turn, from the prompt to the end of it, and names the work from what was asked', async () => {
      const { hook, kinds, signals } = await setUp()
      await hook({ hook_event_name: 'SessionStart', session_id: 's', model: 'claude-opus-5' })
      await hook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Please fix the refund webhook retries',
      })
      await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: 'pnpm test' },
      })
      await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' })
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Fixed it.' })
      expect(kinds()).toEqual([
        'started',
        'turn_started',
        'titled',
        'tool_call',
        'tool_result',
        'message',
        'turn_done',
        'idle',
      ])
      expect(signals.find((s) => s.type === 'titled')).toMatchObject({
        title: 'fix the refund webhook retries',
        named: false,
      })
      expect(signals.find((s) => s.type === 'started')).toMatchObject({ model: 'claude-opus-5' })
    })

    it('does not name the work after a turn it started itself', async () => {
      const { hook, kinds } = await setUp()
      await hook({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>done</task-notification>',
      })
      expect(kinds()).toEqual(['turn_started'])
    })

    it('says why a turn failed, as Claude Code said it', async () => {
      const { hook, signals } = await setUp()
      await hook({
        hook_event_name: 'StopFailure',
        error: 'authentication_failed',
        last_assistant_message: '401 API key is invalid.',
      })
      expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({
        status: 'error',
        reason: 'authentication_failed: 401 API key is invalid.',
      })
    })

    it('reports Tade’s own tools by their own names', async () => {
      const { hook, signals } = await setUp()
      await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__tade__checks_run',
        tool_use_id: 't2',
        tool_input: {},
      })
      expect(signals.find((s) => s.type === 'tool_call')).toMatchObject({ tool: 'checks_run' })
    })

    it('holds nothing when approvals are off', async () => {
      const { hook, kinds } = await setUp('bypass')
      const said = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: 'rm -rf /' },
      })
      expect(said).toBeNull()
      expect(kinds()).toEqual(['tool_call'])
    })

    it('holds a tool call for Tade’s answer under policy, and says it back exactly', async () => {
      const { adapter, hook, signals, spec } = await setUp('policy')
      const answered = hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 't9',
        tool_input: { command: 'git push --force origin main' },
      })
      await until(() => signals.some((s) => s.type === 'permission_request'))
      expect(signals.find((s) => s.type === 'permission_request')).toMatchObject({
        requestId: 't9',
        summary: 'Bash: git push --force origin main',
      })
      await adapter.decide(spec.run, 't9', { allow: false, reason: 'not on main' })
      expect(await answered).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'not on main',
        },
      })
    })

    it('refuses under policy when Tade cannot be asked, and carries on otherwise', async () => {
      const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })
      const nobody = { TADE_RUN_SOCKET: join(tmp('tcc-'), 'gone.sock') }
      const held = await run(HOOK_PATH, event, { ...nobody, TADE_APPROVALS: 'policy' })
      expect(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      const free = await run(HOOK_PATH, event, { ...nobody, TADE_APPROVALS: 'bypass' })
      expect(free).toEqual({ stdout: '', code: 0 })
    })

    it('counts what a turn spent from the transcript, and only what is new', async () => {
      const { hook, signals } = await setUp()
      const transcript = join(tmp('tcc-'), 'session.jsonl')
      const reply = (id: string, output: number) =>
        JSON.stringify({
          type: 'assistant',
          message: { id, model: 'm', usage: { input_tokens: 5, output_tokens: output } },
        })
      writeFileSync(transcript, `${reply('a', 10)}\n`)
      await hook({ hook_event_name: 'SessionStart', transcript_path: transcript })
      await hook({ hook_event_name: 'Stop' })
      writeFileSync(transcript, `${reply('a', 10)}\n${reply('b', 20)}\n`)
      await hook({ hook_event_name: 'Stop' })
      const usage = signals.filter((s) => s.type === 'usage')
      expect(usage.map((s) => (s.type === 'usage' ? s.tokens : 0))).toEqual([15, 25])
    })

    it('counts a turn written after its Stop hook ran, once its status line has drawn it', async () => {
      const { hook, env, signals } = await setUp()
      const transcript = join(tmp('tcc-'), 'session.jsonl')
      writeFileSync(transcript, '')
      await hook({ hook_event_name: 'SessionStart', transcript_path: transcript })
      // Stop runs before the reply is in the transcript: nothing to count yet.
      await hook({ hook_event_name: 'Stop' })
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: 'assistant', message: { id: 'z', model: 'm', usage: { input_tokens: 3, output_tokens: 4 } } })}\n`,
      )
      await run(join(HOOK_PATH, '..', 'statusline.ts'), '{}', env)
      await until(() => signals.some((s) => s.type === 'usage' && s.tokens === 7), 5_000)
    })

    it('says a turn someone cut short in its lane, which no hook reports', async () => {
      const { hook, signals } = await setUp()
      const transcript = join(tmp('tcc-'), 'session.jsonl')
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } })}\n`,
      )
      await hook({ hook_event_name: 'SessionStart', transcript_path: transcript })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })
      expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
    })
  })

  describe('what its status line says', () => {
    const STATUS = (cost: number) =>
      JSON.stringify({
        model: { id: 'claude-opus-5' },
        cost: { total_cost_usd: cost },
        context_window: {
          used_percentage: 20,
          current_usage: { input_tokens: 10, cache_read_input_tokens: 90 },
        },
        rate_limits: { five_hour: { used_percentage: 34, resets_at: 1_800_000_000 } },
      })

    it('is its context and its plan’s limits, and on a plan no money at all', async () => {
      const { adapter, env, signals } = await setUp()
      const statusline = join(HOOK_PATH, '..', 'statusline.ts')
      const drawn = await run(statusline, STATUS(0.25), env)
      expect(drawn.stdout).toContain('20% of context')
      await run(statusline, STATUS(0.4), env)
      expect(signals.find((s) => s.type === 'context')).toMatchObject({ percent: 20, tokens: 100 })
      // A plan charges a flat fee, so the figure Claude Code keeps is its own
      // guess at what an API would have charged and nobody is charged it.
      // What is used up is the plan's windows, which it does report. It says
      // nothing at all rather than a usage of zeros: a line in the journal
      // that says nothing is still a line in the journal.
      expect(adapter.capabilities.spend.usd).toBe('none')
      expect(signals.filter((s) => s.type === 'usage')).toEqual([])
      expect(adapter.limits()?.fiveHour).toEqual({ used: 34, resetsAt: 1_800_000_000_000 })
    })

    it('is its cost as it grows, where an API key is what pays', async () => {
      // Against a key the same estimate is a bill somebody gets, and is worth
      // saying — marked as the estimate it is, and never as a priced figure.
      const { adapter, env, signals } = await setUp('bypass', {
        name: 'billed',
        dir: tmp('tade-claude-billed-'),
        kind: 'api-key',
        key: 'echo sk-test',
      })
      expect(adapter.capabilities.spend.usd).toBe('estimate')
      const statusline = join(HOOK_PATH, '..', 'statusline.ts')
      await run(statusline, STATUS(0.25), env)
      await run(statusline, STATUS(0.4), env)
      const usd = signals.flatMap((s) => (s.type === 'usage' ? [s.usd] : []))
      expect(usd[0]).toBeCloseTo(0.25)
      expect(usd[1]).toBeCloseTo(0.15)
    })

    it('draws its owner’s own status line when they had one', async () => {
      const { env } = await setUp()
      const drawn = await run(join(HOOK_PATH, '..', 'statusline.ts'), '{}', {
        ...env,
        TADE_CLAUDE_STATUSLINE: 'echo mine',
      })
      expect(drawn.stdout.trim()).toBe('mine')
    })
  })

  describe('saying things to it', () => {
    it('types into the running turn, pasted so several lines arrive as one', async () => {
      const { adapter, hook, spec, typed } = await setUp()
      await hook({ hook_event_name: 'SessionStart' })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await adapter.steer(spec.run, 'also check\nthe webhook')
      expect(typed).toEqual(['\x1b[200~also check\nthe webhook\x1b[201~', '\r'])
    })

    it('holds what is queued, and a new name, until the turn ends', async () => {
      const { adapter, hook, spec, typed } = await setUp()
      await hook({ hook_event_name: 'SessionStart' })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await adapter.queue(spec.run, 'then open a PR')
      await adapter.name(spec.run, 'Refund retries')
      expect(typed).toEqual([])
      await hook({ hook_event_name: 'Stop' })
      await until(() => typed.length === 4)
      expect(typed[0]).toContain('/rename Refund retries')
      expect(typed[2]).toContain('then open a PR')
    })

    it('stops a turn with Escape, and says so itself', async () => {
      const { adapter, hook, spec, typed, signals } = await setUp()
      await hook({ hook_event_name: 'SessionStart' })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await adapter.abort(spec.run)
      expect(typed).toEqual(['\x1b'])
      expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
    })

    it('types one thing at a time, however many things are said at once', async () => {
      const { adapter, hook, spec, typed } = await setUp()
      await hook({ hook_event_name: 'SessionStart' })
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      await Promise.all([adapter.steer(spec.run, 'one'), adapter.steer(spec.run, 'two')])
      expect(typed).toEqual(['\x1b[200~one\x1b[201~', '\r', '\x1b[200~two\x1b[201~', '\r'])
    })

    it('never types a model: that would change every new session’s', async () => {
      const { adapter, spec, typed } = await setUp()
      await expect(adapter.setModel(spec.run, { id: 'opus' })).rejects.toThrow(
        /starts the agent again/,
      )
      expect(typed).toEqual([])
    })

    it('points it at a picture it cannot be handed', async () => {
      const { adapter, hook, spec, typed } = await setUp()
      await hook({ hook_event_name: 'SessionStart' })
      await adapter.prompt(spec.run, 'what is wrong here?', [
        { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
      ])
      const said = typed[0] ?? ''
      const path = /\[picture: (.+\.png)\]/.exec(said)?.[1] ?? ''
      expect(readFileSync(path, 'utf8')).toBe('png')
    })
  })

  describe('Tade’s tools', () => {
    it('lends them over MCP, runs them in Tade, and lets it say it is done', async () => {
      const { adapter, env, signals, spec } = await setUp()
      const tools = join(tmp('tcc-'), 'tools.json')
      writeFileSync(
        tools,
        JSON.stringify([
          { name: 'checks_run', description: 'Run the checks.', parameters: { type: 'object' } },
        ]),
      )
      adapter.onSignal(spec.run, (signal) => {
        if (signal.type === 'extension_call') {
          void adapter.answer(spec.run, signal.callId, { ok: true, text: 'all green' })
        }
      })
      const lines = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'checks_run', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'tade_done', arguments: { summary: 'fixed it' } },
        },
      ]
      const server = spawn(process.execPath, [MCP_PATH], {
        env: { ...process.env, ...env, TADE_EXTENSION_TOOLS: tools },
      })
      const answers: Array<{ id: number; result: Record<string, unknown> }> = []
      let buffer = ''
      server.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          answers.push(JSON.parse(buffer.slice(0, end)))
          buffer = buffer.slice(end + 1)
        }
      })
      for (const line of lines) server.stdin.write(`${JSON.stringify(line)}\n`)
      await until(() => answers.length === 4)
      server.kill()
      const by = (id: number) => answers.find((answer) => answer.id === id)?.result
      expect(((by(2)?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'checks_run',
        'tade_done',
      ])
      expect(by(3)).toEqual({ content: [{ type: 'text', text: 'all green' }], isError: false })
      expect(signals.find((s) => s.type === 'done')).toMatchObject({ summary: 'fixed it' })
    })
  })

  describe('its models', () => {
    const one = () => new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: tmp('tade-claude-a-') })

    it('are the names Claude Code keeps for the newest of each line', async () => {
      expect((await one().models()).map((model) => model.id)).toEqual([
        'anthropic/opus',
        'anthropic/sonnet',
        'anthropic/fable',
        'anthropic/haiku',
      ])
    })

    it('are found the way people say them, and a full name is taken as said', async () => {
      const adapter = one()
      expect(await adapter.resolveModel('opus 5')).toEqual({
        ok: true,
        provider: 'anthropic',
        id: 'opus',
      })
      expect(await adapter.resolveModel('the Sonnet model')).toMatchObject({ id: 'sonnet' })
      expect(await adapter.resolveModel('claude-opus-5[1m]')).toMatchObject({
        id: 'claude-opus-5[1m]',
      })
      const other = await adapter.resolveModel('gpt 5')
      expect(other.ok).toBe(false)
    })
  })

  describe('its accounts', () => {
    it('makes a second one ready: its own folder, your settings linked in, first run done', async () => {
      const home = tmp('tade-claude-home-')
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}')
      const dir = join(tmp('tade-accounts-'), 'work')
      const work = new ClaudeAdapter({
        runDir: tmp('tcc-'),
        home,
        account: { name: 'work', dir, kind: 'subscription' },
      })
      await work.prepareAccount(true)
      expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
      expect(lstatSync(join(dir, 'skills')).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual({
        hasCompletedOnboarding: true,
      })
      // Never its sign-in: that is what makes it a second account.
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    })

    it('signs in with Claude Code’s own sign-in, pointed at its folder', () => {
      const dir = '/accounts/work'
      const work = new ClaudeAdapter({
        runDir: tmp('tcc-'),
        account: { name: 'work', dir, kind: 'subscription' },
      })
      expect(work.signIn()?.launch).toEqual({
        command: 'claude',
        args: ['auth', 'login', '--claudeai'],
        env: { CLAUDE_CONFIG_DIR: dir },
      })
    })

    it('pays with a key read when it is needed, never written into the launch', async () => {
      const keyed = new ClaudeAdapter({
        runDir: tmp('tcc-'),
        account: { name: 'ci', dir: tmp('tade-acct-'), kind: 'api-key', key: "print-key 'ci'" },
      })
      expect(keyed.signIn()).toBeNull()
      expect(await keyed.account()).toMatchObject({ signedIn: true, method: 'api-key' })
      const launch = keyed.launchSpec({ run: 'a/t/agent', task: 'a/t', cwd: '/wt', prompt: '' })
      const settings = JSON.parse(
        readFileSync(launch.args[launch.args.indexOf('--settings') + 1] ?? '', 'utf8'),
      )
      expect(settings.apiKeyHelper).toBe("print-key 'ci'")
      expect(JSON.stringify(launch)).not.toContain('sk-')
    })

    it('carries a conversation to another account, so the agent goes on there', async () => {
      const a = tmp('tade-acct-')
      const b = tmp('tade-acct-')
      const from = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: a })
      const to = new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: b })
      const id = sessionIdFor('app/refunds')
      mkdirSync(join(a, 'projects', '-wt-refunds', id, 'subagents'), { recursive: true })
      writeFileSync(join(a, 'projects', '-wt-refunds', `${id}.jsonl`), '{"said":"hi"}\n')
      writeFileSync(join(a, 'projects', '-wt-refunds', id, 'subagents', 's.jsonl'), '{}\n')
      expect(await from.carryConversation('app/refunds', '/wt/refunds', to)).toBe(true)
      expect(await to.hasConversation('app/refunds', '/wt/refunds')).toBe(true)
      expect(existsSync(join(b, 'projects', '-wt-refunds', id, 'subagents', 's.jsonl'))).toBe(true)
      expect(await from.carryConversation('app/none', '/wt/none', to)).toBe(false)
    })
  })

  it('has a conversation once Claude Code has written its transcript', async () => {
    const { adapter, account, spec } = await setUp()
    expect(await adapter.hasConversation(spec.task, spec.cwd)).toBe(false)
    mkdirSync(join(account, 'projects', 'x'), { recursive: true })
    writeFileSync(join(account, 'projects', 'x', `${sessionIdFor(spec.task)}.jsonl`), '')
    expect(await adapter.hasConversation(spec.task, spec.cwd)).toBe(true)
  })
})
