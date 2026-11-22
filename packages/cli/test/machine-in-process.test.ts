import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Inventory, type InventoryItem, isCredentialName } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import type { MachineAnswer } from '@tade/web'
import { lockHome } from '@tade/workbench/lock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { inventoryLines } from '../src/commands/machine.ts'
import { run } from '../src/program.ts'

// `tade machine`, run in this worker the way `bin.ts` runs it — the same
// program, over a person's home of its own with keys in its shell files —
// where `machine.test.ts` runs the binary. What is held here is what the
// binary's test leaves to chance: every refusal and its exit code, the JSON a
// script reads, no value printed whatever was asked, a move that a fresh login
// shell disagrees with put back byte for byte, and a new box walked against a
// machine that is asked over a real link.

const VALUES = ['sk-fixture-alpha-111', 'tok-fixture-beta-222', 'npm_fixture_333']

/** A person's home: `files` relative to it, and Tade's home inside it with `config`. */
function homes(files: Record<string, string>, config = '') {
  const dir = tmp('tade-machine-here-')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const tade = join(dir, '.tade')
  mkdirSync(tade, { recursive: true })
  writeFileSync(join(tade, 'config.yaml'), config)
  return { dir, tade }
}

/** Two keys in bash's own files, the way somebody pasted them there. */
const BASH_KEYS = {
  '.bash_profile': `export FIXTURE_ALPHA_API_KEY="${VALUES[0]}"\nexport PATH="$HOME/bin:$PATH"\n`,
  '.bashrc': `alias ll="ls -l"\nexport FIXTURE_BETA_TOKEN='${VALUES[1]}'\n`,
}

let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

