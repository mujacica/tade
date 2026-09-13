import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'
import { runScreen, ScreenCancelled, type Ui } from '@wilco/app'
import {
  defaultConfigPath,
  isReady,
  loadConfig,
  type ReadinessFacts,
  readiness,
  resolveCommand,
  type Step,
  stringEnv,
  wilcoHome,
} from '@wilco/core'
import { piBinary, usableModels } from '@wilco/harnesses-pi'
import { makeRecorder, makeTranscriber } from '@wilco/voice-stt'
import { drivers } from '@wilco/workbench'
import type { Command } from 'commander'
import { parse, stringify } from 'yaml'
import { Exit, type Io } from '../io.ts'
import { WHISPER_MODELS } from './voice.ts'

// The first minute.
//
// A fresh machine has no config and no model. What decides whether
// somebody keeps this tool is whether that first minute tells them what to do
// or shows them an empty screen, so `wilco app` runs this when it has to and
// nothing else has to be read first.

/** The config as written, for telling a choice apart from a default. */
function readConfigText(): string {
  try {
    return readFileSync(defaultConfigPath(), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Offer to install something, and do it if they say yes.
 *
 * Printing a command and leaving somebody to it is where setup wizards lose
 * people: the whole point of being asked is not having to go and find out how.
 * Only offered where we know how — elsewhere it says the name and moves on,
 * because a wrong install command is worse than none.
 */
async function offerInstall(ui: Ui, what: { name: string; packages: string[] }): Promise<boolean> {
  const manager = installer()
  if (!manager) {
    ui.say(`  install ${what.packages.join(' and ')} and run \`wilco setup\` again`)
    return false
  }
  const command = `${manager.join(' ')} ${what.packages.join(' ')}`
  if (!(await ui.confirm(`install ${what.name}? runs \`${command}\``, true))) {
    ui.say(`  skipped — \`${command}\` when you want it`)
    return false
  }
  const [bin, ...args] = [...manager, ...what.packages]
  // In the window, like everything else: an installer that takes the terminal
  // is an installer whose output you cannot see and whose prompts you cannot
  // answer, because Wilco is still holding the keyboard.
  const code = await ui.run(command, bin!, args)
  if (code !== 0) {
    ui.say(`  that did not work — run \`${command}\` yourself and try again`)
    return false
  }
  return true
}

/** How this machine installs things, if we know. */
function installer(): string[] | null {
  if (process.platform === 'darwin' && which('brew')) return ['brew', 'install']
  if (which('apt-get')) return ['sudo', 'apt-get', 'install', '-y']
  return null
}

/** On the PATH and executable. The same lookup a lane does before spawning. */
function which(command: string): boolean {
  return resolveCommand(command, stringEnv(process.env)) !== null
}

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
  const driver = config?.workspace.driver ?? 'pty'
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
    driver,
    driverOk: await driverAvailable(driver),
    // Read from the file rather than the parsed config, which supplies a
    // default: the question is whether a person chose, not what is in effect.
    driverChosen: /^\s*driver:/m.test(readConfigText()),
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
    .description(
      'Set Wilco up: a project, a model, somewhere to run agents, and speech if you want it',
    )
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

      const stuck: string[] = []
      const flow = runScreen({ title: 'Setting up', context: render(steps) }, async (ui) => {
        for (const step of steps) {
          if (step.done) continue
          try {
            if (step.id === 'project') await setUpProject(ui, facts)
            if (step.id === 'model') await setUpModel(ui)
            if (step.id === 'workspace') await setUpWorkspace(ui)
            if (step.id === 'voice') await setUpVoice(ui, facts)
          } catch (err) {
            // One step that cannot be finished is not a reason to abandon the
            // others: somebody who has to go and export an API key should
            // still come back to a configured project and a chosen driver.
            stuck.push(`${step.title}: ${err instanceof Error ? err.message : String(err)}`)
            ui.say(`  ${step.title}: ${err instanceof Error ? err.message : String(err)}`)
          }
          // The checklist is the point of the screen: it has to move as the
          // answers land, or it is a picture of the machine you arrived with.
          ui.context(render(readiness(await gather())))
        }
      })
      try {
        await flow
      } catch (err) {
        // ctrl+c is how you leave a terminal program, not a failure: whatever
        // was answered before it is already written down.
        if (!(err instanceof ScreenCancelled)) throw err
        io.out('Stopped. What you answered is saved.')
        return
      }

      for (const problem of stuck) io.err(`  ${problem}`)
      const after = readiness(await gather())
      for (const line of render(after)) io.out(line)
      io.out('')
      io.out(isReady(after) ? 'Ready. Run `wilco`.' : 'Still missing something — see above.')
      if (!isReady(after)) setExit(Exit.error)
    })
}

