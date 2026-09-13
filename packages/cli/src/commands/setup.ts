import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline/promises'
import {
  defaultConfigPath,
  isReady,
  loadConfig,
  type ReadinessFacts,
  readiness,
  type Step,
  wilcoHome,
} from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { socketPath } from '@wilco/daemon/protocol'
import { piBinary } from '@wilco/harness-pi'
import { makeRecorder, makeTranscriber } from '@wilco/stt'
import type { Command } from 'commander'
import { parse, stringify } from 'yaml'
import { Exit, type Io } from '../io.ts'

// The first minute.
//
// A fresh machine has no config, no model and no daemon. What decides whether
// somebody keeps this tool is whether that first minute tells them what to do
// or shows them an empty screen, so `wilco app` runs this when it has to and
// nothing else has to be read first.

/** Provider keys the harness can use without being logged in. */
const API_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
]

export async function gather(cwd = process.cwd()): Promise<ReadinessFacts> {
  const loaded = await loadConfig(defaultConfigPath())
  const config = loaded.ok ? loaded.config : null
  const voice = config?.surfaces.voice
  const [mic, speech] = await Promise.all([
    makeRecorder(voice?.mic ?? {}).available(),
    makeTranscriber(voice?.stt ?? {}).available(),
  ])
  return {
    configExists: loaded.ok && loaded.exists,
    projects: Object.keys(config?.projects ?? {}),
    cwd,
    cwdIsRepo: existsSync(join(cwd, '.git')),
    loggedIn: piLoggedIn(),
    apiKeys: API_KEYS.filter((name) => (process.env[name] ?? '').length > 0),
    orchestratorModel: config?.orchestrator.model ?? null,
    daemonRunning: await DaemonClient.isRunning(socketPath()),
    micOk: mic.ok,
    speechOk: speech.ok,
    speechReason: speech.ok ? null : speech.reason,
  }
}

/** The harness keeps its credentials; an empty file means nobody is logged in. */
function piLoggedIn(home = process.env.HOME ?? ''): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8'))
    return typeof auth === 'object' && auth !== null && Object.keys(auth).length > 0
  } catch {
    return false
  }
}

function render(steps: readonly Step[]): string[] {
  return steps.map((step) => {
    const mark = step.done ? '✓' : step.required ? '·' : '○'
    return `  ${mark} ${step.title}${step.detail ? ` — ${step.detail}` : ''}`
  })
}

export function registerSetup(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('setup')
    .description('Set Wilco up: a project, a model, the daemon, and speech if you want it')
    .option('--check', 'report what is missing and exit, changing nothing')
    .action(async (opts: { check?: boolean }) => {
      const facts = await gather()
      const steps = readiness(facts)

      if (opts.check) {
        for (const line of render(steps)) io.out(line)
        if (!isReady(steps)) setExit(Exit.error)
        return
      }

      if (isReady(steps) && steps.every((s) => s.done)) {
        io.out('Everything is set up.')
        for (const line of render(steps)) io.out(line)
        return
      }

      if (!process.stdin.isTTY) {
        // Nothing to type into: say what is missing rather than hanging on a
        // question nobody can answer.
        io.err('setup needs a terminal. What is missing:')
        for (const line of render(steps)) io.err(line)
        setExit(Exit.error)
        return
      }

      io.out("Let's get you set up. Enter accepts the suggestion; ctrl+c stops.")
      io.out('')
      for (const line of render(steps)) io.out(line)
      io.out('')

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        for (const step of steps) {
          if (step.done) continue
          if (step.id === 'project') await setUpProject(rl, io, facts)
          if (step.id === 'model') await setUpModel(rl, io)
          if (step.id === 'daemon') await startDaemon(io)
          if (step.id === 'voice') await setUpVoice(rl, io, facts)
        }
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
        return
      } finally {
        rl.close()
      }

      io.out('')
      const after = readiness(await gather())
      for (const line of render(after)) io.out(line)
      io.out('')
      io.out(isReady(after) ? 'Ready. Run `wilco app`.' : 'Still missing something — see above.')
      if (!isReady(after)) setExit(Exit.error)
    })
}

