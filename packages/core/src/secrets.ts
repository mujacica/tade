import { fileURLToPath } from 'node:url'

// A key is a setting, and lives in the config like every other one.
//
// Tade used to refuse credentials on principle, then kept them in the OS
// keychain — and both were wrong in the same way. Refusing them moved the job
// to everybody's shell profile; the keychain moved it somewhere nobody could
// look. A key pasted into a field that showed bullets and was then kept where
// nothing could read it back could not be checked for a typo, could not be
// copied to another machine, and — on a Mac whose keychain wanted a word about
// it — could not be written at all without `security` stopping to ask, which
// is a question asked of a window that is not drawing.
//
// So: `config.yaml`, in `TADE_HOME`, written `0600`, as itself. It can be read
// back, copied, and corrected. What that costs is that the file now holds
// credentials, so it is kept from other people (`ownerOnly`) — never from the
// agents you run, which can read it (`KEYS_AND_AGENTS`) — and is never a file
// to commit or paste into an issue, which it never was.
//
// The order a credential is found in is the other half, and is unchanged:
// **the environment always wins**. A machine that works today by exporting
// `TYPESAFE_API_KEY` goes on working exactly as it does.

/** A credential, and where it came from — the place, never the value. */
export interface SecretFound {
  value: string
  /** How to say where it came from: `$TYPESAFE_API_KEY`, `config.yaml`. */
  from: string
}

/** What the config is called in a sentence, for saying where a key is. */
export const IN_CONFIG = 'config.yaml'

/**
 * The short of it, for the one line a control gets: `— any agent you run can
 * read it`. A clause of the sentence below, and never a second wording of it.
 */
export const SEEN_BY_AGENTS = 'any agent you run can read it'

/**
 * What is true of every credential Tade keeps, said wherever one is pasted.
 *
 * `0600` keeps the file from other people, and an agent is not another
 * person: it runs as you, in your checkout, with nothing contained and
 * nothing asked unless you have turned approvals on, so it can read this file
 * the way it can read any other file of yours. Nothing in the file can answer
 * that, so it is said instead — here, once, so the README, the Extensions
 * page, the Settings page and the account prompt cannot drift apart about it
 * — and the way out is said in the same breath, because a warning with
 * nothing to do about it is a warning people learn to scroll past.
 *
 * It says "nothing sandboxes them" and not "unless you say so", because there
 * is nothing to say: Tade had a sandbox setting, it was off by every default,
 * and half-owning containment was worse than leaving it to the harness or the
 * agent, which is where it went. Where agents do run as a user of their own,
 * with their harness's sandbox on (`agents.user`), that is still the operating
 * system's and the harness's containment rather than Tade's, and the machine
 * says the second sentence instead (`keysKeptFromAgents`).
 */
export const KEYS_AND_AGENTS =
  `Kept in ${IN_CONFIG} as you typed it, so you can read it back — and ${SEEN_BY_AGENTS} too: ` +
  `agents run as you, and nothing sandboxes them. To keep one out of the file, export its ` +
  `variable instead, which wins and is never written down, or leave this unset.`

/**
 * The short of it where every agent here runs as a user of its own: the clause
 * `SEEN_BY_AGENTS` gives way to on such a machine (`seenByAgents`).
 */
export const KEPT_FROM_AGENTS = 'no agent here can read it'

/**
 * `KEYS_AND_AGENTS`'s second sentence, for a machine whose every agent runs as
 * a Unix user of its own (`agents.user`, `agent-user.ts`): `0600` now does keep
 * the file from them, because they are other people as far as the file is
 * concerned, and Tade's home is closed to them besides. The first sentence
 * stays true everywhere else — a laptop, or a box where even one project's
 * agents run as you — and is what is said there.
 *
 * What it does not fix goes in the same breath, as the first's way out does:
 * an agent still reads its own harness's sign-in, which it needs to run, and
 * its project's code — and a key still leaves the box with a backup, which is
 * why exporting it instead is still offered.
 */
export function keysKeptFromAgents(as: string): string {
  return (
    `Kept in ${IN_CONFIG} as you typed it, so you can read it back — and ${KEPT_FROM_AGENTS}: ` +
    `agents run as ${as}, which cannot open Tade’s home, with their harness’s own sandbox on. An ` +
    `agent can still read its own harness’s sign-in and its project’s code. To keep a key off this ` +
    `machine altogether, export its variable instead, which wins and is never written down, or ` +
    `leave this unset.`
  )
}

/**
 * Which of the two sentences is true here: `as` is who every agent runs as
 * where none runs as you (`agentsKeptAs`), and null where any does.
 */
export function keysAndAgents(as: string | null): string {
  return as ? keysKeptFromAgents(as) : KEYS_AND_AGENTS
}

/** The short of whichever is true here, for the one line a control gets. */
export function seenByAgents(as: string | null): string {
  return as ? KEPT_FROM_AGENTS : SEEN_BY_AGENTS
}

/**
 * A credential wherever its value would be said — a `config_changed` line, a
 * carry's: whether there is one, and nothing of it. Never a count of its
 * characters either, which says something about a secret, and is how a key
 * written from a terminal and the same key written from Settings came to be
 * said two ways.
 */
export function heldSays(value: unknown): 'set' | 'not set' {
  return value === undefined || value === null || value === '' ? 'not set' : 'set'
}

/** Where an extension's credential is written: `extensions.jev.key`. */
export function secretPath(extension: string, key: string): string {
  return `extensions.${extension}.${key}`
}

/**
 * The credential to use, and where it came from: the environment first — every
 * machine that works today goes on working — then what is in the config.
 *
 * Pure, and the one rule: everything that reads a key reads it here, so no
 * surface can disagree with another about which of the two is live.
 */
export function findSecret(opts: {
  /** The settings of whatever it belongs to — an extension's own block. */
  settings: Readonly<Record<string, unknown>> | undefined
  /** Which of them the credential is: `key`, `token`. */
  key: string
  env: Readonly<Record<string, string | undefined>>
  /** Environment variables to look in, in order. */
  variables?: readonly string[]
}): SecretFound | null {
  for (const variable of opts.variables ?? []) {
    const value = opts.env[variable]
    if (value?.trim()) return { value: value.trim(), from: `$${variable}` }
  }
  const written = opts.settings?.[opts.key]
  return typeof written === 'string' && written.trim() !== ''
    ? { value: written.trim(), from: IN_CONFIG }
    : null
}

/**
 * A shell command that prints one credential out of the config, read at the
 * moment it runs: for a program that asks for its key that way — Claude Code's
 * `apiKeyHelper` — so the key is never written into what launches it, where it
 * would sit in the process table for anybody on the machine to read.
 */
export function secretCommand(home: string, path: string): string {
  const script = fileURLToPath(new URL('./print-secret.ts', import.meta.url))
  const word = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  return [process.execPath, script, home, path].map(word).join(' ')
}
