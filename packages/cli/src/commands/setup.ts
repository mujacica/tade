import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'
import { runScreen, ScreenCancelled, type Ui } from '@tade/app'
import {
  defaultConfigPath,
  isReady,
  loadConfig,
  type ReadinessFacts,
  readiness,
  resolveCommand,
  type Step,
  stringEnv,
  tadeHome,
} from '@tade/core'
import { piBinary, usableModels } from '@tade/harnesses-pi'
import { makeRecorder, makeTranscriber } from '@tade/voice-stt'
import { drivers, makeJudge } from '@tade/workbench'
import type { Command } from 'commander'
import { type Document, parseDocument } from 'yaml'
import { Exit, type Io } from '../io.ts'
import { WHISPER_MODELS } from './voice.ts'

// The first minute.
//
// A fresh machine has no config and no model. What decides whether
// somebody keeps this tool is whether that first minute tells them what to do
// or shows them an empty screen, so `tade app` runs this when it has to and
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
    ui.say(`  install ${what.packages.join(' and ')} and run \`tade setup\` again`)
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
  // answer, because Tade is still holding the keyboard.
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

/** Where a judge's key lives unless the config says another variable. */
function judgeKeyVariable(settings: Record<string, unknown> | undefined): string {
  const said = settings?.key_env
  return typeof said === 'string' && said !== '' ? said : 'TYPESAFE_API_KEY'
}

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
    talkChosen: /^\s*talk:/m.test(readConfigText()),
    micOk: mic.ok,
    speechOk: speech.ok,
    speechReason: speech.ok ? null : speech.reason,
    judgeKey: (process.env[judgeKeyVariable(config?.extensions?.jev)] ?? '').length > 0,
    // Whatever records that the extension is on or off is the answer: two
    // places saying whether a judge is on is the bug this avoids.
    judgeChosen: config?.extensions?.jev?.enabled !== undefined,
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
      'Set Tade up: a project, a model, somewhere to run agents, and speech if you want it',
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
            if (step.id === 'talk') await setUpTalkKey(ui)
            if (step.id === 'judge') await setUpJudge(ui)
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
      io.out(isReady(after) ? 'Ready. Run `tade`.' : 'Still missing something — see above.')
      if (!isReady(after)) setExit(Exit.error)
    })
}

