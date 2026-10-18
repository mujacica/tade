import type { Ui } from '@tade/app'
import {
  type AgentRemote,
  type AgentSignIn,
  type AgentUserSeen,
  agentShare,
  type Config,
  defaultConfigPath,
  GITHUB_HOST_KEYS,
  keyPages,
  loadConfig,
  lsRemoteLine,
  reachCommands,
  signInLine,
} from '@tade/core'
import { lookAtReach, signedInAs, signInsFor } from '@tade/workbench/agent-user'

// What an agent user's agents need besides the user (`setup-agents.ts`): each
// harness's sign-in and each account's, and a key of its own to push with
// (decision 9 of the VPS plan: a dedicated SSH key, never a forwarded agent).
//
// None of it passes through Tade. A sign-in is the harness's own, run as that
// user in a terminal in front of the person (`sudo -iu <user> <harness> …`),
// and is checked by asking the harness as that user (`signedInAs`), never by
// reading what it keeps. The key is made as that user, in its home; only its
// public half is read, to show the person where it goes.

/**
 * Sign `seen.user` in and give it a way to push, each on a press, then check
 * each took. Looked at again first, and with the config as it is now, since
 * the step before may just have made the user and named it.
 */
export async function setUpReach(ui: Ui, seen: AgentUserSeen, self: string): Promise<void> {
  const u = seen.user
  if (!seen.sudo || !seen.home) {
    ui.say(`  signing ${u} in, and its key, wait until ${self} can run things as it`)
    return
  }
  const loaded = await loadConfig(defaultConfigPath())
  if (!loaded.ok) return
  const config = loaded.config
  let one = { ...seen, ...(await lookAtReach(seen, config, self)) }
  const commands = reachCommands(one)
  if (commands.length > 0) {
    ui.say(`What ${u}'s agents need besides the user, made as ${u}:`)
    for (const command of commands) {
      ui.say(`  ${command.says}:`)
      ui.say(`    ${command.line}`)
    }
    if (!(await ui.confirm(`run ${commands.length === 1 ? 'it' : 'these'} now?`, true))) {
      ui.say('  skipped — each line above, when you want it, and `tade setup` again')
      return
    }
    for (const command of commands) {
      const code = await ui.run(command.says, '/bin/sh', ['-c', command.line])
      if (code !== 0) {
        ui.say(`  that did not work — run it yourself and try again: ${command.line}`)
        return
      }
    }
    one = { ...seen, ...(await lookAtReach(seen, config, self)) }
  }
  await signIn(ui, u, one.signIns ?? [], config, seen.home)
  await offerPush(ui, u, one.push?.key ?? null, one.push?.remotes ?? [])
}

/** What a sign-in is called where somebody reads it. */
function named(one: Pick<AgentSignIn, 'harness' | 'account'>): string {
  return one.account ? `${one.harness}'s account ${one.account}` : one.harness
}

/** Each sign-in not yet made, run as that user on a press and asked again after. */
async function signIn(
  ui: Ui,
  u: string,
  signIns: readonly AgentSignIn[],
  config: Config,
  home: string,
): Promise<void> {
  const proofs = signInsFor(config, { name: u, home, share: agentShare(home) })
  for (const one of signIns) {
    if (one.signedIn === true) continue
    if (one.signedIn === null && one.problem) {
      ui.say(`  cannot tell whether ${u} is signed in to ${named(one)}: ${one.problem}`)
      continue
    }
    if (!one.launch) continue
    const line = signInLine(u, one.launch)
    ui.say(`${u} signs in to ${named(one)} itself, in its own home — never with yours:`)
    ui.say(`  ${one.how}`)
    ui.say(`    ${line}`)
    if (!(await ui.confirm(`sign ${u} in to ${named(one)} now?`, true))) {
      ui.say('  skipped — that line, when you want it, and `tade setup` again')
      continue
    }
    await ui.run(`${named(one)} as ${u} — sign in, then come back`, '/bin/sh', ['-c', line])
    const proof = proofs.find((ask) => ask.harness === one.harness && ask.account === one.account)
    const now = await signedInAs(u, proof?.proof ?? null)
    ui.say(
      now.signedIn === true
        ? `  ${u} is signed in to ${named(one)}`
        : now.signedIn === false
          ? `  ${u} is still not signed in to ${named(one)}: run the line above yourself, and \`tade setup\` again`
          : `  cannot tell whether ${u} is signed in to ${named(one)}: ${now.problem}`,
    )
  }
}

/**
 * The key's public half and where it goes, then each remote not yet reached
 * tried as that user in front of the person — where ssh asks once about the
 * forge's host key, which is theirs to compare and answer.
 */
export async function offerPush(
  ui: Ui,
  u: string,
  key: string | null,
  remotes: readonly AgentRemote[],
): Promise<void> {
  if (remotes.length === 0) return
  const unreached = remotes.filter((one) => one.reached !== true)
  if (unreached.length === 0) {
    ui.say(`  ${u} reaches every remote its projects push to, with its own key`)
    return
  }
  if (!key) {
    ui.say(`  ${u} has no key of its own to push with yet: the line above makes one`)
    return
  }
  ui.say(`${u} pushes with a key of its own. Its public half, for the forge:`)
  ui.say(`    ${key}`)
  const github = unreached.filter((one) => one.repository && keyPages(one.repository))
  if (github.length > 0) {
    ui.say(
      `  on your GitHub account, for every repository you can push to: ${keyPages(github[0]?.repository ?? '')?.account}`,
    )
    ui.say('  or, narrower, as each repository’s deploy key with write access:')
    for (const one of github) {
      ui.say(`    ${one.repository}: ${keyPages(one.repository ?? '')?.deploy}`)
    }
  }
  for (const one of unreached) {
    if (one.repository && keyPages(one.repository)) continue
    ui.say(`  ${one.repository ?? one.url}: wherever its forge takes an SSH key`)
  }
  if (!(await ui.confirm(`added it — try each as ${u} now?`, true))) {
    ui.say(`  skipped — \`tade setup\` again once it is added, and it tries each as ${u}`)
    return
  }
  if (github.length > 0)
    ui.say(`  if ssh asks about GitHub's host key, compare it with ${GITHUB_HOST_KEYS}`)
  for (const one of unreached) {
    const line = lsRemoteLine(u, one)
    const code = await ui.run(`${one.repository ?? one.url} as ${u}`, '/bin/sh', ['-c', line])
    ui.say(
      code === 0
        ? `  ${u} reaches ${one.repository ?? one.url}`
        : `  ${u} cannot reach ${one.repository ?? one.url} yet: add the key above and try again — ${line}`,
    )
  }
}
