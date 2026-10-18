import type { Ui } from '@tade/app'
import {
  defaultConfigPath,
  type InstallCommand,
  installSaid,
  type MissingProgram,
  type NativeTrouble,
  programTrouble,
} from '@tade/core'
import { signInLasts } from '@tade/harnesses-core'
import { makeRecorder, makeTranscriber } from '@tade/voice-stt'
import type { HarnessHere } from '@tade/workbench/machine'
import { moshPortsSaid } from '@tade/workbench/remotes'
import { patchFromShell, writeFromShell } from '../config-write.ts'
import type { Look } from './setup-facts.ts'

// The half of setting up that is about this machine rather than about your
// preferences: the binaries Tade is built on, the programs it shells out to,
// whether agents run in tmux, which harness you are signed in to, and the keys
// the extensions asked for.
//
// Whatever a test runs in process lives here and not in `setup.ts`, which the
// coverage gate cannot measure because its command runs in the binary
// (`UNSEEN` and `LOADED`, `scripts/coverage-floors.ts`).
//
// Two rules run through all of it. Nothing is installed that was not asked
// for, and every install shows the exact command before it runs — in a lane
// inside the window, so it is watched rather than waited on behind a spinner.
// And nothing here has a list of its own: what is missing comes from what the
// ports declared, the sign-ins from the harnesses themselves, the keys from
// what each extension says it needs.

/**
 * Offer to run a command that installs something, and run it if they say yes.
 *
 * Printing a command and leaving somebody to it is where wizards lose people:
 * the whole point of being asked is not having to go and find out how. Where
 * there is nothing to run, the reason is said — a wrong install command is
 * worse than none — and the answer is no rather than a failure.
 */
export async function offerInstall(
  ui: Ui,
  what: string,
  install: InstallCommand,
): Promise<boolean> {
  if ('cannot' in install) {
    ui.say(`  ${what}: ${install.cannot}`)
    return false
  }
  const command = install.command
  ui.say(`  it would run: ${command}`)
  if (!(await ui.confirm(`install ${what}?`, true))) {
    ui.say(`  skipped — \`${command}\` when you want it`)
    return false
  }
  // In the window, like everything else: an installer handed the terminal is
  // an installer whose output you cannot see and whose questions you cannot
  // answer, because Tade is still holding the keyboard. Through a shell, so
  // the line that runs is the line that was shown, `&&` and all.
  const code = await ui.run(command, '/bin/sh', ['-c', command])
  if (code !== 0) {
    ui.say(`  that did not work — run \`${command}\` yourself and try again`)
    return false
  }
  ui.say(`  ${what} is installed`)
  return true
}

/**
 * What is wrong with the binaries Tade is built on, and the commands that fix
 * it.
 *
 * Said, never run: the fix is a `chmod` or an install, and both would have to
 * be spawned through node-pty, which is the thing that is broken. So this is
 * the one step that hands somebody two commands and waits to be told it has
 * been read — a screen that closes on the way out takes the explanation with
 * it, and `posix_spawnp failed.` at the first lane is exactly what this exists
 * to prevent.
 */
export async function sayNativeTrouble(ui: Ui, troubles: readonly NativeTrouble[]): Promise<void> {
  ui.say(
    'Tade is built on two native modules: node-pty, which is every terminal it opens, and better-sqlite3, which indexes the journal. One of them cannot be run here.',
  )
  ui.say('')
  for (const trouble of troubles) {
    for (const line of trouble.fix.split('\n')) ui.say(line)
  }
  ui.say(
    'Tade cannot do this for itself: the command that fixes it has to run in a terminal, and opening one is the part that is broken.',
  )
  await ui.pause('Run it in another terminal, then `tade setup` again.')
}

/**
 * What a server is told under its checklist, whatever was asked: the one step
 * nothing on this machine can look at — whether its firewall lets mosh in for
 * another machine's window — said as the optional step it is.
 */
export function serverSays(look: Pick<Look, 'unattended'>): string[] {
  return look.unattended ? [moshPortsSaid('this machine')] : []
}

