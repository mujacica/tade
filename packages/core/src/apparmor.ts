import type { AgentCommand } from './agent-user.ts'

// Letting bubblewrap make the namespaces a sandbox needs, where AppArmor keeps
// it from them.
//
// On Linux, Claude Code's sandbox and Codex's are bubblewrap making a user
// namespace. Ubuntu 24.04 and later refuse that to unprivileged programs
// (`kernel.apparmor_restrict_unprivileged_userns = 1`) unless the program has
// an AppArmor profile that allows it — so every command an agent of its own
// user runs with its sandbox on is refused, one at a time, in its lane, until
// somebody writes one. The profile is root's and machine-wide, so Tade writes
// none itself: setup shows it, where it goes and the two commands, and runs
// them on a press (`setUpAgents`), then tries each sandbox again.
//
// The profile is Claude Code's, word for word: its sandbox page,
// https://code.claude.com/docs/en/sandboxing, "Ubuntu 24.04 and later: allow
// bubblewrap to create user namespaces" — the file, the text and the reload.
// It applies to bwrap itself, not to what bwrap runs. Only the path it
// attaches to is this machine's, since AppArmor matches the program's own.
//
// Pure. Reading the kernel's answer and the file is `workbench/src/apparmor.ts`.

/** Where the profile is written, as Claude Code's sandbox page says. */
export const BWRAP_PROFILE = '/etc/apparmor.d/bwrap'

/** The kernel's switch: `1` refuses unprivileged user namespaces to a program without a profile. */
export const USERNS_RESTRICTED = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/** Loading it, as Claude Code's sandbox page says. */
export const RELOAD_APPARMOR = 'sudo systemctl reload apparmor'

/** Where bwrap is on Ubuntu, and so where the page's profile attaches. */
export const BWRAP = '/usr/bin/bwrap'

/** The profile's lines, for the bwrap at `bwrap`. */
export function bwrapProfile(bwrap: string = BWRAP): string[] {
  return [
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile bwrap ${bwrap} flags=(unconfined) {`,
    '  userns,',
    '  include if exists <local/bwrap>',
    '}',
  ]
}

/** What setup knows of AppArmor and bwrap here, looked at (`lookAtAppArmor`). */
export interface AppArmorSeen {
  /** Whether the kernel refuses user namespaces to a program with no profile. */
  restricted: boolean
  /** Whether a profile is already written where the page puts it. */
  profile: boolean
  /** The bwrap agents would run, links followed, or null where none is installed. */
  bwrap: string | null
  /** The harnesses in use whose sandbox is bubblewrap here. */
  harnesses: readonly string[]
}

/** A line as `sh` reads it back: single-quoted, since a profile is all brackets and braces. */
function quoted(line: string): string {
  return `'${line.replaceAll("'", `'\\''`)}'`
}

/**
 * The commands that give bwrap its profile and load it, or none: only where
 * the kernel refuses it, a sandbox in use is bubblewrap, bwrap is installed —
 * a profile for a program that is not there allows nothing — and no profile
 * is written yet. One already there is somebody's, and is never written over.
 *
 * The file is written by `printf` through `sudo tee`, one line, so the line
 * that runs is the line that was shown, as every other step's is.
 */
export function appArmorCommands(seen: AppArmorSeen): AgentCommand[] {
  if (!seen.restricted || !seen.bwrap || seen.profile || seen.harnesses.length === 0) return []
  const lines = bwrapProfile(seen.bwrap).map(quoted).join(' ')
  return [
    {
      says: `write bwrap its profile, ${BWRAP_PROFILE}`,
      line: `printf '%s\\n' ${lines} | sudo tee ${BWRAP_PROFILE} > /dev/null`,
    },
    { says: 'load it', line: RELOAD_APPARMOR },
  ]
}
