import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostNameForms } from '../packages/core/src/host-names.ts'

// What `.githooks/pre-push` runs: a push that would publish this machine's host
// name is refused before it leaves.
//
// The host name reached the public forge twice: a merge Tade proposed named
// the Mac by it in a branch and ten commit messages, and later two commits
// carried it in their messages, a `Tade-Task:` trailer and six test fixtures.
// Tade's own doors refuse it (`hostNameIn`, `test/hostname.test.ts`); this is
// the one door those cannot see, because an agent's commit is its own text.
//
// The forms are `hostNameForms`, read off `hostname` at push time, so the
// name is never written in this repository and a renamed machine is guarded
// by its new name with nothing to update. Every commit that is new to the
// remote is read whole — message, trailers and diff. `git push --no-verify`
// is the way past it, and a person's.

const NONE = /^0+$/

/** One line git hands a pre-push hook: what is pushed, and what the remote has now. */
export interface Pushed {
  ref: string
  local: string
  remote: string
}

/** The lines on a pre-push hook's stdin, without the deletions, which publish nothing. */
export function pushedOf(stdin: string): Pushed[] {
  return stdin
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4 && !NONE.test(parts[1] ?? ''))
    .map(([ref = '', local = '', , remote = '']) => ({ ref, local, remote }))
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: 'pipe' })

/** The commits a push would give the remote: new to the ref it updates, and to every ref already fetched from it. */
export function outgoing(cwd: string, remoteName: string, pushed: Pushed): string[] {
  const not = NONE.test(pushed.remote) ? [] : [`^${pushed.remote}`]
  const known = remoteName === '' ? [] : [`--remotes=${remoteName}`]
  const listed = git(cwd, ['rev-list', pushed.local, ...not, '--not', ...known])
  return listed.split('\n').filter((sha) => sha !== '')
}

/** The commits whose message or diff carries `name` in any of its forms. */
export function carrying(cwd: string, commits: readonly string[], name: string): string[] {
  const forms = hostNameForms(name)
  if (forms.length === 0) return []
  return commits.filter((sha) => {
    const text = git(cwd, ['show', '--format=%B', '--patch', '--no-color', sha]).toLowerCase()
    return forms.some((form) => text.includes(form))
  })
}

/** What the hook says, and whether it lets the push go: the commit ids, never the name. */
export function verdict(
  cwd: string,
  remoteName: string,
  stdin: string,
  name: string,
): string | null {
  const commits = [...new Set(pushedOf(stdin).flatMap((one) => outgoing(cwd, remoteName, one)))]
  const found = carrying(cwd, commits, name)
  if (found.length === 0) return null
  return [
    `pre-push: refused — ${found.length} commit(s) carry this machine's host name in a message, a trailer or a diff:`,
    ...found.map((sha) => `  ${sha.slice(0, 12)}`),
    'Reword or rewrite them before pushing; `git push --no-verify` goes past this check.',
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = execFileSync('hostname', { encoding: 'utf8' }).trim()
  const said = verdict(process.cwd(), process.argv[2] ?? '', readFileSync(0, 'utf8'), name)
  if (said !== null) {
    console.error(said)
    process.exitCode = 1
  }
}