async function setUpProject(ui: Ui, facts: ReadinessFacts): Promise<void> {
  ui.say('A project is a git repository Tade can start tasks in.')
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
  // Said before anything is asked, because "which harness" is the question
  // people arrive with and the answer explains everything that follows: Tade
  // never holds a credential, so every question about models is really a
  // question about the harness.
  ui.say('Agents are run by a harness. Tade ships with pi and uses it for everything:')
  ui.say('  · one login covers subscriptions (Claude, ChatGPT, Copilot, xAI, …)')
  ui.say('  · or an API key for any of 30-odd providers, read from your environment')
  ui.say('  · or a local model — Ollama, llama.cpp, LM Studio, anything OpenAI-shaped')
  ui.say('Credentials stay with pi. Tade never sees, stores or sends them.')
  ui.say('')

  if (!piLoggedIn() && API_KEYS.every((name) => !process.env[name])) {
    const choice = await ui.choose('How would you like to pay for a model?', [
      'log in to a subscription — opens pi, you type /login',
      'use an API key from the environment',
    ])
    if (choice === 0) {
      ui.say('')
      // Our own key rather than the harness's quit command: which command that
      // is is the harness's business and has changed, and being told the wrong
      // one is worse than being told a key we control.
      ui.say('Opening the harness. Type /login, pick your provider, then ctrl+] to come back.')
      await ui.run('pi — /login, then ctrl+] to come back', process.execPath, [piBinary()])
      if (!piLoggedIn()) throw new Error('still not logged in — run `tade setup` again')
      ui.say('  logged in')
    } else {
      ui.say('  pi reads these from your shell, so export one and it is picked up:')
      for (const key of API_KEYS) ui.say(`    ${key}`)
      ui.say('  e.g. `export ANTHROPIC_API_KEY=sk-…` in your ~/.zshrc, then a new terminal')
      throw new Error('set the key in your shell, then run `tade setup` again')
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
 * Where agents live, which decides whether they survive you closing Tade.
 *
 * There is nothing to start — Tade is the window — so this is a choice rather
 * than an installation, and it is the one choice worth interrupting somebody
 * for: a default nobody was shown deciding whether a night's work stops when
 * you shut your laptop is not a default, it is a surprise.
 */
async function setUpWorkspace(ui: Ui): Promise<void> {
  const keepRunning =
    (await ui.choose('Where should agents run?', [
      'tmux — they keep working after you close Tade, and you can attach from anywhere',
      'pty — nothing to install, and they stop when Tade does',
    ])) === 0
  if (!keepRunning) {
    patchConfig((config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    ui.say('  agents will run inside Tade and stop with it')
    return
  }

  if (!which('tmux') && !(await offerInstall(ui, { name: 'tmux', packages: ['tmux'] }))) {
    // Asked for durable agents and has no tmux: say plainly what they got
    // rather than writing a driver that will not start.
    ui.say('  leaving it on pty for now — agents will stop when Tade does')
    patchConfig((config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    return
  }
  patchConfig((config) => {
    config.workspace = { ...(config.workspace ?? {}), driver: 'tmux', fallback: 'pty' }
  })
  ui.say('  agents will live in tmux and keep working when you close Tade')
}

/**
 * Whether this machine can provide the configured driver. Asked of the driver
 * itself, so there is one answer to it and `tade setup --check` cannot drift
 * from what opening the workbench will actually do.
 */
async function driverAvailable(driver: string): Promise<boolean> {
  const make = drivers[driver]
  if (!make) return false
  return (await make(tadeHome()).available()).ok
}

/**
 * The key you hold to talk. Offered from keys nothing in pi or a shell already
 * wants; any other can be pressed later in Settings › Voice.
 */
async function setUpTalkKey(ui: Ui): Promise<void> {
  const keys = ['ctrl+space', 'f5', 'ctrl+t'] as const
  const picked = await ui.choose('Which key do you hold to talk?', [
    'ctrl+space — the default, and nothing else uses it',
    'F5 — one key, free in pi and your shell',
    'ctrl+t — free in pi and most shells',
  ])
  const key = keys[picked] ?? 'ctrl+space'
  patchConfig((config) => {
    const surfaces = (config.surfaces ?? {}) as Record<string, Record<string, unknown>>
    const voice = (surfaces.voice ?? {}) as Record<string, unknown>
    config.surfaces = {
      ...surfaces,
      voice: { ...voice, talk: { ...((voice.talk as object) ?? {}), key } },
    }
  })
  ui.say(`  hold ${key} to talk — Settings › Voice changes it, and any key you can press is fine`)
}

/**
 * A second opinion, if you want one: asked once, last, and skippable with one
 * key. Tade works with no judge — exactly as it does today, on the path every
 * test exercises — so the benefit, the cost and what leaves the machine are on
 * one screen and "not now" is a finished answer rather than a nag.
 */
async function setUpJudge(ui: Ui): Promise<void> {
  ui.say('Tade can ask a small, fast model — Jev, from TypeSafe — bounded questions about the')
  ui.say('things nobody has time to read. It answers with a number and no paragraph, in about a')
  ui.say('third of a second, for roughly a hundredth of a cent a question. With a key, Tade can:')
  ui.say('  · read every change an agent makes, and tell you which ones want your eyes')
  ui.say('  · search logs and journals by meaning — “where did it give up?”')
  ui.say('  · warn you before two agents that would collide start in one checkout')
  ui.say('  · put a long queue in an order, and say why each thing is where it is')
  ui.say('It never approves, merges or closes anything, and it never writes code: what it flags,')
  ui.say('a person or an agent reads. Without it, none of that runs and nothing else changes.')
  ui.say('Diffs and logs you point it at are sent to TypeSafe, who say they do not train on them.')
  ui.say('Nothing is sent until you ask for something, or turn a watch on.')
  ui.say('')

  const set = await ui.choose('A second opinion, if you want one?', [
    'set it up',
    'not now — Settings › Extensions › Jev whenever you want it',
  ])
  if (set !== 0) {
    patchConfig((config) => {
      const extensions = (config.extensions ?? {}) as Record<string, Record<string, unknown>>
      config.extensions = { ...extensions, jev: { ...(extensions.jev ?? {}), enabled: false } }
    })
    ui.say('  skipped — Settings › Extensions › Jev whenever you want it')
    return
  }

  const variable = 'TYPESAFE_API_KEY'
  const key = process.env[variable] ?? ''
  if (!key) {
    // Never typed into Tade: a key typed into a wizard is a key in a file, and
    // the step simply stays undone, which blocks nothing.
    ui.say('  Create one at https://console.typesafe.ai/settings/keys — or ask for access at')
    ui.say('  https://typesafe.ai if you are not in yet. Then add this to your shell profile:')
    ui.say(`    export ${variable}="…the key the console gave you…"`)
    ui.say('  Tade reads it there and never keeps a copy.')
    throw new Error(`set ${variable} in your shell, then run \`tade setup\` again`)
  }

  // One request, and only here: somebody is sitting in front of the screen
  // having just asked for this. `ready()` runs on every load and may never do
  // it, which is the whole reason a judge has two questions and not one.
  const problem = await makeJudge('jev', { key }).verify()
  patchConfig((config) => {
    const extensions = (config.extensions ?? {}) as Record<string, Record<string, unknown>>
    config.extensions = { ...extensions, jev: { ...(extensions.jev ?? {}), enabled: true } }
  })
  ui.say(
    problem
      ? `  the key in $${variable} did not work: ${problem}`
      : `  the key in $${variable} works — Jev is on`,
  )
  ui.say('  it asks the version Tade pins; Settings › Extensions › Jev changes it')
  // Turning it on is not turning anything loose: the tools become available
  // and the review watch stays off until somebody turns it on, per project.
  ui.say('  its tools are available to you and your agents; the review watch stays off')
  ui.say('  until you turn it on (say "watch what the agents change" in the window)')
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
  const picked = await ui.choose('How should Tade hear you?', engines)

  if (picked === 3) {
    // These type into whatever is focused, so the dictation line receives them
    // with no integration at all. Saying so is the whole setup.
    ui.say('  nothing to set up: hold ctrl+space and dictate into the line as you would anywhere')
    return
  }
  if (picked === 4) {
    ui.say('  skipped — `tade setup` again when you want it')
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
    ui.say(`  Tade will use ${driver}`)
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

/** Where `tade voice setup` puts a model, which the config has to point at. */
function modelPathFor(name: string): string {
  return join(tadeHome(), 'models', `ggml-${name}.bin`)
}

/** Read, change and write `config.yaml`, keeping whatever else is in it. */
function patchConfig(change: (config: Record<string, unknown>) => void): void {
  const path = defaultConfigPath()
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No config yet: this writes a fresh one.
  }
  // The file is somebody's: their comments survive. The change is made to a
  // copy of the data, and only the values that differ are written back into
  // the document — printing the data again would drop every comment in it.
  const doc = parseDocument(text)
  const before = (doc.toJS() as Record<string, unknown> | null) ?? {}
  const after = structuredClone(before)
  change(after)
  writeDifferences(doc, [], before, after)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(tadeHome(), { recursive: true })
  writeFileSync(path, doc.toString())
}

function writeDifferences(doc: Document, at: string[], before: unknown, after: unknown): void {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) doc.deleteIn([...at, key])
    }
    for (const [key, value] of Object.entries(after)) {
      writeDifferences(doc, [...at, key], before[key], value)
    }
    return
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) doc.setIn(at, after)
}
