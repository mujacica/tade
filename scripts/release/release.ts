import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CHANGELOG, changelogFor, notesFor, releases, tags, today } from './changelog.ts'
import { git, PUBLISHED, ROOT, repoUrl, rootManifest } from './repo.ts'
import { stage } from './stage.ts'

// Cutting a release.
//
//   pnpm release 0.2.0 --dry-run    everything but the writing
//   pnpm release 0.2.0              the changelog, the version, the commit, the tag
//   git push origin main --follow-tags
//
// The last line is the deliberate one and is a person's: pushing the tag is
// what starts `.github/workflows/release.yml`, and that is what publishes.
// Nothing here reaches npm, and nothing here pushes.
//
// The dry run is the whole of this except the four writes at the end, and it
// exists because the first publish cannot be taken back. It produces the file
// the changelog would be, the notes the release would carry, the tarball that
// would go up, and — this is the part worth the wait — it installs that
// tarball into a directory of its own and runs the `tade` inside it. A package
// whose `exports` do not answer, or whose stripped JavaScript reaches for a
// file that is not in it, fails there rather than on somebody else's machine.

const OUT = 'dist'
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

interface Options {
  version: string
  dry: boolean
  smoke: boolean
}

function parse(argv: readonly string[]): Options | string {
  const args = argv.filter((arg) => arg !== '')
  const version = args.find((arg) => !arg.startsWith('-'))
  if (version === undefined) return 'usage: pnpm release <version> [--dry-run] [--no-smoke]'
  if (!SEMVER.test(version)) return `${version} is not a version: 0.2.0, or 0.2.0-rc.1`
  const unknown = args.find(
    (arg) => arg.startsWith('-') && !['--dry-run', '--no-smoke'].includes(arg),
  )
  if (unknown !== undefined) return `unknown option ${unknown}`
  return { version, dry: args.includes('--dry-run'), smoke: !args.includes('--no-smoke') }
}

/** What would stop this release, each said in full rather than one at a time. */
function refusals(opts: Options): string[] {
  const wrong: string[] = []
  if (tags().includes(`v${opts.version}`)) wrong.push(`v${opts.version} is already a tag here`)
  if (opts.dry) return wrong
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') wrong.push(`on ${branch}, and a release is cut from main`)
  const dirty = git(['status', '--porcelain=v2', '--untracked-files=no'])
  if (dirty !== '')
    wrong.push(
      'there are changes that are not committed. A release commits the changelog and the\n' +
        '  version and nothing else, and in a shared checkout it must not sweep up somebody\n' +
        "  else's work:\n" +
        dirty
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
    )
  // Best effort: a machine with no network still gets to cut a release, it
  // just does not get told that it is behind.
  const fetched = spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT })
  if (fetched.status === 0) {
    const behind = git(['rev-list', '--count', 'HEAD..origin/main'])
    if (behind !== '0') wrong.push(`${behind} commits on origin/main are not here yet`)
  }
  return wrong
}

function say(text: string): void {
  process.stdout.write(`${text}\n`)
}

/**
 * Install the tarball somewhere that has never seen this repository, and run it.
 *
 * `--version` is not a trivial thing to ask of it: the CLI builds its whole
 * command tree at load, so answering at all means every one of the packages
 * resolved through the generated `exports` map. `--help` then draws every
 * command, and `status` is the one that reads git, the journal and the
 * process table.
 */
function smoke(tarball: string, version: string): void {
  const where = mkdtempSync(join(tmpdir(), 'tade-smoke-'))
  try {
    const npm = spawnSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--silent', '--prefix', where, tarball],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (npm.status !== 0) throw new Error(`installing the tarball failed:\n${npm.stderr}`)
    const tade = join(where, 'node_modules', '.bin', 'tade')
    const env = { ...process.env, TADE_HOME: join(where, 'home'), TADE_NO_GH: '1' }
    const ran = (args: string[]): string => {
      const out = spawnSync(tade, args, { encoding: 'utf8', env })
      if (out.status !== 0)
        throw new Error(
          `\`tade ${args.join(' ')}\` from the tarball exited ${out.status}:\n${out.stderr}`,
        )
      return out.stdout
    }
    const said = ran(['--version']).trim()
    if (said !== version) throw new Error(`the installed tade says ${said}, not ${version}`)
    ran(['--help'])
    JSON.parse(ran(['status', '--json']))
    say(`  installed and ran: tade ${said}`)
  } finally {
    rmSync(where, { recursive: true, force: true })
  }
}