async function setUpProject(ui: Ui, facts: ReadinessFacts): Promise<void> {
  ui.say('A project is a git repository Wilco can start tasks in.')
  const suggested = facts.cwdIsRepo ? facts.cwd : ''
  const answer = await ui.ask('repository path', suggested)
  const root = resolve(answer)
  if (!root || !existsSync(join(root, '.git'))) {
    throw new Error(`${root || 'nothing'} is not a git repository`)
  }
  const fallback = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
  const name = await ui.ask('call it what?', fallback)
  patchConfig((config) => {
    config.projects = { ...(config.projects ?? {}), [name]: { root } }
  })
  ui.say(`  added ${name} → ${root}`)
}

async function setUpModel(ui: Ui): Promise<void> {
  if (!piLoggedIn() && API_KEYS.every((name) => !process.env[name])) {
    ui.say('Wilco holds no credentials of its own — the harness does.')
    const choice = await ui.choose('How would you like to pay for a model?', [
      'log in to a subscription (Claude, ChatGPT, Copilot, …)',
      'use an API key from the environment',
    ])
    if (choice === 0) {
      ui.say('')
      // Our own key rather than the harness's quit command: which command that
      // is is the harness's business and has changed, and being told the wrong
      // one is worse than being told a key we control.
      ui.say('Opening the harness. Type /login, pick your provider, then ctrl+] to come back.')
      await ui.run('pi — /login, then ctrl+] to come back', process.execPath, [piBinary()])
      if (!piLoggedIn()) throw new Error('still not logged in — run `wilco setup` again')
      ui.say('  logged in')
    } else {
      ui.say(`  set one of: ${API_KEYS.join(', ')}`)
      throw new Error('set the key in your shell, then run `wilco setup` again')
    }
  }

  const model = await pickModel(ui)
  if (!model) return
  patchConfig((config) => {
    config.orchestrator = { ...(config.orchestrator ?? {}), model }
  })
  ui.say(`  orchestrator will use ${model}`)
}

/**
 * Which model to think with, from the ones this machine can actually reach.
 *
 * A name typed from memory is the kind of mistake that surfaces much later, in
 * a lane, as an error nobody connects back to setup — so the catalog the
 * harness already keeps is offered as a list you narrow by typing. Where there
 * is no catalog, typing a name is still there.
 */
async function pickModel(ui: Ui): Promise<string> {
  const models = await usableModels().catch(() => [])
  if (models.length === 0) return ui.ask('model for the orchestrator', 'claude-opus-5')

  const BY_HAND = 'type a name instead'
  const options = [...models.map((model) => model.id), BY_HAND]
  const picked = await ui.choose(
    `Which model? (${models.length} available — type to narrow)`,
    options,
  )
  const chosen = options[picked]
  if (chosen === undefined || chosen === BY_HAND) {
    return ui.ask('model for the orchestrator', 'claude-opus-5')
  }
  return chosen
}

/**
 * Where agents live, which decides whether they survive you closing Wilco.
 *
 * There is nothing to start — Wilco is the window — so this is a choice rather
 * than an installation, and it is the one choice worth interrupting somebody
 * for: a default nobody was shown deciding whether a night's work stops when
 * you shut your laptop is not a default, it is a surprise.
 */
