import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type AppArmorSeen, BWRAP_PROFILE, resolveCommand, USERNS_RESTRICTED } from '@tade/core'

// Whether AppArmor keeps bubblewrap from the namespaces a sandbox needs: the
// kernel's switch, the profile's file, and the bwrap on PATH — three reads and
// no process. What setup offers about it is `core/src/apparmor.ts`.

/** An answer of "no" where the file is not there or not ours to read; anything else is thrown. */
function answersNo(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR'
}

/**
 * AppArmor and bwrap here, for the harnesses in use whose sandbox is
 * bubblewrap. A kernel with no such switch restricts nothing, as Claude Code's
 * sandbox page says. `root` and `env` are where to look, so a test can stand
 * a machine in.
 */
export async function lookAtAppArmor(
  harnesses: readonly string[],
  look: { root?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<AppArmorSeen> {
  const root = look.root ?? '/'
  const restricted = await readFile(join(root, USERNS_RESTRICTED), 'utf8')
    .then((said) => said.trim() === '1')
    .catch((err: unknown) => {
      if (answersNo(err)) return false
      throw err
    })
  const profile = await stat(join(root, BWRAP_PROFILE))
    .then(() => true)
    .catch((err: unknown) => {
      if (answersNo(err)) return false
      throw err
    })
  const env = look.env ?? process.env
  const found = resolveCommand('bwrap', { PATH: env.PATH ?? '' })
  // AppArmor attaches a profile to the program's own path, links followed.
  const bwrap = found === null ? null : await realpath(found)
  return { restricted, profile, bwrap, harnesses }
}