/**
 * The programs Tade shells out to, and an offer to install what is missing.
 *
 * Only what something in use actually requires is offered. The rest is said
 * and left alone — tmux on a machine running the pty driver is worth knowing
 * about and is nobody's to install on somebody's behalf, and each of the steps
 * that would need one (tmux for durable agents, whisper for speech) offers it
 * where it is asked for.
 */
export async function setUpPrograms(ui: Ui, missing: readonly MissingProgram[]): Promise<void> {
  const needed = missing.filter((one) => !one.optional)
  const spare = missing.filter((one) => one.optional)
  ui.say(
    'Tade shells out to other people’s programs. Each is declared by whatever needs it, so this list is what your drivers, harnesses and forges asked for.',
  )
  ui.say('')
  for (const program of needed) {
    ui.say(`${program.title} ${programTrouble(program)} — ${program.why}`)
    // One too old is brought up to date by the line beside it, which installs
    // a newer one over it: what is offered is a newer one, not a second one.
    const what = program.tooOld ? `a newer ${program.title}` : program.title
    await offerInstall(ui, what, program.install)
  }
  if (spare.length > 0) {
    ui.say('')
    ui.say('Not needed by anything you are set up to use, and there if you want them:')
    for (const program of spare) {
      const old = program.tooOld ? ` ${programTrouble(program)}` : ''
      ui.say(`  ${program.title}${old} — ${program.why} (${installSaid(program.install)})`)
    }
  }
}

/**
 * What this machine has, program by program and harness by harness.
 *
 * `--check` is the one place the whole picture is printed rather than asked
 * about: the checklist says what is still to do, and this says what is here,
 * which is the answer to "why is it asking me that?".
 */
export function report(look: Look): string[] {
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
    // What it is for is said where it is missing, which is where somebody has
    // to decide whether they want it; a version is the answer where it is not.
    // Too old is missing too, with the line that brings it up to date.
    lines.push(
      `  ○ ${program.need.title} ${programTrouble(gap)} (${installSaid(gap.install)}) — ${gap.why}${needed}`,
    )
  }
  lines.push('', 'Agents:', ...harnessLines(look.harnesses))
  return lines
}

/**
 * Where agents live, which decides whether they survive you closing Tade.
 *
 * There is nothing to start — Tade is the window — so this is a choice rather
 * than an installation, and it is the one choice worth interrupting somebody
 * for: a default nobody was shown deciding whether a night's work stops when
 * you shut your laptop is not a default, it is a surprise.
 */