async function setUpProject(rl: Interface, io: Io, facts: ReadinessFacts): Promise<void> {
  io.out('A project is a git repository Wilco can start tasks in.')
  const suggested = facts.cwdIsRepo ? facts.cwd : ''
  const answer = (await ask(rl, `  repository path${suggested ? ` [${suggested}]` : ''}: `)).trim()
  const root = resolve(answer || suggested)
  if (!root || !existsSync(join(root, '.git'))) {
    throw new Error(`${root || 'nothing'} is not a git repository`)
  }
  const fallback = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
  const name = (await ask(rl, `  call it what? [${fallback}]: `)).trim() || fallback
  patchConfig((config) => {
    config.projects = { ...(config.projects ?? {}), [name]: { root } }
  })
  io.out(`  added ${name} → ${root}`)
}

async function setUpModel(rl: Interface, io: Io): Promise<void> {
  if (!piLoggedIn() && API_KEYS.every((name) => !process.env[name])) {
    io.out('Wilco holds no credentials of its own — the harness does.')
    io.out('  1. log in to a subscription (Claude, ChatGPT, Copilot, …)')
    io.out('  2. use an API key from the environment')
    const choice = (await ask(rl, '  which? [1]: ')).trim() || '1'
    if (choice === '1') {
      io.out('')
      io.out('Opening the harness. Type /login, pick your provider, then /exit.')
      await runPi()
      if (!piLoggedIn()) throw new Error('still not logged in — run `wilco setup` again')
      io.out('  logged in')
    } else {
      io.out(`  set one of: ${API_KEYS.join(', ')}`)
      throw new Error('set the key in your shell, then run `wilco setup` again')
    }
  }

  const model = (await ask(rl, '  model for the orchestrator [claude-opus-5]: ')).trim()
  patchConfig((config) => {
    config.orchestrator = { ...(config.orchestrator ?? {}), model: model || 'claude-opus-5' }
  })
  io.out(`  orchestrator will use ${model || 'claude-opus-5'}`)
}

async function startDaemon(io: Io): Promise<void> {
  const bin = new URL('../bin.ts', import.meta.url).pathname
  const child = spawn(process.execPath, [bin, 'daemon', 'start'], { stdio: 'ignore' })
  await new Promise<void>((done) => child.once('exit', () => done()))
  io.out(
    (await DaemonClient.isRunning(socketPath()))
      ? '  daemon started'
      : '  daemon did not start — try `wilco daemon start` to see why',
  )
}

async function setUpVoice(rl: Interface, io: Io, facts: ReadinessFacts): Promise<void> {
  io.out(`Speech is optional — ${facts.speechReason ?? 'not set up'}.`)
  if ((await ask(rl, '  set it up now? [y/N]: ')).trim().toLowerCase() !== 'y') {
    io.out('  skipped — ctrl+space still opens a line you can type into')
    return
  }
  io.out('  run: brew install whisper-cpp ffmpeg && wilco voice setup')
}

/** Run the harness attached to this terminal, so the user can log in. */
async function runPi(): Promise<void> {
  const child = spawn(process.execPath, [piBinary()], { stdio: 'inherit' })
  await new Promise<void>((done) => child.once('exit', () => done()))
}

/** Read, change and write `config.yaml`, keeping whatever else is in it. */
function patchConfig(change: (config: Record<string, unknown>) => void): void {
  const path = defaultConfigPath()
  let config: Record<string, unknown> = {}
  try {
    config = (parse(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {}
  } catch {
    // No config yet, or one we cannot read: this writes a fresh one.
  }
  change(config)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(wilcoHome(), { recursive: true })
  writeFileSync(path, stringify(config))
}

/**
 * A question that ends if the input does. `readline.question` never settles on
 * EOF, so ctrl+D would otherwise hang the whole wizard.
 */
async function ask(rl: Interface, prompt: string): Promise<string> {
  return Promise.race([
    rl.question(prompt),
    new Promise<string>((_, reject) => rl.once('close', () => reject(new Error('setup stopped')))),
  ])
}
