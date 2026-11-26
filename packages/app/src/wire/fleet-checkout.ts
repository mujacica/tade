import { runProgram } from '@tade/core'
import type { CheckoutHere } from './fleet-reload.ts'

// This machine's Tade checkout, as a reload of every machine needs it to move
// a checkout there to this one's HEAD (`fleet-reload.ts`): what HEAD is now,
// whether theirs is behind it, and the commit handed over the link — pushed
// into a ref of Tade's own there, because this machine's branch is often
// ahead of the upstream both follow, so there is nowhere else to fetch it
// from. No branch there is touched by the push: `tade host upgrade --commit`
// there moves its branch, fast-forward only.

/** Where a handed commit is put there: Tade's own ref, never a branch. */
export const HANDED_REF = 'refs/tade/reload'

const GIT_MS = 15_000
/** A push of a day's commits over a slow link. */
const PUSH_MS = 120_000
const SHA = /^[0-9a-f]{40}$/

/** The checkout at `root` — null for an install, where every answer is that there is none. */
export function checkoutAt(root: string | null): CheckoutHere {
  const git = (args: readonly string[], timeoutMs = GIT_MS, env?: Record<string, string>) =>
    runProgram('git', ['-C', root ?? '.', ...args], {
      timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
    })
  return {
    async head() {
      if (root === null) return null
      const ran = await git(['rev-parse', '--verify', '--quiet', 'HEAD'])
      const sha = ran.stdout.trim()
      return ran.code === 0 && SHA.test(sha) ? sha : null
    },
    async behind(commit, head) {
      if (root === null || !SHA.test(commit) || !SHA.test(head)) return false
      return (await git(['merge-base', '--is-ancestor', commit, head])).code === 0
    },
    async hand(link, remote, there, commit) {
      if (root === null) return 'this machine runs no checkout of Tade to hand it from'
      if (!SHA.test(commit)) return `${JSON.stringify(commit)} is not a commit`
      const to = link.repository(remote, there)
      if (to === null) return `a ${link.id} link cannot hand a commit to it`
      const ran = await git(
        ['push', '--quiet', '--no-verify', '--no-follow-tags', to.url, `+${commit}:${HANDED_REF}`],
        PUSH_MS,
        { ...to.env },
      )
      if (ran.missing) return 'there is no git on this machine'
      if (ran.timedOut) return `the push did not finish in ${PUSH_MS / 1000}s`
      if (ran.code === 0) return null
      const said = ran.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const why = said.find((line) => /^(fatal|error):/.test(line)) ?? said[0]
      return why?.replace(/^(fatal|error):\s*/, '').slice(0, 300) || `git push exited ${ran.code}`
    },
  }
}