export async function setUpWorkspace(ui: Ui, look: Look): Promise<void> {
  const keepRunning =
    (await ui.choose('Where should agents run?', [
      'tmux — they keep working after you close Tade, and you can attach from anywhere',
      'pty — nothing to install, and they stop when Tade does',
    ])) === 0
  if (!keepRunning) {
    await patchConfig(ui, (config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    ui.say('  agents will run inside Tade and stop with it')
    return
  }

  // Whether tmux is here and new enough, and what would install it or bring
  // it up to date, all come from what the driver declared — the same
  // declaration the Updates page reads.
  const missing = look.missing.find((one) => one.command === 'tmux')
  if (missing?.tooOld) ui.say(`  tmux ${programTrouble(missing)}`)
  const what = missing?.tooOld ? 'a newer tmux' : 'tmux'
  if (missing && !(await offerInstall(ui, what, missing.install))) {
    // Asked for durable agents and has no tmux: say plainly what they got
    // rather than writing a driver that will not start.
    ui.say('  leaving it on pty for now — agents will stop when Tade does')
    await patchConfig(ui, (config) => {
      config.workspace = { ...(config.workspace ?? {}), driver: 'pty' }
    })
    return
  }
  await patchConfig(ui, (config) => {
    config.workspace = { ...(config.workspace ?? {}), driver: 'tmux', fallback: 'pty' }
  })
  ui.say('  agents will live in tmux and keep working when you close Tade')
}

/**
 * Which harness you are signed in to, and an offer to sign in to the others.
 *
 * Every harness is listed, not only the one in use: "which of these am I
 * signed in to?" is the question somebody arrives with. Signing in runs the
 * harness's own sign-in, in a lane you watch — no credential passes through
 * Tade and none is stored by it — and it is offered one after another for as
 * long as somebody keeps choosing one, which is what makes this both "say
 * which are signed in" and "offer the rest" in one question.
 */
export async function signInSomewhere(
  ui: Ui,
  look: Look,
  again: () => Promise<Look>,
): Promise<void> {
  ui.say('Agents are run by a harness, and each keeps its own sign-in.')
  ui.say('Tade ships with pi and runs it unless you say otherwise:')
  ui.say(
    '  · one pi sign-in covers subscriptions (ChatGPT, Copilot, xAI, …) — a Claude subscription belongs in Claude Code: through pi, Anthropic bills it as extra usage',
  )
  ui.say('  · or an API key for any of 30-odd providers, read from your environment')
  ui.say('  · or a local model — Ollama, llama.cpp, LM Studio, anything OpenAI-shaped')
  ui.say('Credentials stay with the harness. Tade never sees, stores or sends them.')
  ui.say('')

  let here = look
  for (let round = 0; round <= here.harnesses.length; round++) {
    for (const line of harnessLines(here.harnesses)) ui.say(line)
    ui.say('')
    const offers = here.harnesses.filter((one) => !one.signedIn && couldOffer(one))
    if (offers.length === 0) {
      ui.say('  nothing left to sign in to here')
      return
    }
    const ENOUGH = 'that is enough — an API key in my environment, or later in Settings'
    const options = [...offers.map(offerFor), ENOUGH]
    const picked = await ui.choose('Sign in to one?', options)
    const chosen = offers[picked]
    if (!chosen) {
      ui.say('  Settings › Accounts signs in to any of them whenever you want')
      return
    }
    await signInto(ui, chosen)
    here = await again()
  }
}

/** Whether there is anything Tade could do for this harness at all. */
function couldOffer(harness: HarnessHere): boolean {
  return harness.signIn !== null || 'command' in harness.install
}

/**
 * Offer what local speech runs and this machine has not got — the
 * microphone's program and whisper.cpp's, as each declares it — one at a
 * time, each with this machine's line. Read off the one list the Programs
 * step reads, so the line here cannot differ from the line there: `brew
 * install whisper-cpp` was offered on Debian, where no package has it. Both
 * before anything else is asked, because a transcriber with only one of them
 * fails on the first recording. True when everything is here.
 */
export async function setUpSpeechPrograms(ui: Ui, look: Pick<Look, 'missing'>): Promise<boolean> {
  const ports = [makeRecorder({ driver: 'ffmpeg' }), makeTranscriber({ driver: 'whisper-cpp' })]
  const runs = new Set(ports.flatMap((port) => (port.programs ?? []).map((one) => one.command)))
  for (const program of look.missing.filter((one) => runs.has(one.command))) {
    const what = program.tooOld ? `a newer ${program.title}` : program.title
    if (!(await offerInstall(ui, what, program.install))) return false
  }
  return true
}

/**
 * The dictation apps a person might already use, for the platform they would
 * use them on: Wispr Flow and macOS's own are no answer on Linux.
 */
export function dictationSaid(platform: string): string {
  return platform === 'darwin'
    ? 'a dictation app I already use (Wispr Flow, macOS dictation)'
    : 'a dictation app I already use, one that types into whatever is focused'
}

/**
 * One line per harness: whether it runs here, who it is signed in as, and for
 * how long — because on a server nobody watches, an agent that outlives its
 * harness's sign-in stops making progress and says so only in its own lane.
 */
export function harnessLines(harnesses: readonly HarnessHere[], now = Date.now()): string[] {
  return harnesses.map((one) => {
    const name = `${one.id}${one.inUse ? '' : ' (nothing is set to use it)'}`
    if (one.signedIn) {
      const who = one.who ? ` as ${one.who}` : ''
      return `  ✓ ${name} — signed in${who} · ${signInLasts(one.until, now)}`
    }
    if (!one.installed) {
      const how = 'command' in one.install ? one.install.command : one.install.cannot
      return `  ○ ${name} — not installed (${how})`
    }
    return `  ○ ${name} — installed, ${one.problem ?? 'not signed in'}`
  })
}

function offerFor(harness: HarnessHere): string {
  if (!harness.installed) {
    const how = 'command' in harness.install ? harness.install.command : 'by hand'
    return `${harness.id} — install it first: ${how}`
  }
  return `${harness.id} — ${harness.signIn?.how ?? 'run its own sign-in'}`
}

/** Install it if it is not here, then run its own sign-in where we can see it. */
async function signInto(ui: Ui, harness: HarnessHere): Promise<void> {
  if (!harness.installed) {
    if (!(await offerInstall(ui, harness.id, harness.install))) return
    // It signs in next time round: the adapter was made before the install,
    // and what it can do is asked again rather than assumed.
    ui.say(`  ${harness.id} is installed — choose it again to sign in`)
    return
  }
  const sign = harness.signIn
  if (!sign) {
    ui.say(`  ${harness.id} has no sign-in to offer — an API key in your environment is the way`)
    return
  }
  ui.say(`  ${sign.how}`)
  await ui.run(
    `${harness.id} — sign in, then ctrl+] to come back`,
    sign.launch.command,
    [...sign.launch.args],
    sign.launch.env,
  )
}

/**
 * The keys the extensions that are on say they still want.
 *
 * Everything works without every one of them, which is said first and is the
 * whole shape of the question: an extension that is on and has no key says
 * what it is missing, on its own page and in its own words, and skipping here
 * leaves exactly that. Only what is actually asked for is offered — nothing
 * here knows which extensions exist, and one that is ready because `gh` is
 * signed in is never asked for a token it would not read.
 */
export async function setUpKeys(ui: Ui, look: Look): Promise<void> {
  const wanted = look.keysWanted
  if (wanted.length === 0) return
  const configPath = defaultConfigPath()
  ui.say(
    'Some extensions do more with a key. All of them work without one, and what is missing is said on the extension’s own page, so skipping here changes nothing else.',
  )
  ui.say(
    `A key you paste is written into ${configPath} as you typed it, so you can check it against the console you copied it from — and any agent you run can read it: agents run as you.`,
  )
  // A service is started with the unit's environment, never a login shell's,
  // so on a server an exported variable is a key Tade there never sees.
  ui.say(
    look.unattended
      ? 'Tade here runs as a service, which reads no shell profile, so a key exported in your shell never reaches it: paste it here, or skip it.'
      : 'To keep one out of the file, export its variable instead, which always wins, or skip it here.',
  )
  ui.say('')

  for (const one of wanted) {
    ui.say(`${one.title}: ${one.problem}`)
    const keys = look.secrets.filter((secret) => secret.extension === one.extension)
    for (const secret of keys) {
      if (secret.from !== null) {
        ui.say(`  ${secret.label} is already set in ${secret.from}`)
        continue
      }
      ui.say(`  ${secret.label} — ${secret.means}`)
      if (secret.variables.length > 0) {
        ui.say(`  $${secret.variables.join(' or $')} in your shell wins over what you paste here`)
      }
      const typed = (
        await ui.ask(`paste ${one.title}’s ${secret.label} (enter to skip)`, '')
      ).trim()
      if (!typed) {
        ui.say(`  skipped — Settings › Extensions › ${one.title} whenever you want it`)
        continue
      }
      await writeFromShell(configPath, [{ key: secret.path, value: typed, secret: true }], (said) =>
        ui.say(`  ${said}`),
      )
      ui.say(`  written into ${configPath} as ${secret.path}`)
    }
  }
}

/**
 * Read, change and write `config.yaml`, keeping whatever else is in it, and
 * write each key the change set or took away down (`patchFromShell`).
 */
export function patchConfig(
  ui: Ui,
  change: (config: Record<string, unknown>) => void,
): Promise<void> {
  return patchFromShell(defaultConfigPath(), change, (said) => ui.say(`  ${said}`))
}
