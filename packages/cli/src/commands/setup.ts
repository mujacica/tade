import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'
import { runScreen, ScreenCancelled, type Ui } from '@tade/app'
import {
  askAboutWatches,
  defaultConfigPath,
  type InstallersHere,
  isReady,
  type LaneProof,
  loadConfig,
  ownerOnly,
  type ReadinessFacts,
  readiness,
  resolveCommand,
  type Step,
  type StepId,
  secretPath,
  stringEnv,
  tadeHome,
  worksStep,
  writeSetting,
} from '@tade/core'
import { usableModels } from '@tade/harnesses-pi'
import { makeJudge } from '@tade/workbench'
import { proveALane } from '@tade/workbench/prove'
import type { Command } from 'commander'
import { type Document, parseDocument } from 'yaml'
import { Exit, type Io } from '../io.ts'
import { gather, type Look, lookHere } from './setup-facts.ts'
import {
  harnessLines,
  offerInstall,
  sayNativeTrouble,
  setUpKeys,
  setUpPrograms,
  signInSomewhere,
} from './setup-machine.ts'
import { setUpWatches } from './setup-watches.ts'
import { WHISPER_MODELS } from './voice.ts'

// The first minute.
//
// A fresh machine has no config, no model and quite possibly none of the
// programs Tade shells out to. What decides whether somebody keeps this tool
// is whether that first minute sets them up or shows them an empty screen, so
// `tade app` runs this when it has to and nothing else has to be read first.
//
// The shape of it: what is still to do is a pure fold over facts
// (`readiness`), the facts come from `setup-facts.ts`, and each step's
// questions are here or — for everything about the machine rather than about
// somebody's preferences — in `setup-machine.ts`. It is safe to run again
// because every step is skipped once its fact says it is done, and it ends by
// opening a lane, running a command in it and closing it, because a wizard
// that says "all set" without ever starting a process is how `posix_spawnp
// failed.` reaches a user.

/** The order the steps are done in, which is `readiness`'s own. */
const ORDER: StepId[] = [
  'native',
  'programs',
  'project',
  'model',
  'workspace',
  'voice',
  'talk',
  'judge',
  'extensions',
  'keys',
]

/**
 * Steps whose answers change what is installed or signed in, and so are
 * followed by looking at the machine again rather than by guessing what
 * changed. The rest only write config, which is re-read every time round.
 */
const CHANGES_MACHINE = new Set<StepId>([
  'native',
  'programs',
  'model',
  'workspace',
  'voice',
  'judge',
  'extensions',
])

function render(steps: readonly Step[]): string[] {
  return steps.map((step) => {
    const mark = step.done ? '✓' : step.required ? '·' : '○'
    return `  ${mark} ${step.title}${step.detail ? ` — ${step.detail}` : ''}`
  })
}

/**
 * What this machine has, program by program and harness by harness.
 *
 * `--check` is the one place the whole picture is printed rather than asked
 * about: the checklist says what is still to do, and this says what is here,
 * which is the answer to "why is it asking me that?".
 */
function report(look: Look): string[] {
  const lines = ['', 'Programs:']
  for (const program of look.programs) {
    // Whether it is here is the same answer the wizard acts on, read off the
    // one list that says so rather than worked out a second way.
    const gap = look.missing.find((one) => one.command === program.need.command)
    const version = program.version ? ` ${program.version}` : ''
    const needed = program.need.inUse ? '' : ' — nothing you use needs it'
    if (!gap) {
      lines.push(`  ✓ ${program.need.title}${version}${needed}`)
      continue
    }
    const how = 'command' in gap.install ? gap.install.command : gap.install.cannot
    // What it is for is said where it is missing, which is where somebody has
    // to decide whether they want it; a version is the answer where it is not.
    lines.push(`  ○ ${program.need.title} is not here (${how}) — ${gap.why}${needed}`)
  }
  lines.push('', 'Agents:', ...harnessLines(look.harnesses))
  return lines
}

