import { spawn } from 'node:child_process'
import type { Opener } from '../editor.ts'

// The one spawn behind every opener `editor.ts` builds — an editor, a link, a
// folder. Here, behind the wire, because `editor.ts` is also what decides
// which text on screen is a link (`findOpenable`), and that runs wherever the
// window is drawn, a browser included (`browser.ts`). Choosing stays pure over
// there; starting it is this.

/**
 * Start a detached opener and let it go. Resolves once it has started or
 * failed to, with the reason in words: "code is not installed" is an answer,
 * an unhandled ENOENT is not.
 */
export function launch(opener: Extract<Opener, { kind: 'detached' }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opener.command, opener.args, { detached: true, stdio: 'ignore' })
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `${opener.command} is not installed, or not on PATH`
            : err.message,
        ),
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
