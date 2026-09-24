import type { Ui } from '@tade/app'
import {
  defaultConfigPath,
  type InstallCommand,
  type MissingProgram,
  type NativeTrouble,
  writeSetting,
} from '@tade/core'
import type { HarnessHere } from '@tade/workbench/machine'
import type { Look } from './setup-facts.ts'

// The half of setting up that is about this machine rather than about your
// preferences: the binaries Tade is built on, the programs it shells out to,
// which harness you are signed in to, and the keys the extensions asked for.
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
  const [bin, ...args] = command.split(' ')
  // In the window, like everything else: an installer handed the terminal is
  // an installer whose output you cannot see and whose questions you cannot
  // answer, because Tade is still holding the keyboard.
  const code = await ui.run(command, bin ?? command, args)
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
  ui.say('Tade is built on two native modules: node-pty, which is every terminal it opens,')
  ui.say('and better-sqlite3, which indexes the journal. One of them cannot be run here.')
  ui.say('')
  for (const trouble of troubles) {
    for (const line of trouble.fix.split('\n')) ui.say(line)
  }
  ui.say('Tade cannot do this for itself: the command that fixes it has to run in a terminal,')
  ui.say('and opening one is the part that is broken.')
  await ui.pause('Run it in another terminal, then `tade setup` again.')
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
  ui.say('Tade shells out to other people’s programs. Each is declared by whatever needs it,')
  ui.say('so this list is what your drivers, harnesses and forges asked for.')
  ui.say('')
  for (const program of needed) {
    ui.say(`${program.title} is not here — ${program.why}`)
    await offerInstall(ui, program.title, program.install)
  }
  if (spare.length > 0) {
    ui.say('')
    ui.say('Not needed by anything you are set up to use, and there if you want them:')
    for (const program of spare) {
      const how = 'command' in program.install ? program.install.command : program.install.cannot
      ui.say(`  ${program.title} — ${program.why} (${how})`)
    }
  }
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
  ui.say('  · one pi sign-in covers subscriptions (Claude, ChatGPT, Copilot, xAI, …)')
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

/** One line per harness: whether it runs here, and who it is signed in as. */
export function harnessLines(harnesses: readonly HarnessHere[]): string[] {
  return harnesses.map((one) => {
    const name = `${one.id}${one.inUse ? '' : ' (nothing is set to use it)'}`
    if (one.signedIn) return `  ✓ ${name} — signed in${one.who ? ` as ${one.who}` : ''}`
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
  ui.say('Some extensions do more with a key. All of them work without one, and what is')
  ui.say('missing is said on the extension’s own page, so skipping here changes nothing else.')
  ui.say(`A key you paste is written into ${configPath}, which only you can read — as you`)
  ui.say('typed it, so you can check it against the console you copied it from.')
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
      writeSetting(configPath, secret.path, typed)
      ui.say(`  written into ${configPath} as ${secret.path}`)
    }
  }
}