function main(): number {
  const opts = parse(process.argv.slice(2))
  if (typeof opts === 'string') {
    process.stderr.write(`${opts}\n`)
    return 2
  }
  const wrong = refusals(opts)
  if (wrong.length > 0) {
    process.stderr.write(
      `Not releasing ${opts.version}:\n${wrong.map((one) => `- ${one}`).join('\n')}\n`,
    )
    return 2
  }

  const out = join(ROOT, OUT)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const repo = repoUrl()
  const all = releases({ pending: opts.version, today: today(new Date()) })
  const text = changelogFor(all, repo)
  const notes = notesFor(
    all[0] ?? { version: opts.version, date: '', since: null, entries: [] },
    repo,
  )
  writeFileSync(join(out, 'notes.md'), notes)
  writeFileSync(join(out, opts.dry ? 'CHANGELOG.md' : 'seen.md'), text)
  const entries = (all[0]?.entries ?? []).length
  say(`${PUBLISHED} ${opts.version} — ${entries} commits since ${all[0]?.since ?? 'the beginning'}`)

  const staged = stage({ out: join(OUT, 'package'), version: opts.version })
  for (const one of staged.left) say(`  left out: ${one}`)
  execFileSync('npm', ['pack', '--silent', '--pack-destination', out], {
    cwd: staged.out,
    encoding: 'utf8',
  })
  const tarball = join(out, `${PUBLISHED}-${opts.version}.tgz`)
  say(`  ${staged.files} files, ${Object.keys(staged.dependencies).length} dependencies`)
  say(`  ${relative(ROOT, tarball)}`)

  if (opts.smoke) smoke(tarball, opts.version)

  if (opts.dry) {
    say('')
    say('Nothing was written outside dist/ and nothing was published. What a release would do:')
    say(`  ${CHANGELOG}   ${text.split('\n').length - 1} lines, in dist/CHANGELOG.md`)
    say(`  package.json   version ${rootManifest().version} -> ${opts.version}`)
    say(`  commit         Release ${opts.version}`)
    say(`  tag            v${opts.version}`)
    return 0
  }

  rmSync(join(out, 'seen.md'), { force: true })
  writeFileSync(join(ROOT, CHANGELOG), text)
  const manifest = readFileSync(join(ROOT, 'package.json'), 'utf8')
  writeFileSync(
    join(ROOT, 'package.json'),
    manifest.replace(/^(\s*"version":\s*")[^"]*(",)$/m, `$1${opts.version}$2`),
  )
  if (!/"version": "\d/.test(readFileSync(join(ROOT, 'package.json'), 'utf8')))
    throw new Error('package.json has no version field to stamp')
  // By path, never `-a`: four agents can be working in this checkout, and a
  // release must carry the changelog and the version and nothing else.
  git(['add', '--', CHANGELOG, 'package.json'])
  git(['commit', '-m', `Release ${opts.version}`])
  git(['tag', '-a', `v${opts.version}`, '-m', `${PUBLISHED} ${opts.version}`])
  say('')
  say(`Committed and tagged v${opts.version}. Nothing has left this machine.`)
  say('')
  say('  git push origin main --follow-tags')
  say('')
  say('is what publishes: the tag starts .github/workflows/release.yml, which runs the gate')
  say('on both systems, packs this same tree again, and only then publishes to npm and opens')
  say('the GitHub release.')
  return 0
}

process.exitCode = main()
