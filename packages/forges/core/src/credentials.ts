// A credential a forge had to run a program to find, kept for the next forge
// made for the same sign-in.
//
// A forge is made for every look — the review poll, an intake watch, a tool —
// and thrown away after it, so a credential it remembers is remembered for one
// poll: on GitHub that was `gh auth token` once a minute per project, a process
// for an answer that had not changed. This is where that answer outlives the
// forge, and nowhere else:
//
//   · **In memory and nowhere else.** Nothing here is written, sent or put in a
//     spec, and nothing reads the map but the forge asking for its credential.
//   · **For minutes, not for the window's life** (`CREDENTIAL_KEEP_MS`), so a
//     `gh auth login` as somebody else, or a token revoked on the website, is
//     heard within that without anybody having to restart Tade.
//   · **Dropped the moment the forge refuses it** (`refused`), so an expired
//     token costs one failed request and one new look, never ten minutes.
//   · **A look that failed is not kept.** Somebody who has just signed in is
//     heard on the next ask, and "not signed in" is never remembered as an answer.
//
// What the environment holds is not kept here: reading a variable costs
// nothing, and the environment always wins, so it is read every time.

/** How long a credential found by running a program is used before it is looked for again. */
export const CREDENTIAL_KEEP_MS = 10 * 60_000

export interface CredentialCache {
  /**
   * The credential for one sign-in — a host, and the account where the remote
   * names one — from what is kept while it is fresh, else from `find`. Several
   * forges asking at the same moment share one `find`.
   */
  get(signIn: string, find: () => Promise<string>): Promise<string>
  /**
   * The forge would not take `credential`: forget it, so the next ask looks
   * again. Only that one — a newer one somebody already found is kept.
   */
  refused(signIn: string, credential: string): void
}

interface Kept {
  at: number
  credential: Promise<string>
  /** What it came to, once it has: how `refused` knows which one it is about. */
  value?: string
}

export function credentialCache(
  options: { now?: () => number; keepMs?: number } = {},
): CredentialCache {
  const now = options.now ?? Date.now
  const keepMs = options.keepMs ?? CREDENTIAL_KEEP_MS
  const kept = new Map<string, Kept>()
  return {
    get(signIn, find) {
      const at = now()
      const held = kept.get(signIn)
      if (held && at - held.at < keepMs) return held.credential
      const entry: Kept = { at, credential: find() }
      kept.set(signIn, entry)
      entry.credential.then(
        (value) => {
          entry.value = value
        },
        () => {
          if (kept.get(signIn) === entry) kept.delete(signIn)
        },
      )
      return entry.credential
    },
    refused(signIn, credential) {
      if (kept.get(signIn)?.value === credential) kept.delete(signIn)
    },
  }
}
