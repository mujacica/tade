import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type Config, expandHome } from '@tade/core'
import { git } from '@tade/status'
import { DISK_MOST, type DiskAnswer, type DiskAsk, type WebDisk } from '@tade/web'
import { branchesIn, diffIn } from '../checkout-look.ts'
import {
  agentBranch,
  discardIn,
  pullIn,
  renameIn,
  switchIn,
  type Wrote,
} from '../checkout-write.ts'
import type { AgentPane } from '../model.ts'
import { readForView, saveEdited } from '../viewer.ts'
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
// **It reads**: the file as the viewer reads one, cut at `DISK_MOST.file`;
// what git says changed in it as CHANGES measures it; the branches as the
// Switch branch panel lists them.
//
// **And it writes what the panels here write** (`checkout-write.ts`), in the
// same tree and through the same confinement: a save only over the file as it
// was read — its size and its time, refused where it moved, as a save here is
// (`saveEdited`) — and only of a file read whole; a discard of a path inside
// the tree, handed to git as a literal path; a switch, a new branch and a pull
// of the checkout, and a rename of the agent's branch it was asked from.
// **An ask naming an agent that is not here writes nothing**: its tree would
// fall back to the project's checkout, which is not what was pressed.

/** What of `Live` it needs: where an agent works, where it branched, its branch, and a look again. */
export interface DiskLive {
  worktreeOf(task: string): string | null
  baseOf(task: string | null): string | null
  factsOf?(task: string): { branch: string } | null
  refresh?(): Promise<void>
}

export interface DiskDeps {
  config(): Config
  panes(): readonly AgentPane[]
  live(): DiskLive | null
  /** An agent with no branch yet given one, as naming it here does (`Workbench.nameTask`). */
  nameTask?(req: { task: string; root: string; worktree: string; title: string }): Promise<string>
  /** Something that went wrong after a write happened, said where somebody will read it. */
  note?(err: unknown): void
}

export function diskFrom(wire: Wiring): WebDisk {
  return diskOf({
    config: () => wire.opts.config,
    panes: () => wire.state.panes,
    live: () => wire.live ?? null,
    nameTask: (req) => wire.opts.client.nameTask(req),
    note: (err) => wire.note(err),
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
    if (ask.what !== 'file') {
      if (ask.agent !== null && focused === null) {
        return refused(`${ask.agent} is not open here, so nothing of it is changed`)
      }
      const done = await write(ask, {
        root,
        focused,
        live,
        project: configured ? expandHome(configured.root) : null,
        nameTask: deps.nameTask,
      })
      // What it changed is drawn here at once, and in the side that machine is
      // sent: a look that could not happen is said, the next beat looks again,
      // and it is never the reason a write that happened is said not to have.
      if (done.what !== 'wrote' || done.ok) {
        await live?.refresh?.().catch((err: unknown) => deps.note?.(err))
      }
      return done
    }
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
    return fileAnswer(real, inside, file, diff)
  }
}

function fileAnswer(
  real: string,
  inside: string,
  file: ReturnType<typeof readForView>,
  diff: string | null,
): DiskAnswer {
  return {
    what: 'file',
    path: real,
    relative: inside,
    size: file.size,
    binary: file.binary,
    truncated: file.truncated,
    text: file.text,
    error: file.error,
    diff: diff === null ? null : diff.slice(0, DISK_MOST.diff),
    mtimeMs: file.mtimeMs,
  }
}

/** Where a write lands, and what it needs to know there. */
interface Writing {
  /** The tree, real. */
  root: string
  /** The agent whose worktree it is, or null for the project's checkout. */
  focused: string | null
  live: DiskLive | null
  /** The project's own checkout, where an agent's branch is named against. */
  project: string | null
  nameTask: DiskDeps['nameTask']
}

/** One write, as the panel here that does it does it; what git or the disk refused, said. */
async function write(
  ask: Exclude<DiskAsk, { what: 'file' | 'branches' }>,
  at: Writing,
): Promise<DiskAnswer> {
  const { root, focused } = at
  switch (ask.what) {
    case 'save':
      return save(root, ask, at.live?.baseOf(focused) ?? null)
    case 'discard': {
      const real = await within(root, isAbsolute(ask.path) ? ask.path : resolve(root, ask.path))
      if (real === null) return refused(NOT_IN_TREE)
      const inside = relative(root, real)
      const pathspec = `:(literal)${inside}`
      const status = await git(root, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--',
        pathspec,
      ])
      if (!status.ok) return refused('git could not say what it is')
      const untracked = status.stdout.split('\0').some((entry) => entry.startsWith('? '))
      return said(await discardIn(root, pathspec, untracked), `discarded ${inside}`)
    }
    case 'switch':
      if (focused !== null) return refused('An agent’s worktree stays on its own branch.')
      return said(await switchIn(root, ask.name, ask.create), `on ${ask.name}`)
    case 'pull':
      if (focused !== null) return refused('An agent’s worktree is not pulled.')
      return said(await pullIn(root), 'pulled')
    case 'rename': {
      if (focused === null) return refused('Open the agent whose branch this is.')
      const current = at.live?.factsOf?.(focused)?.branch ?? ''
      // Renamed from what the screen there showed, or not at all.
      if (current !== ask.from) return refused(`It is on ${current || 'no branch yet'} now.`)
      if (current !== '') {
        const name = agentBranch(ask.name)
        return said(await renameIn(root, current, name), `renamed to ${name}`)
      }
      if (at.project === null || at.nameTask === undefined) {
        return refused('I cannot find the project this agent belongs to.')
      }
      try {
        const made = await at.nameTask({
          task: focused,
          root: at.project,
          worktree: root,
          title: ask.name,
        })
        return { what: 'wrote', ok: true, said: `on ${made}` }
      } catch (err) {
        return refused(err instanceof Error ? err.message : String(err))
      }
    }
  }
}

/**
 * A file written over only where it is the file that was read, and read whole:
 * answered as the file read again, with what git says of it now.
 */
async function save(
  root: string,
  ask: Extract<DiskAsk, { what: 'save' }>,
  base: string | null,
): Promise<DiskAnswer> {
  const real = await within(root, isAbsolute(ask.path) ? ask.path : resolve(root, ask.path))
  if (real === null) return refused(NOT_IN_TREE)
  const kind = await stat(real).catch(gone)
  if (kind === null) return refused('It is not there any more.')
  if (!kind.isFile()) return refused(NOT_IN_TREE)
  // Only the first `DISK_MOST.file` of a longer one was ever sent: writing what
  // was typed into that would cut the rest off.
  if (ask.was.size > DISK_MOST.file) return refused('Only the start of it was read from here.')
  const inside = relative(root, real)
  try {
    saveEdited(
      {
        path: real,
        size: ask.was.size,
        binary: false,
        truncated: false,
        language: null,
        text: '',
        mtimeMs: ask.was.mtimeMs,
        error: null,
      },
      ask.text,
    )
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err))
  }
  const file = readForView(real, DISK_MOST.file)
  return fileAnswer(real, inside, file, await diffIn(root, base, inside))
}

function said(out: Wrote, done: string): DiskAnswer {
  return { what: 'wrote', ok: out.ok, said: out.ok ? done : out.said }
}

function refused(why: string): DiskAnswer {
  return { what: 'wrote', ok: false, said: why }
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
