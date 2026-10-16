import { describe, expect, it } from 'vitest'
import { signInHere, signInLasts } from '../src/sign-in.ts'

// Whether a browser this process opens is one the person can see: what decides
// which of a harness's sign-ins is offered. A server has no screen, and a
// browser opened over SSH is on somebody else's, so both get the sign-in a
// harness has for a machine with no screen — a code to paste back, or one to
// enter on another device.

describe('where a sign-in happens', () => {
  const cases: [string, NodeJS.ProcessEnv, NodeJS.Platform, boolean][] = [
    ['a Mac at its own keyboard', {}, 'darwin', true],
    ['a Mac reached over SSH', { SSH_CONNECTION: '10.0.0.2 51022 10.0.0.1 22' }, 'darwin', false],
    ['a Linux desktop', { DISPLAY: ':0' }, 'linux', true],
    ['a Linux desktop on Wayland', { WAYLAND_DISPLAY: 'wayland-0' }, 'linux', true],
    ['a server over SSH', { SSH_TTY: '/dev/pts/0' }, 'linux', false],
    [
      'a server over SSH with X forwarded',
      { SSH_CONNECTION: 'x', DISPLAY: 'localhost:10.0' },
      'linux',
      false,
    ],
    ['a service on a server, with nobody logged in', {}, 'linux', false],
  ]
  for (const [what, env, platform, browser] of cases) {
    it(`${what}: ${browser ? 'a browser' : 'no browser'}`, () => {
      expect(signInHere(env, platform)).toEqual({ browser })
    })
  }
})

describe('how long a sign-in has left', () => {
  const now = Date.UTC(2026, 9, 16)
  const day = 86_400_000

  it('counts whole days up, the way Claude Code counts them', () => {
    expect(signInLasts(now + 30 * day, now)).toBe('30 days left')
    expect(signInLasts(now + 4 * day + 1, now)).toBe('5 days left')
  })

  it('warns inside the last three days, and says so once it has run out', () => {
    expect(signInLasts(now + 3 * day, now)).toBe(
      'only 3 days left: sign in again before it runs out',
    )
    expect(signInLasts(now + 3_600_000, now)).toBe(
      'only 1 day left: sign in again before it runs out',
    )
    expect(signInLasts(now - 1, now)).toBe('its sign-in has run out: sign in again')
  })

  it('says it cannot tell where the harness wrote no end down, rather than nothing', () => {
    expect(signInLasts(null, now)).toBe('cannot tell for how long')
    expect(signInLasts(undefined, now)).toBe('cannot tell for how long')
  })
})
