import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runProgram } from '@tade/core'

// A key of its own for each machine link, so revoking one machine is one line
// in that machine's `authorized_keys` — the line whose comment says it is this
// link's — rather than taking away the person's own key, which every other
// machine of theirs signs in with too.
//
// **Minted at pairing, on the person's `tade remote add`**, and installed there
// over whatever reached the machine then (their own key): one line, appended
// only where it is not already, with a newline before it where the file does
// not end in one. Then it is **proved**: a sign-in that offers it first, read
// back from ssh's own `Server accepts key:` line. A machine that reads its keys
// from anywhere but `~/.ssh/authorized_keys` takes it back out, and the link
// signs in as before, saying so — never a link that pairs and then cannot dial.
//
// **Whether a link uses it is the file being there** (`signInArgs`): no
// setting, nothing remembered beside it. `IdentitiesOnly` is what makes taking
// the line out there a revocation, because without it ssh offers the person's
// agent keys first and the line would be decoration. (A key the person's own
// ssh config names for that host is still offered beside it: ssh adds those
// to `-i`, and nothing here may take their config away.)
//
// **It has no passphrase**: the window dials with nobody to type one. So any
// agent here can read it — as it can read the session in `config.yaml`, and as
// it could already use the person's own key. A person whose own key needs a
// touch per use loses that by taking one of these, which is why `tade remote
// add --your-key` keeps theirs.

/** Where that machine's sshd reads keys from by default, from its user's home. */
export const AUTHORIZED_KEYS = '.ssh/authorized_keys'

/** Whether a remote's name can have a key: the shape `RemoteName` holds in the config. */
export function keyable(remote: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(remote)
}

/** The private key one machine link signs in with, under this home. */
export function keyOf(home: string, remote: string): string {
  // Said again here because it becomes a path.
  if (!keyable(remote)) {
    throw new Error('a link key is kept only by a name `remotes.<name>` can hold')
  }
  return join(home, 'links', 'ssh', remote)
}

/** What a connection to this remote is given to sign in with: its own key alone, where it has one. */
export function signInArgs(key: string): string[] {
  return existsSync(key) ? ['-i', key, '-o', 'IdentitiesOnly=yes'] : []
}

/** What its line in `authorized_keys` says it is, and only characters a comment keeps as themselves. */
export function commentFor(label: string, remote: string): string {
  const from = label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'a-machine'
  return `tade-link:${from}->${remote}`
}

/**
 * Mint a new key for this link, over any old one, and answer its public line.
 * Throws with ssh-keygen's own words where it could not.
 */
export async function mint(key: string, comment: string): Promise<string> {
  await forget(key)
  await mkdir(join(key, '..'), { recursive: true, mode: 0o700 })
  const made = await runProgram(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', key],
    { timeoutMs: 15_000 },
  )
  if (made.missing) throw new Error('there is no ssh-keygen on this machine')
  if (made.code !== 0) {
    throw new Error(`ssh-keygen could not make one: ${made.stderr.trim().split('\n').at(-1)}`)
  }
  return publicLine(key)
}

/** The public line of a key minted here: `ssh-ed25519 AAAA… comment`. */
export async function publicLine(key: string): Promise<string> {
  const line = (await readFile(`${key}.pub`, 'utf8')).trim()
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ [A-Za-z0-9._:>-]+$/.test(line)) {
    throw new Error(`${key}.pub is not a key this link minted`)
  }
  return line
}

/** The key itself, without its type or comment: what finds its line again. */
export function blobOf(line: string): string {
  return line.split(' ')[1] ?? ''
}

/** Both halves gone. Nothing is said: there may be none. */
export async function forget(key: string): Promise<void> {
  await rm(key, { force: true })
  await rm(`${key}.pub`, { force: true })
}

// Each run there as `sh -c <script> tade-link <file> <line or key>`, so that
// the person's login shell — fish included — only ever reads quoted words.
// The file is relative to that user's home, as sshd's own default is.

/** Append the line there unless it is already in, under umask 077. */
export const INSTALL = [
  'umask 077',
  'cd "$HOME" || exit 1',
  'f=$1',
  'mkdir -p "$(dirname "$f")" || exit 1',
  'touch "$f" || exit 1',
  'blob=$(printf %s "$2" | cut -d" " -f2)',
  'grep -qF "$blob" "$f" && exit 0',
  '[ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"',
  'printf "%s\\n" "$2" >> "$f"',
].join('\n')

/** Take every line with this key out there, keeping the file's mode; a file with none is left alone. */
export const REMOVE = [
  'umask 077',
  'cd "$HOME" || exit 1',
  'f=$1',
  '[ -f "$f" ] || exit 0',
  'grep -qF "$2" "$f" || exit 0',
  'grep -vF "$2" "$f" > "$f.tade-link"',
  'cat "$f.tade-link" > "$f" && rm -f "$f.tade-link"',
].join('\n')

/** Whether ssh's `-v` says the server took this key, rather than another one it was offered. */
export function accepted(stderr: string, key: string): boolean {
  return stderr.split('\n').some((line) => {
    const at = line.indexOf('Server accepts key: ')
    if (at === -1) return false
    return line.slice(at + 'Server accepts key: '.length).split(' ')[0] === key
  })
}
