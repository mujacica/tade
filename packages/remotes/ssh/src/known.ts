import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RunResult } from '@tade/core'
import { type Identity, LinkError } from '@tade/remotes-core'

// The first connection to a machine this one has never met: what it offers to
// prove itself with, shown, and written down only on the person's word.
//
// **ssh decides, and ssh writes.** Whether a host is known, unknown or changed
// is the answer ssh itself gives a connection that may not ask anybody
// anything (`StrictHostKeyChecking=yes` under `BatchMode`) — so a jump host, a
// `HostKeyAlias`, a hashed `known_hosts` and a second file are all answered
// the way they are for every other connection, by the program that reads them.
// And what is shown is what ssh wrote down for a connection made into a
// throwaway `known_hosts` of its own (`accept-new`, nowhere real): the exact
// line, hashed or not, under the exact name, that `trust` then adds to the
// real one — "the way ssh does" taken literally.
//
// **Never accepted silently.** `trust` is called with the fingerprints the
// person was shown, looks again, and refuses unless the machine offers exactly
// those now: a machine that answered with one key at the question and another
// at the answer is the thing this is for. **And never past a changed key**:
// that is a machine in between or a machine rebuilt, only a person can tell
// which, and the way out — `ssh-keygen -R` once they know — is said rather
// than done.

/** Run ssh with these arguments and a deadline: the link's own runner, handed in. */
export type RunSsh = (args: readonly string[], ms: number) => Promise<RunResult>

/** Never a connection the window holds, and never a question to anybody. */
const ALONE = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
]

const LOOK_MS = 20_000

/** ssh's own verdict on the host, with the real `known_hosts` and nobody to ask. */
async function verdict(run: RunSsh, address: string): Promise<'known' | 'new' | 'changed'> {
  const ran = await run(
    [...ALONE, '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '--', address, 'true'],
    LOOK_MS,
  )
  failedToLook(ran, address)
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(ran.stderr)) {
    return 'changed'
  }
  if (/host key verification failed|no .*host key is known for/i.test(ran.stderr)) return 'new'
  return 'known'
}

/**
 * What ssh writes down for this host, made into a `known_hosts` nobody reads:
 * the lines, exactly, and the name they are under where it is not hashed.
 */
async function offered(run: RunSsh, address: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-kh-'))
  try {
    const file = join(dir, 'known_hosts')
    const ran = await run(
      [
        ...ALONE,
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${file}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'UpdateHostKeys=no',
        '--',
        address,
        'true',
      ],
      LOOK_MS,
    )
    failedToLook(ran, address)
    const lines = (await textOf(file))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    if (lines.length === 0) {
      throw new LinkError(
        'failed',
        `${address} offered no host key ssh could write down: ${lastSaid(ran.stderr) || 'it said nothing'}`,
      )
    }
    return lines
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Where ssh keeps the hosts it knows for this destination: the first file it reads. */
async function knownFile(run: RunSsh, address: string): Promise<string> {
  const ran = await run(['-G', '--', address], LOOK_MS)
  failedToLook(ran, address)
  const line = ran.stdout.split('\n').find((one) => one.startsWith('userknownhostsfile '))
  const first = line?.slice('userknownhostsfile '.length).trim().split(/\s+/)[0] ?? ''
  if (first === '' || first === 'none' || first === '/dev/null') {
    throw new LinkError(
      'failed',
      `ssh keeps no known hosts for ${address} (UserKnownHostsFile ${first || 'unset'}), so there is nowhere to write its key`,
    )
  }
  return first
}

/** `ED25519 SHA256:…`, as `ssh-keygen -l` says a key. */
export function fingerprintOf(line: string): string | null {
  const parts = line.split(/\s+/)
  // `name type key`, or `@marker name type key`: the key is after its type.
  const at = parts.findIndex((part) => /^(?:ssh-|ecdsa-|sk-)/.test(part))
  const type = parts[at]
  const key = parts[at + 1]
  if (at < 0 || type === undefined || key === undefined) return null
  const blob = Buffer.from(key, 'base64')
  if (blob.length === 0) return null
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return `${kindOf(type)} SHA256:${digest}`
}

function kindOf(type: string): string {
  if (type.includes('ed25519')) return type.startsWith('sk-') ? 'ED25519-SK' : 'ED25519'
  if (type.startsWith('ecdsa') || type.startsWith('sk-ecdsa')) return 'ECDSA'
  if (type.includes('rsa')) return 'RSA'
  return type.toUpperCase()
}

/**
 * How the host at `address` is known here, and — where it is not simply known
 * — what it offers now. One connection for a host met before, which is every
 * one but the first.
 */
export async function identify(run: RunSsh, address: string): Promise<Identity> {
  const state = await verdict(run, address)
  if (state === 'known') return { state, fingerprints: [], name: address, where: '', said: '' }
  const where = await knownFile(run, address)
  const lines = await offered(run, address)
  return {
    state,
    fingerprints: lines.map(fingerprintOf).filter((one): one is string => one !== null),
    name: address,
    where,
    said: state === 'changed' ? changedSays(address) : '',
  }
}

/**
 * Add the host to `known_hosts`, exactly as ssh would have, for exactly the
 * fingerprints the person was shown — or refuse, saying why.
 */
export async function trust(
  run: RunSsh,
  address: string,
  shown: readonly string[],
): Promise<Identity> {
  const state = await verdict(run, address)
  if (state === 'changed') throw new LinkError('failed', changedSays(address))
  const where = await knownFile(run, address)
  const lines = await offered(run, address)
  const now = lines.map(fingerprintOf).filter((one): one is string => one !== null)
  if (now.length === 0 || now.join('\n') !== [...shown].join('\n')) {
    throw new LinkError(
      'failed',
      `${address} now offers ${now.join(', ') || 'nothing'}, not what you were shown — nothing was written down`,
    )
  }
  if (state === 'new') {
    await mkdir(dirname(where), { recursive: true, mode: 0o700 })
    const before = await textOf(where)
    const lead = before === '' || before.endsWith('\n') ? '' : '\n'
    await appendFile(where, `${lead}${lines.join('\n')}\n`, { mode: 0o600 })
  }
  const after = await verdict(run, address)
  if (after !== 'known') {
    throw new LinkError(
      'failed',
      `${address}'s key was written to ${where}, and ssh still does not know it (${after})`,
    )
  }
  return { state: after, fingerprints: now, name: address, where, said: '' }
}

/** A file's text, or nothing where there is no file: ssh wrote none, or none is kept yet. */
async function textOf(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** What is said of a host whose key is not the one this machine met. */
export function changedSays(address: string): string {
  return `${address} answers with a different host key from the one this machine met. That is what a machine in between looks like — or the same machine, rebuilt. Nothing was sent. If you rebuilt it, \`ssh-keygen -R <its name>\` and add it again; if you did not, do not connect.`
}

/** A look that could not happen at all: no ssh, or nothing answered. */
function failedToLook(ran: RunResult, address: string): void {
  if (ran.missing) throw new LinkError('missing', 'there is no ssh on this machine')
  if (ran.timedOut) throw new LinkError('timed out', `${address} did not answer in time`)
  if (
    ran.code === 255 &&
    /could not resolve|connection refused|connection timed out|no route to host|network is unreachable/i.test(
      ran.stderr,
    )
  ) {
    throw new LinkError('failed', lastSaid(ran.stderr))
  }
}

function lastSaid(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('@@@') && !/^Warning: /.test(line))
      .at(-1) ?? ''
  ).slice(0, 300)
}
