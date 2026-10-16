// Signing in to a harness, wherever this is: which of its sign-ins fits the
// machine, and how long the one it has will last. Pure — the environment and
// the clock are handed in.

import type { SignInHere } from './port.ts'

const DAY = 86_400_000

/** How far ahead a sign-in running out is worth a warning: Claude Code's own three days. */
export const SIGN_IN_WARNING_DAYS = 3

/**
 * Whether a browser opened by this process would be in front of the person.
 *
 * Not over SSH: a browser opened there is on somebody else's screen, or on
 * none. And not on a Linux box with no display at all, which is what a server
 * is, and what a service that box runs is.
 */
export function signInHere(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SignInHere {
  if (env.SSH_CONNECTION || env.SSH_TTY) return { browser: false }
  if (platform === 'linux') return { browser: Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) }
  return { browser: true }
}

/**
 * How long a sign-in has left, as a clause: days where the harness wrote an
 * end down, a warning inside the last three, and "cannot tell" where it wrote
 * none — never nothing, which would read as "it lasts for ever".
 */
export function signInLasts(until: number | null | undefined, now: number): string {
  if (until === null || until === undefined) return 'cannot tell for how long'
  const days = Math.ceil((until - now) / DAY)
  if (days <= 0) return 'its sign-in has run out: sign in again'
  const left = `${days} ${days === 1 ? 'day' : 'days'} left`
  return days <= SIGN_IN_WARNING_DAYS ? `only ${left}: sign in again before it runs out` : left
}