async function setUpWorkspace(ui: Ui): Promise<void> {
  const keepRunning =
    (await ui.choose('Where should agents run?', [
      'tmux — they keep working after you close Wilco, and you can attach from anywhere',
      'pty — nothing to install, and they stop when Wilco does',
    ])) === 0
  if (!keepRunning) {
    patchConfig((config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    ui.say('  agents will run inside Wilco and stop with it')
    return
  }

  if (!which('tmux') && !(await offerInstall(ui, { name: 'tmux', packages: ['tmux'] }))) {
    // Asked for durable agents and has no tmux: say plainly what they got
    // rather than writing a driver that will not start.
    ui.say('  leaving it on pty for now — agents will stop when Wilco does')
    patchConfig((config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    return
  }
  patchConfig((config) => {
    config.workspace = { ...(config.workspace ?? {}), driver: 'tmux', fallback: 'pty' }
  })
  ui.say('  agents will live in tmux and keep working when you close Wilco')
}

/**
 * Whether this machine can provide the configured driver. Asked of the driver
 * itself, so there is one answer to it and `wilco setup --check` cannot drift
 * from what opening the workbench will actually do.
 */
async function driverAvailable(driver: string): Promise<boolean> {
  const make = drivers[driver]
  if (!make) return false
  return (await make(wilcoHome()).available()).ok
}

async function setUpVoice(ui: Ui, facts: ReadinessFacts): Promise<void> {
  ui.say(`Speech is optional — ${facts.speechReason ?? 'not set up'}.`)
  ui.say('Whatever you choose, ctrl+space always opens a line you can type into.')

  const engines = [
    'whisper.cpp — runs here, nothing leaves this machine',
    'OpenAI — sends your audio to them, nothing to install',
    'Groq — sends your audio to them, nothing to install',
    'a dictation app I already use (Wispr Flow, macOS dictation)',
    'nothing for now',
  ] as const
  const picked = await ui.choose('How should Wilco hear you?', engines)

  if (picked === 3) {
    // These type into whatever is focused, so the dictation line receives them
    // with no integration at all. Saying so is the whole setup.
    ui.say('  nothing to set up: hold ctrl+space and dictate into the line as you would anywhere')
    return
  }
  if (picked === 4) {
    ui.say('  skipped — `wilco setup` again when you want it')
    return
  }
  if (picked === 1 || picked === 2) {
    const driver = picked === 1 ? 'openai' : 'groq'
    const key = picked === 1 ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'
    patchConfig((config) => {
      const surfaces = (config.surfaces ?? {}) as Record<string, Record<string, unknown>>
      const voice = (surfaces.voice ?? {}) as Record<string, unknown>
      config.surfaces = { ...surfaces, voice: { ...voice, stt: { driver } } }
    })
    ui.say(`  Wilco will use ${driver}`)
    if (!process.env[key]) ui.say(`  set ${key} in your shell before it can hear you`)
    return
  }

  await setUpWhisper(ui)
}

/** Local speech: the binary, then a model, then which one to use. */
async function setUpWhisper(ui: Ui): Promise<void> {
  const missing = ['whisper-cli', 'ffmpeg'].filter((tool) => !which(tool))
  if (missing.length > 0) {
    const packages = missing.map((tool) => (tool === 'whisper-cli' ? 'whisper-cpp' : tool))
    if (!(await offerInstall(ui, { name: 'speech', packages }))) return
  }

  // English-only models are better at English for their size; the rest
  // understand about a hundred languages. That is the actual choice, so it is
  // the first question rather than a flag on a model name.
  const anyLanguage = await ui.choose('Which languages will you speak?', [
    'English only — smaller and better at it',
    'any language',
  ])
  const models = WHISPER_MODELS.filter((model) => model.english === (anyLanguage === 0))
  const picked = await ui.choose(
    'Which model? Bigger hears better and runs slower.',
    models.map((model) => `${model.name.padEnd(16)} ${model.size.padStart(7)}  ${model.note}`),
  )
  const model = models[picked]
  if (!model) return

  patchConfig((config) => {
    const surfaces = (config.surfaces ?? {}) as Record<string, Record<string, unknown>>
    const voice = (surfaces.voice ?? {}) as Record<string, unknown>
    config.surfaces = {
      ...surfaces,
      voice: { ...voice, stt: { driver: 'whisper-cpp', model: modelPathFor(model.name) } },
    }
  })

  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url))
  const code = await ui.run(`downloading ${model.name} (${model.size})`, process.execPath, [
    bin,
    'voice',
    'setup',
    '--model',
    model.name,
  ])
  ui.say(code === 0 ? `  ${model.name} is ready` : '  that download did not finish — try again')
}

/** Where `wilco voice setup` puts a model, which the config has to point at. */
function modelPathFor(name: string): string {
  return join(wilcoHome(), 'models', `ggml-${name}.bin`)
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