export function registerSetup(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('setup')
    .description(
      'Set Tade up: the programs it runs, a project, a model, somewhere to run agents, speech',
    )
    .option('--check', 'report what is missing and exit, asking nothing')
    .option('--json', 'the same as data')
    .action(async (opts: { check?: boolean; json?: boolean }) => {
      const home = tadeHome()
      const cwd = process.cwd()
      let look = await lookHere(home)
      let facts = await gather(cwd, look)
      let proof: LaneProof | null = null

      if (opts.check) {
        // The whole of it, including the part that opens a process: a check
        // that only reads files is the check that says "all set" about a
        // machine where no lane can open. It changes nothing — one lane, one
        // command, closed again.
        proof = await proveALane({ driver: facts.driver, home, cwd })
        const steps = [...readiness(facts), worksStep(proof)]
        if (opts.json) {
          io.out(
            JSON.stringify(
              {
                ready: isReady(steps),
                steps,
                proof,
                programs: look.programs,
                harnesses: look.harnesses,
              },
              null,
              2,
            ),
          )
        } else {
          for (const line of render(steps)) io.out(line)
          for (const line of report(look)) io.out(line)
        }
        if (!isReady(steps)) setExit(Exit.error)
        return
      }

      if (!process.stdin.isTTY) {
        // Nothing to type into: say what is missing rather than hanging on a
        // question nobody can answer.
        io.err('setup needs a terminal. What is missing:')
        for (const line of render(readiness(facts))) io.err(line)
        setExit(Exit.error)
        return
      }

      const stuck: string[] = []
      // Read before anything is answered, because answering the extensions
      // step is what makes it done: `askAboutWatches` says the watches are
      // worth offering only where this run is deciding the extensions.
      const offerWatches = askAboutWatches(readiness(facts))
      const todo = readiness(facts).some((step) => !step.done)
      const context = () => render([...readiness(facts), worksStep(proof)])
      const flow = runScreen({ title: 'Setting up', context: context() }, async (ui) => {
        for (const id of ORDER) {
          const step = readiness(facts).find((one) => one.id === id)
          if (!step || step.done) continue
          try {
            await doStep(ui, id, facts, look, async () => {
              look = await lookHere(home)
              return look
            })
          } catch (err) {
            // One step that cannot be finished is not a reason to abandon the
            // others: somebody who has to go and export an API key should
            // still come back to a configured project and a chosen driver.
            stuck.push(`${step.title}: ${message(err)}`)
            ui.say(`  ${step.title}: ${message(err)}`)
          }
          if (CHANGES_MACHINE.has(id)) look = await lookHere(home)
          facts = await gather(cwd, look)
          // The checklist is the point of the screen: it has to move as the
          // answers land, or it is a picture of the machine you arrived with.
          ui.context(context())
          if (id === 'native' && stillBlocked(facts)) {
            ui.say('Nothing else can be set up until that is fixed: all of it runs in a lane.')
            return
          }
        }
        // Which watches should look, after the keys rather than with the
        // extensions: what a watch can do turns on whether its extension has
        // what it needs, and the step above is where a key gets pasted.
        if (offerWatches) {
          ui.say('')
          try {
            await setUpWatches(ui)
          } catch (err) {
            stuck.push(`Watches: ${message(err)}`)
            ui.say(`  watches: ${message(err)}`)
          }
        }
        // The closing check, always, whether anything was asked or not: it is
        // the only part of this that proves the machine rather than reading it.
        ui.say('')
        ui.say('Opening a lane, running a command in it, closing it…')
        proof = await proveALane({ driver: facts.driver, home, cwd })
        ui.say(`  ${proof.says}`)
        ui.context(context())
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
      const after = [...readiness(await gather(cwd, look)), worksStep(proof)]
      for (const line of render(after)) io.out(line)
      io.out('')
      if (isReady(after)) io.out(todo ? 'Ready. Run `tade`.' : 'Everything is set up. Run `tade`.')
      else io.out('Still missing something — see above.')
      if (!isReady(after)) setExit(Exit.error)
    })
}

/** One step's questions. Which step it is decides nothing else about the flow. */
async function doStep(
  ui: Ui,
  id: StepId,
  facts: ReadinessFacts,
  look: Look,
  again: () => Promise<Look>,
): Promise<void> {
  if (id === 'native') return sayNativeTrouble(ui, facts.native ?? [])
  if (id === 'programs') return setUpPrograms(ui, facts.missing ?? [])
  if (id === 'project') return setUpProject(ui, facts)
  if (id === 'model') return setUpModel(ui, facts, look, again)
  if (id === 'workspace') return setUpWorkspace(ui, look)
  if (id === 'voice') return setUpVoice(ui, facts, look)
  if (id === 'talk') return setUpTalkKey(ui)
  if (id === 'judge') return setUpJudge(ui)
  if (id === 'extensions') return setUpExtensions(ui, look)
  // Both of these read the look they were handed: the step before either of
  // them changes the machine, so the loop has already looked again.
  if (id === 'keys') return setUpKeys(ui, look)
}

/** Whether what Tade is built on still stops it, after being told about it. */
function stillBlocked(facts: ReadinessFacts): boolean {
  return (facts.native ?? []).some((one) => one.blocking)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** On the PATH and executable. The same lookup a lane does before spawning. */
function which(command: string): boolean {
  return resolveCommand(command, stringEnv(process.env)) !== null
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

/**
 * A model to think with, which is first a question about a sign-in.
 *
 * Tade holds no credential of its own, so every question about models is
 * really a question about the harness — which is why the sign-ins are here and
 * not in a step of their own, and why they are asked of the harnesses rather
 * than of pi's files.
 */
async function setUpModel(
  ui: Ui,
  facts: ReadinessFacts,
  look: Look,
  again: () => Promise<Look>,
): Promise<void> {
  const signedIn = look.harnesses.some((one) => one.signedIn)
  // The keys the facts already found, never a second scan of the environment:
  // two answers to "is a key set" is how one of them goes stale.
  if (!signedIn && facts.apiKeys.length === 0) {
    await signInSomewhere(ui, look, again)
    const now = await again()
    if (!now.harnesses.some((one) => one.signedIn)) {
      ui.say('  no harness is signed in. An API key in your shell works too:')
      ui.say('  `export ANTHROPIC_API_KEY=sk-…` in your ~/.zshrc, then a new terminal')
      throw new Error('nothing is signed in and no API key is set — `tade setup` again after')
    }
  } else {
    // Signed in somewhere already: say the whole picture and ask nothing. The
    // window signs in to another whenever somebody wants one.
    for (const line of harnessLines(look.harnesses)) ui.say(line)
    ui.say('  Settings › Accounts signs in to another whenever you want one')
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
async function setUpWorkspace(ui: Ui, look: Look): Promise<void> {
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

  // Whether tmux is here, and what would install it, both come from what the
  // driver declared — the same declaration the Updates page reads.
  const missing = look.missing.find((one) => one.command === 'tmux')
  if (missing && !(await offerInstall(ui, 'tmux', missing.install))) {
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
  const configPath = defaultConfigPath()
  const written = await loadConfig(configPath).then(
    (loaded) => (loaded.ok ? loaded.config.extensions.jev?.key : undefined),
    () => undefined,
  )
  const fromEnv = (process.env[variable] ?? '').trim()
  let key = fromEnv || (typeof written === 'string' ? written.trim() : '')
  let where = fromEnv ? `$${variable}` : 'config.yaml'
  if (!key) {
    // Pasting one is offered here rather than refused on principle, and it is
    // written into your config as you type it: a key you cannot read back is
    // a key you cannot check. `0600` keeps that file from other people, and
    // an agent is not another person — so that is said here too, with the way
    // out, which is the variable the environment still wins with.
    ui.say('  Create one at https://console.typesafe.ai/settings/keys — or ask for access at')
    ui.say('  https://typesafe.ai if you are not in yet.')
    ui.say(`  Paste it here and Tade writes it into ${configPath}, which any agent`)
    ui.say(`  you run can read. \`export ${variable}="…"\` works too, wins, and is never`)
    ui.say('  written down.')
    const typed = (await ui.ask('paste the key (enter to skip)', '')).trim()
    if (!typed) {
      ui.say('  skipped — Settings › Extensions › Jev whenever you want it')
      return
    }
    writeSetting(configPath, secretPath('jev', 'key'), typed)
    key = typed
    where = 'config.yaml'
    ui.say(`  written into ${configPath}`)
  }

  // One request, and only here: somebody is sitting in front of the screen
  // having just asked for this. `ready()` runs on every load and may never do
  // it, which is the whole reason a judge has two questions and not one. It
  // has its own deadline, so a machine with no network says so rather than
  // hanging on this.
  const problem = await makeJudge('jev', { key }).verify()
  patchConfig((config) => {
    const extensions = (config.extensions ?? {}) as Record<string, Record<string, unknown>>
    config.extensions = { ...extensions, jev: { ...(extensions.jev ?? {}), enabled: true } }
  })
  ui.say(
    problem
      ? `  the key in ${where} did not work: ${problem}`
      : `  the key in ${where} works — Jev is on`,
  )
  ui.say('  it asks the version Tade pins; Settings › Extensions › Jev changes it')
  // Turning it on is not turning anything loose: the tools become available
  // and the review watch stays off until somebody turns it on, per project.
  ui.say('  its tools are available to you and your agents; the review watch stays off')
  ui.say('  until you turn it on (say "watch what the agents change" in the window)')
}

/**
 * Which extensions to use, and then which of their watches should look.
 *
 * Nothing is on because it is there: what Tade ships with, and anything in
 * your extensions folder — including what Tade wrote for itself — is listed
 * and off until somebody picks it. That is the whole of the safety, so this is
 * the question it deserves, asked once, last, and skippable in one key. Only
 * the ones nobody has decided about are offered; whatever the judge step or
 * the window already answered is left exactly as it is.
 *
 * Which of their watches should look is asked after this and after the keys
 * step (`setUpWatches`, from the loop), because a watch can only look if its
 * extension has what it needs and the keys step is where that gets pasted —
 * but only where *this* step ran, which is what makes it asked once on a
 * machine where nothing has been decided and never again.
 */
async function setUpExtensions(ui: Ui, look: Look): Promise<void> {
  const waiting = look.extensions.filter((one) => !one.chosen)
  if (waiting.length === 0) return

  ui.say('Extensions are what Tade can do that it was not built knowing about: your')
  ui.say('dependencies, your reviews, your errors, what the machine is spending. Each is off')
  ui.say('until you say so, and one you turn on loads the next time Tade starts.')
  ui.say('Settings › Extensions turns any of them on or off later, and sets them up.')
  ui.say('')

  const choice = await ui.choose(`Which of the ${waiting.length} should Tade use?`, [
    'all of them — each still says what it needs before it does anything',
    'let me pick',
    'none for now',
  ])
  if (choice === 2) {
    for (const one of waiting) setExtension(one.name, false)
    ui.say('  all off — Settings › Extensions whenever you want one')
  } else if (choice === 0) {
    for (const one of waiting) setExtension(one.name, true)
    ui.say(`  on: ${waiting.map((one) => one.title).join(', ')}`)
    ui.say('  they load the next time Tade starts')
  } else {
    for (const one of waiting) {
      const on = await ui.confirm(`use ${one.title}?`, true)
      setExtension(one.name, on)
      ui.say(`  ${one.title} is ${on ? 'on' : 'off'}`)
    }
    ui.say('  what you turned on loads the next time Tade starts')
  }
}

/** On or off, written down: there is one answer to whether an extension runs. */
function setExtension(name: string, on: boolean): void {
  patchConfig((config) => {
    const extensions = (config.extensions ?? {}) as Record<string, Record<string, unknown>>
    config.extensions = { ...extensions, [name]: { ...(extensions[name] ?? {}), enabled: on } }
  })
}

async function setUpVoice(ui: Ui, facts: ReadinessFacts, look: Look): Promise<void> {
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

  await setUpWhisper(ui, look.installers)
}

/** Local speech: the binary, then a model, then which one to use. */
async function setUpWhisper(ui: Ui, machine: InstallersHere): Promise<void> {
  const missing = ['whisper-cli', 'ffmpeg'].filter((tool) => !which(tool))
  if (missing.length > 0) {
    const packages = missing.map((tool) => (tool === 'whisper-cli' ? 'whisper-cpp' : tool))
    // Composed here rather than by `installWith`, which answers about one
    // declared program: these two are installed together, because a
    // transcriber with only one of them fails on the first recording — and
    // neither is declared by a port, since nothing in the voice ports says
    // what it shells out to yet. That is what to fix if this grows a third.
    // What this machine installs with is still the one answer everything else
    // reads, so an offer here cannot differ from an offer anywhere else.
    const how = machine.managers.includes('brew')
      ? { command: `brew install ${packages.join(' ')}` }
      : machine.managers.includes('apt-get')
        ? { command: `sudo apt-get install -y ${packages.join(' ')}` }
        : { cannot: `install ${packages.join(' and ')} with whatever this machine uses` }
    if (!(await offerInstall(ui, 'speech', how))) return
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
  // The file holds keys, so it is the owner's alone to read.
  writeFileSync(path, doc.toString(), { mode: 0o600 })
  ownerOnly(path)
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
