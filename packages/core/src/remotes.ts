import { z } from 'zod'
import { IN_CONFIG, SEEN_BY_AGENTS } from './secrets.ts'

// Another machine's Tade that this one is an owner of: `remotes.<name>` in the
// config, written by `tade remote add` and by nothing else.
//
// **One Tade per machine, and this is how one of them reaches another**
// (REMOTE-TADE.md §2.5). Each machine keeps its own home, journal and agents;
// this machine is a paired *owner device* of the other's away view — a session
// `tade web pair --owner` minted there over SSH, bound to that machine's own
// loopback address — and the link (`@tade/remotes-core`) carries the away
// protocol's projection and verbs over one SSH connection. Nothing here is a
// second protocol, and nothing here is merged: the other machine's journal
// stays the truth there.
//
// **Every key is `never`** (`reach.ts`): a remote is where Tade sends
// something, and the session is a credential whose reach is the keyboard's on
// that machine. A page an agent read does not get to point this machine at
// another one, or hand it a session.
//
// **Each value that reaches another program is refused at the schema for
// anything that is not its shape**, the rule `add-config-key` gives a host name
// in a Caddy block: the destination becomes an argument to `ssh` and the
// command a word a remote shell reads, so a destination that starts with `-`
// is an option (`-oProxyCommand=…`) and a command with a space or a `;` in it is
// two commands. Neither can arrive by this file.

/** What a remote is called here: `vps`. Short, because it names sockets in a runtime folder. */
export const RemoteName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,23}$/,
    'a remote is called by up to 24 lowercase letters, digits and dashes',
  )

/**
 * Where `ssh` reaches it: a `Host` from `~/.ssh/config`, `user@host`, or
 * `ssh://user@host:port` for a port of its own.
 *
 * A name and nothing else, and never one starting with `-`, because whatever
 * this is becomes an argument `ssh` reads.
 */
export const SshDestination = z
  .string()
  .regex(
    /^(?:ssh:\/\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*(?::\d{1,5})?|(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*)$/,
    'an SSH destination is a host, user@host, or ssh://user@host:port',
  )

/**
 * The `tade` to run there, where it is not on the PATH a command over SSH gets.
 *
 * That PATH is the system's own — `/usr/bin:/bin` and little else — because a
 * command over SSH is run without the profile that put a version manager's
 * `bin` on it. So a Tade installed under nvm or `~/.npm-global` is `command not
 * found` to `ssh vps tade`, and this is where its path goes. One word, because
 * a remote shell reads it.
 */
export const RemoteCommand = z
  .string()
  .regex(/^[A-Za-z0-9_~./+][A-Za-z0-9_~./+-]*$/, 'one word: a command or a path, with no spaces')

/** The address an owner session is bound to there: always its own loopback listener. */
export const RemoteHost = z.string().regex(/^localhost:\d{1,5}$/, 'localhost and a port')

export const RemoteConfigSchema = z.strictObject({
  /** Where `ssh` reaches it. */
  ssh: SshDestination,
  /** The command that is Tade there. */
  tade: RemoteCommand.default('tade'),
  /** The owner device this machine is there, as its device list names it. */
  device: z.string().regex(/^[0-9a-f]{8,64}$/, 'a device id as `tade web devices` prints it'),
  /**
   * The owner session: `<device>.<secret>`, the cookie value `tade web pair
   * --owner` printed once. A credential, kept here in plain sight like every
   * other key (`REMOTE_KEPT_HERE`).
   */
  session: z
    .string()
    .regex(
      /^[0-9a-f]{8,64}\.[A-Za-z0-9_-]{16,128}$/,
      'a session as `tade web pair --owner` prints it',
    ),
  /** The token every request that changes something carries. */
  csrf: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'a token as `tade web pair --owner` prints it'),
  /** The `Host` the session is bound to, exactly: `localhost:7654`. */
  host: RemoteHost,
})

export type RemoteConfig = z.infer<typeof RemoteConfigSchema>

/** Every remote, by name. Empty is this machine alone. */
export const RemotesSchema = z.record(RemoteName, RemoteConfigSchema).default({})

/**
 * The port an owner session is answered on there, out of the host it is bound to.
 *
 * The far end of the link's forward: the remote's loopback listener, and the
 * one address the session works at (`sameCookieHost`).
 */
export function remotePort(remote: Pick<RemoteConfig, 'host'>): number {
  return Number(remote.host.slice(remote.host.indexOf(':') + 1))
}

/**
 * What is said where a remote is added, beside the remote's own
 * `OWNER_IS_YOUR_SSH_KEY`: where the session is kept here, and who can read it.
 *
 * The same honesty `KEYS_AND_AGENTS` has about every key: the file is `0600`,
 * and an agent is not another person. What makes it no wider than what an agent
 * here already has is the binding — the session works only through an SSH
 * connection to that machine, which an agent here could already open with your
 * key. The way out is in the same breath.
 */
export const REMOTE_KEPT_HERE =
  `The session is kept in ${IN_CONFIG}, and ${SEEN_BY_AGENTS} — it works only through an SSH ` +
  'connection to that machine, which an agent here could already open with your key. ' +
  '`tade remote remove <name>` signs this machine out there.'
