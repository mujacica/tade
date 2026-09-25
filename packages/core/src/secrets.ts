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
// credentials, so it is one person's alone (`ownerOnly`) and is never a file
// to commit or paste into an issue — which it never was.
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
 * person: it runs as you, in your checkout, unsandboxed and unasked unless
 * you have said otherwise, so it can read this file the way it can read any
 * other file of yours. Nothing in the file can answer that, so it is said
 * instead — here, once, so the README, the Extensions page, the Settings page
 * and the account prompt cannot drift apart about it — and the way out is
 * said in the same breath, because a warning with nothing to do about it is
 * a warning people learn to scroll past.
 */
export const KEYS_AND_AGENTS =
  `Kept in ${IN_CONFIG} as you typed it, so you can read it back — and ${SEEN_BY_AGENTS} too: ` +
  `agents run as you, unsandboxed unless you say so. To keep one out of the file, export its ` +
  `variable instead, which wins and is never written down, or leave this unset.`

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
