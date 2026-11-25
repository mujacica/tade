import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type Config, expandHome } from '@tade/core'
import { DISK_MOST, type DiskAnswer, type WebDisk } from '@tade/web'
import { branchesIn, diffIn } from '../checkout-look.ts'
import type { AgentPane } from '../model.ts'
import { readForView } from '../viewer.ts'
import type { Wiring } from './context.ts'

// The window's half of `/api/disk` (`@tade/web`'s `disk.ts`): a file, a
// change or the branches in one project of this machine's, for another of the
// person's machines standing in it to open in the very panels it opens one of
// its own in.
//
// **The tree is the one the side was drawn from** (`hereOf`): the worktree of
// the agent in front of the asking screen, where it is this project's, and the
// project's checkout otherwise — so a path FILES or CHANGES named there is
// read where those were read. The ask names the project and the agent; the
// root is this machine's own config and its own look at where each agent works.
//
// **Every path is confined to that tree**, links followed on both sides:
// resolved against the root, its real place found (or, for a file a change
// deleted, its folder's), and anything that is not inside the root's own real
// place is answered as not in the tree (`NOT_IN_TREE`). So `../`, an absolute
// path anywhere else and a link that points out of the tree all read the same
// as a file that is gone, and none of them is read.
//
// **It reads, and changes nothing**: the file as the viewer reads one, cut at
// `DISK_MOST.file`; what git says changed in it as CHANGES measures it; the
// branches as the Switch branch panel lists them.

/** What of `Live` it needs: where an agent works and where it branched. */
export interface DiskLive {
  worktreeOf(task: string): string | null
  baseOf(task: string | null): string | null
}

export interface DiskDeps {
  config(): Config
  panes(): readonly AgentPane[]
  live(): DiskLive | null
}

export function diskFrom(wire: Wiring): WebDisk {
  return diskOf({
    config: () => wire.opts.config,
    panes: () => wire.state.panes,
    live: () => wire.live ?? null,
  })
}

export function diskOf(deps: DiskDeps): WebDisk {
  return async (ask) => {
    const configured = deps.config().projects[ask.project]
    const panes = deps.panes()
    if (configured === undefined && !panes.some((pane) => pane.project === ask.project)) {
      return null
    }
    const live = deps.live()
    const focused =
      ask.agent !== null &&
      panes.some((pane) => pane.task === ask.agent && pane.project === ask.project)
        ? ask.agent
        : null
    const worktree = focused === null ? null : (live?.worktreeOf(focused) ?? null)
    const tree = worktree ?? (configured ? expandHome(configured.root) : null)
    if (tree === null) return null
    const root = await realpath(tree).catch(gone)
    if (root === null) return null
    if (ask.what === 'branches') {
      const branches = await branchesIn(root)
      return { what: 'branches', branches: branches.slice(0, DISK_MOST.branches) }
    }
    if (ask.path === undefined) return null
    const real = await within(root, isAbsolute(ask.path) ? ask.path : resolve(root, ask.path))
    // Gone, or anywhere but this tree, is answered alike: nothing is read, and
    // nothing says which of the two it was.
    if (real === null) return notInTree(ask.path)
    // Only a file is read, and a folder said to be one: a pipe or a device
    // would hold the window's one thread on `open`.
    const kind = await stat(real).catch(gone)
    if (kind !== null && !kind.isFile() && !kind.isDirectory()) return notInTree(ask.path)
    const inside = relative(root, real)
    const file = readForView(real, DISK_MOST.file)
    const diff =
      ask.diff === true ? await diffIn(root, live?.baseOf(focused) ?? null, inside) : null
    const answer: DiskAnswer = {
      what: 'file',
      path: real,
      relative: inside,
      size: file.size,
      binary: file.binary,
      truncated: file.truncated,
      text: file.text,
      error: file.error,
      diff: diff === null ? null : diff.slice(0, DISK_MOST.diff),
    }
    return answer
  }
}

/** Why a path is not read: said the same for one that is gone and one outside the tree. */
export const NOT_IN_TREE = 'It is not in this project’s tree.'

function notInTree(path: string): DiskAnswer {
  return {
    what: 'file',
    path,
    relative: path,
    size: 0,
    binary: false,
    truncated: false,
    text: '',
    error: NOT_IN_TREE,
    diff: null,
  }
}

/** The codes that mean a path is not there: anything else — not allowed, a loop — is thrown. */
const MISSING: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * A path that is not there, as null; any other failure to look is thrown, and
 * the route answers it as the failure it was rather than as nothing there.
 */
function gone(err: unknown): null {
  if (MISSING.has((err as NodeJS.ErrnoException).code ?? '')) return null
  throw err
}

/**
 * Where a path really is, where that is inside `root` (itself real) — or null.
 * A file that is not there is placed by its folder, which must be: a change
 * that deleted a file is still a file CHANGES names, and the viewer says it is
 * gone rather than the route saying it never was.
 */
async function within(root: string, path: string): Promise<string | null> {
  const real =
    (await realpath(path).catch(gone)) ??
    (await realpath(dirname(path))
      .then((folder) => join(folder, basename(path)))
      .catch(gone))
  if (real === null) return null
  const inside = relative(root, real)
  if (inside === '' || inside.split(sep)[0] === '..' || isAbsolute(inside)) return null
  return real
}