/** `tade <args>` over `where`, as a person there types it: what it printed, and its exit code. */
async function tade(
  where: { dir: string; tade: string },
  args: string[],
  env: Record<string, string> = {},
) {
  // The worker's own keys are whoever runs the suite's, and an inventory reads
  // the environment it runs in: the binary's test hands it a bare one, so this does.
  for (const key of Object.keys(process.env)) if (isCredentialName(key)) delete process.env[key]
  Object.assign(process.env, {
    HOME: where.dir,
    TADE_HOME: where.tade,
    XDG_CONFIG_HOME: join(where.dir, '.config'),
    SHELL: '/bin/bash',
    TADE_NO_GH: '1',
    ...env,
  })
  const out: string[] = []
  const err: string[] = []
  const code = await run(['node', 'tade', ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function neverSaysAValue(said: { out: string; err: string }, ...more: string[]) {
  for (const value of VALUES) {
    expect(said.out + said.err).not.toContain(value)
    for (const text of more) expect(text).not.toContain(value)
  }
}

const item = (over: Partial<InventoryItem> & Pick<InventoryItem, 'id' | 'kind' | 'label'>) =>
  ({
    state: 'set',
    digest: 'a'.repeat(64),
    until: null,
    where: [],
    said: null,
    variables: [],
    service: null,
    ...over,
  }) as InventoryItem

describe('tade machine, refusing', () => {
  it('refuses every subcommand on a config it cannot read, with exit 2 and the way to find out why', async () => {
    const where = homes(BASH_KEYS, 'projects: [unclosed\n')
    for (const args of [
      ['machine'],
      ['machine', 'env'],
      ['machine', 'env', '--move', '--yes'],
      ['machine', 'setup', '--from', 'mac'],
    ]) {
      const said = await tade(where, args)
      expect(said.code, args.join(' ')).toBe(2)
      expect(said.err).toContain('`tade config --check` says what is wrong with it')
      expect(said.out).toBe('')
    }
    expect(existsSync(join(where.dir, '.config', 'tade', 'env'))).toBe(false)
  }, 120_000)

  it('refuses setup with no --from before it looks at anything', async () => {
    const said = await tade(homes({}), ['machine', 'setup'])
    expect(said.code).toBe(2)
    expect(said.err).toContain("required option '--from <machine>'")
  }, 60_000)
})

describe('tade machine show', () => {
  it('says each key at its file and line and every origin, by name, with no digest and no value', async () => {
    const repo = mkrepo({ remote: true })
    const where = homes(BASH_KEYS, `projects:\n  shop:\n    root: ${repo.root}\n`)
    const json = await tade(where, ['machine', 'show', '--json'])
    expect(json.code, json.err).toBe(0)
    const read = JSON.parse(json.out) as Inventory
    const env = read.items.filter((one) => one.kind === 'env')
    expect(env.map((one) => [one.label, one.state, one.where])).toEqual([
      ['FIXTURE_ALPHA_API_KEY', 'set', ['~/.bash_profile:1']],
      ['FIXTURE_BETA_TOKEN', 'set', ['~/.bashrc:2']],
    ])
    // What two machines compare by is theirs: a terminal gets no digest of anything.
    expect(read.items.length).toBeGreaterThan(env.length)
    expect(read.items.every((one) => one.digest === null)).toBe(true)
    expect(read.items.find((one) => one.id === 'origin:shop')).toMatchObject({ state: 'set' })
    neverSaysAValue(json)

    // `show` is the default, and the terminal says the same by heading.
    const text = await tade(where, ['machine'])
    expect(text.code, text.err).toBe(0)
    const lines = text.out.split('\n')
    expect(lines[0]).toMatch(/^.+, as of \d{4}-\d\d-\d\dT/)
    const heading = lines.indexOf('environment keys')
    expect(heading).toBeGreaterThan(0)
    expect(lines.slice(heading + 1, heading + 3)).toEqual([
      '  ✓ FIXTURE_ALPHA_API_KEY  ~/.bash_profile:1',
      '  ✓ FIXTURE_BETA_TOKEN  ~/.bashrc:2',
    ])
    expect(lines).toContain('origin, with this machine’s credentials')
    neverSaysAValue(text)
  }, 120_000)

  it('says each kind under its heading, a sign-in with the day it runs out, and what is wrong under it', () => {
    const inventory: Inventory = {
      machine: 'mac',
      at: '2026-11-22T12:00:00.000Z',
      shell: 'zsh',
      service: false,
      items: [
        item({
          id: 'sign-in:claude-code',
          kind: 'sign-in',
          label: 'Claude Code',
          until: Date.parse('2026-12-01T09:00:00Z'),
        }),
        item({
          id: 'env:LINEAR_API_KEY',
          kind: 'env',
          label: 'LINEAR_API_KEY',
          state: 'missing',
          digest: null,
          where: ['~/.zshenv:3', '~/.zshrc:9'],
          said: 'set to different values in two places',
        }),
        item({ id: 'public', kind: 'public', label: 'tade.example.com', state: 'unknown' }),
      ],
    }
    expect(inventoryLines(inventory)).toEqual([
      'mac, as of 2026-11-22T12:00:00.000Z',
      'sign-ins',
      '  ✓ Claude Code (until 2026-12-01)',
      'environment keys',
      '  ✗ LINEAR_API_KEY  ~/.zshenv:3, ~/.zshrc:9',
      '      set to different values in two places',
      'public name',
      '  ? tade.example.com',
    ])
  })
})

describe('tade machine env', () => {
  it('names each key by file and line, what the service never reads, what it leaves alone, and how to move them', async () => {
    const where = homes({
      ...BASH_KEYS,
      '.profile': 'export FIXTURE_GAMMA_TOKEN="$(cat ~/.gamma)"\nexport FIXTURE_DELTA_KEY=\n',
      '.npmrc': `//registry.npmjs.org/:_authToken=${VALUES[2]}\n`,
      '.config/systemd/user/tade.service': '[Service]\nExecStart=/usr/bin/tade serve\n',
    })
    const said = await tade(where, ['machine', 'env'])
    expect(said.code, said.err).toBe(0)
    const lines = said.out.split('\n')
    expect(lines).toContain('FIXTURE_ALPHA_API_KEY  ~/.bash_profile:1')
    expect(lines).toContain('FIXTURE_BETA_TOKEN  ~/.bashrc:2')
    expect(lines).toContain('FIXTURE_GAMMA_TOKEN  ~/.profile:1 (worked out at login)')
    expect(lines).toContain('FIXTURE_DELTA_KEY  ~/.profile:2 (empty)')
    expect(lines).toContain(
      '  `tade serve` never reads ~/.bash_profile, so the service here does not have it',
    )
    expect(lines).toContain(
      '~/.npmrc holds _authToken: its own tool reads it, and Tade leaves it alone',
    )
    expect(lines.at(-1)).toBe(
      '`tade machine env --move` shows what moving them into ~/.config/tade/env would do, and asks first',
    )
    neverSaysAValue(said)

    const json = await tade(where, ['machine', 'env', '--json'])
    expect(json.code, json.err).toBe(0)
    const read = JSON.parse(json.out) as {
      service: boolean
      names: { name: string; places: { where: string; state: string; movable: boolean }[] }[]
      others: { file: string; holds: string[] }[]
    }
    expect(read.service).toBe(true)
    expect(read.names.find((one) => one.name === 'FIXTURE_GAMMA_TOKEN')?.places).toEqual([
      expect.objectContaining({ where: '~/.profile:1', state: 'computed', movable: false }),
    ])
    expect(read.others).toEqual([{ file: '~/.npmrc', holds: ['_authToken'] }])
    neverSaysAValue(json)
  }, 120_000)

  it('says a file it could not read rather than passing it over', async () => {
    const where = homes(BASH_KEYS)
    // A folder where a shell file should be: there, and unreadable as one.
    mkdirSync(join(where.dir, '.zshrc'))
    const said = await tade(where, ['machine', 'env'])
    expect(said.code).toBe(0)
    expect(said.err).toMatch(/~\/\.zshrc could not be read \(EISDIR\)/)
    expect(said.out).toContain('FIXTURE_ALPHA_API_KEY  ~/.bash_profile:1')
  }, 120_000)

  it('says no key is set where none is, and that there is nothing to move', async () => {
    const where = homes({ '.bashrc': 'alias ll="ls -l"\n' })
    const said = await tade(where, ['machine', 'env'])
    expect(said.code, said.err).toBe(0)
    expect(said.out).toBe('no key is set in the files that set your environment')

    const move = await tade(where, ['machine', 'env', '--move'])
    expect(move.code, move.err).toBe(0)
    expect(move.out).toBe('nothing to move into ~/.config/tade/env')
    const json = await tade(where, ['machine', 'env', '--move', '--json'])
    expect(json.code, json.err).toBe(0)
    expect(JSON.parse(json.out)).toEqual({ outcome: 'nothing', left: [] })
  }, 120_000)
})

describe('tade machine env --move', () => {
  const before = (where: { dir: string }) =>
    Object.keys(BASH_KEYS).map((rel) => readFileSync(join(where.dir, rel)))
  const unchanged = (where: { dir: string }, was: Buffer[]) => {
    Object.keys(BASH_KEYS).forEach((rel, at) => {
      expect(readFileSync(join(where.dir, rel)).equals(was[at] as Buffer), rel).toBe(true)
    })
    expect(existsSync(join(where.dir, '.config', 'tade', 'env'))).toBe(false)
  }

  it('leaves a key it cannot move where it is, and says why, with --json on stderr', async () => {
    const where = homes({
      '.bash_profile': `export FIXTURE_ALPHA_API_KEY="${VALUES[0]}"\n`,
      '.bashrc': 'export FIXTURE_ALPHA_API_KEY="something-else"\n',
    })
    const said = await tade(where, ['machine', 'env', '--move', '--json'])
    expect(said.code, said.err).toBe(0)
    const read = JSON.parse(said.out) as { outcome: string; left: { name: string; why: string }[] }
    expect(read.outcome).toBe('nothing')
    expect(read.left.map((one) => [one.name, one.why])).toEqual([
      ['FIXTURE_ALPHA_API_KEY', 'it is set to different values in different places'],
      ['FIXTURE_ALPHA_API_KEY', 'it is set to different values in different places'],
    ])
    expect(said.err).toContain(
      'left where it is: FIXTURE_ALPHA_API_KEY at ~/.bash_profile:1 — it is set to different values in different places',
    )
    neverSaysAValue(said)
  }, 120_000)

  it('moves nothing with nobody to ask and no --yes, having shown the diff with every value hidden', async () => {
    const where = homes(BASH_KEYS)
    const was = before(where)
    const said = await tade(where, ['machine', 'env', '--move'])
    expect(said.code, said.err).toBe(0)
    expect(said.out).toContain('export FIXTURE_ALPHA_API_KEY=‹hidden›')
    expect(said.err).toContain('nobody here to ask, so nothing was moved')
    expect(said.err).toContain('any agent')
    unchanged(where, was)
    neverSaysAValue(said)
  }, 120_000)

  it('refuses where no login shell can be asked, touches nothing, and exits 1', async () => {
    const where = homes(BASH_KEYS)
    const was = before(where)
    const said = await tade(where, ['machine', 'env', '--move', '--yes', '--json'], {
      SHELL: '/usr/bin/fish',
    })
    expect(said.code).toBe(1)
    expect(JSON.parse(said.out)).toMatchObject({
      outcome: 'refused',
      why: 'a fresh login shell could not be asked which variables it sets',
      backups: [],
    })
    unchanged(where, was)
    expect(existsSync(join(where.tade, 'events.jsonl'))).toBe(false)
  }, 120_000)

  it('puts every file back byte for byte when a fresh login shell sets something else afterwards, and writes that down', async () => {
    // A key in ~/.bashrc, which a login shell never reads: moved into the one
    // file the profile sources, a login would newly have it, so nothing moves.
    const where = homes(BASH_KEYS)
    const was = before(where)
    const said = await tade(where, ['machine', 'env', '--move', '--yes', '--json'])
    expect(said.code).toBe(1)
    const read = JSON.parse(said.out) as { outcome: string; why: string; backups: string[] }
    expect(read.outcome).toBe('rolled back')
    expect(read.why).toBe(
      'a fresh login shell sets something else afterwards (newly set: FIXTURE_BETA_TOKEN)',
    )
    expect(read.backups).toEqual([])
    unchanged(where, was)
    expect(readdirSync(where.dir).filter((name) => name.includes('.bash'))).toEqual([
      '.bash_profile',
      '.bashrc',
    ])
    const journal = readFileSync(join(where.tade, 'events.jsonl'), 'utf8')
    expect(journal).toContain('"type":"env_consolidated"')
    expect(journal).toContain('"outcome":"rolled back"')
    neverSaysAValue(said, journal)
  }, 120_000)

  it('moves them on --yes where the login agrees, and says why it was not written down while a window holds the home', async () => {
    const where = homes({
      '.bash_profile': `export FIXTURE_ALPHA_API_KEY="${VALUES[0]}"\nexport FIXTURE_BETA_TOKEN='${VALUES[1]}'\n`,
    })
    const lock = await lockHome(where.tade)
    try {
      const said = await tade(where, ['machine', 'env', '--move', '--yes'])
      expect(said.code, said.err).toBe(0)
      expect(said.out).toContain(
        'Moved FIXTURE_ALPHA_API_KEY, FIXTURE_BETA_TOKEN into ~/.config/tade/env',
      )
      expect(said.err).toContain('the window open on this home holds its journal')
      const env = readFileSync(join(where.dir, '.config', 'tade', 'env'), 'utf8')
      expect(env).toContain(`FIXTURE_ALPHA_API_KEY='${VALUES[0]}'`)
      expect(readFileSync(join(where.dir, '.bash_profile'), 'utf8')).not.toContain(VALUES[0])
      expect(existsSync(join(where.tade, 'events.jsonl'))).toBe(false)
      neverSaysAValue(said)
    } finally {
      await lock.release()
    }
  }, 120_000)
})

describe('tade machine setup --from', () => {
  const mac: Inventory = {
    machine: 'mac',
    at: '2026-11-22T12:00:00.000Z',
    shell: 'zsh',
    service: false,
    items: [
      item({
        id: 'env:LINEAR_API_KEY',
        kind: 'env',
        label: 'LINEAR_API_KEY',
        where: ['~/.zshenv:3'],
        variables: ['LINEAR_API_KEY'],
      }),
    ],
  }
  let far: FarEnd | null = null

  afterEach(async () => {
    await far?.close()
    far = null
  })

  /** `ssh -W`, as far as a call goes: a pipe to that port, and refused the way ssh says it. */
  function sshIn(dir: string): string {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'ssh'),
      `#!${process.execPath}
const args = process.argv.slice(2)
const [host, port] = args[args.indexOf('-W') + 1].split(':')
const socket = require('node:net').connect(Number(port), host)
socket.on('error', () => {
  process.stderr.write('channel 0: open failed: connect failed: Connection refused\\nstdio forwarding failed\\n')
  process.exit(255)
})
socket.on('connect', () => {
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.on('close', () => process.exit(0))
`,
    )
    chmodSync(join(bin, 'ssh'), 0o755)
    return `${bin}:${process.env.PATH ?? ''}`
  }

  async function linkedTo(answer: MachineAnswer | null) {
    far = await startFarEnd()
    far.machine = answer
    const session = await far.pair('this-box')
    const where = homes(
      BASH_KEYS,
      [
        'remotes:',
        '  mac:',
        '    ssh: mac',
        `    device: ${session.device}`,
        `    session: ${session.cookie}`,
        `    csrf: ${session.csrf}`,
        `    host: ${session.host}`,
        '',
      ].join('\n'),
    )
    return { where, path: sshIn(where.dir) }
  }

  const answered = (inventory: Inventory | null): MachineAnswer => ({
    at: '2026-11-22T12:00:00.000Z',
    version: '0.3.0',
    newer: null,
    public: null,
    problems: [],
    schedules: [],
    documents: [],
    inventory,
  })

  it('asks a remote what it has and walks it, each key with how to have it here', async () => {
    const { where, path } = await linkedTo(answered(mac))
    const said = await tade(where, ['machine', 'setup', '--from', 'mac', '--json'], { PATH: path })
    expect(said.code, said.err).toBe(0)
    expect(far?.machineAsked).toBe(1)
    const read = JSON.parse(said.out) as {
      from: string
      asked: boolean
      walk: { steps: { item: string; there: string }[]; set: number }
      pushes: unknown[]
    }
    expect(read).toMatchObject({ from: 'mac', asked: true, pushes: [] })
    expect(read.walk.steps.map((one) => [one.item, one.there])).toEqual([
      ['env:LINEAR_API_KEY', 'missing'],
    ])
    // Asked, so not prefaced as something told long ago.
    expect(said.err).not.toContain('what mac told this machine it has')
    neverSaysAValue(said)
  }, 120_000)

  it('says a remote that answers with nothing to say, and one that cannot be reached, rather than walking nothing', async () => {
    const quiet = await linkedTo(answered(null))
    const said = await tade(quiet.where, ['machine', 'setup', '--from', 'mac'], {
      PATH: quiet.path,
    })
    expect(said.code).toBe(1)
    expect(said.err).toBe('mac runs a Tade that does not say what it has yet')
    expect(said.out).toBe('')

    await far?.close()
    far = null
    const gone = await tade(quiet.where, ['machine', 'setup', '--from', 'mac'], {
      PATH: quiet.path,
    })
    expect(gone.code).toBe(1)
    expect(gone.err).toMatch(/^mac could not be asked \(nothing answers on localhost:\d+ there/)
  }, 120_000)

  it('falls back to what an unreachable remote told this machine, and checks each origin with a dry-run push', async () => {
    const { where, path } = await linkedTo(answered(mac))
    await far?.close()
    far = null
    const kept = join(where.tade, 'machines', 'mac')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'inventory.json'), JSON.stringify({ inventory: mac, heardAt: 1 }))
    const pushes = mkrepo({ remote: true })
    const stuck = mkrepo()
    runGit(stuck.root, 'remote', 'add', 'origin', join(stuck.root, 'no-such-origin'))
    const config = readFileSync(join(where.tade, 'config.yaml'), 'utf8')
    writeFileSync(
      join(where.tade, 'config.yaml'),
      `${config}projects:\n  shop:\n    root: ${pushes.root}\n  stuck:\n    root: ${stuck.root}\n`,
    )

    const said = await tade(where, ['machine', 'setup', '--from', 'mac'], { PATH: path })
    expect(said.code, said.err).toBe(0)
    expect(said.err).toBe('what mac told this machine it has, as of 2026-11-22T12:00:00.000Z')
    const lines = said.out.split('\n')
    expect(lines).toContain('✓ shop: this machine can push to origin')
    expect(
      lines.find((line) => line.startsWith('✗ stuck: this machine cannot push to origin')),
    ).toBeDefined()
    expect(said.out).toContain('LINEAR_API_KEY: this machine does not have it')

    const json = await tade(where, ['machine', 'setup', '--from', 'mac', '--json'], { PATH: path })
    expect(json.code, json.err).toBe(0)
    const read = JSON.parse(json.out) as {
      asked: boolean
      pushes: { project: string; ok: boolean }[]
    }
    expect(read.asked).toBe(false)
    expect(read.pushes.map((one) => [one.project, one.ok])).toEqual([
      ['shop', true],
      ['stuck', false],
    ])
    neverSaysAValue(said)
  }, 120_000)

  it('finds a machine told by its label under the folder that label is kept in', async () => {
    const where = homes({})
    const kept = join(where.tade, 'machines', 'build-box-2')
    mkdirSync(kept, { recursive: true })
    writeFileSync(
      join(kept, 'inventory.json'),
      JSON.stringify({ inventory: { ...mac, machine: 'Build Box #2' }, heardAt: 1 }),
    )
    const said = await tade(where, ['machine', 'setup', '--from', 'Build Box 2'])
    expect(said.code, said.err).toBe(0)
    expect(said.err).toContain('what Build Box 2 told this machine it has')
    expect(said.out).toContain('LINEAR_API_KEY: this machine does not have it')
  }, 120_000)
})
