import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { run } from '../src/program.ts'

// `tade remote list`, `status` and `remove`, run in this worker the way
// `bin.ts` runs them, where `remote.test.ts` runs the binary against a second
// home. What is held here is this command's own half: what it says with no
// remotes, every refusal and its exit code, and `remove` forgetting a remote
// here whether or not the far side answered — over an `ssh` on PATH that only
// writes down what it was asked, so nothing leaves this machine. Adding,
// carrying and connecting pair or serve, and stay with the binary's tests.

const DEVICE = '0123456789abcdef'
const REMOTE = (name: string) =>
  [
    `  ${name}:`,
    '    ssh: far',
    `    device: ${DEVICE}`,
    `    session: ${DEVICE}.abcdefghijklmnopqrstuv`,
    '    csrf: abcdefghijklmnopqrstuv',
    '    host: localhost:7699',
  ].join('\n')
const TWO = ['remotes:', REMOTE('vps'), REMOTE('box'), ''].join('\n')

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

/**
 * A home of its own with `config` in it, and a PATH holding only an `ssh` that
 * writes down what it was asked and answers as `ssh` says: `script` is its body.
 */
function home(config: string, script = 'exit 0') {
  const dir = tmp('tade-cli-remote-here-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(dir, 'config.yaml'), config)
  const asked = join(dir, 'ssh-asked')
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${asked}'\n${script}\n`)
  chmodSync(join(bin, 'ssh'), 0o755)
  return {
    dir,
    bin,
    config: () => readFileSync(join(dir, 'config.yaml'), 'utf8'),
    asked: () => {
      try {
        return readFileSync(asked, 'utf8')
      } catch {
        return ''
      }
    },
  }
}

async function tade(where: { dir: string; bin: string }, ...args: string[]) {
  Object.assign(process.env, {
    TADE_HOME: where.dir,
    HOME: where.dir,
    PATH: where.bin,
    TADE_NO_GH: '1',
  })
  const out: string[] = []
  const err: string[] = []
  const code = await run(['node', 'tade', ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('tade remote, in process', () => {
  it('says how to add one where there are none, as text and as JSON', async () => {
    const where = home('')
    const list = await tade(where, 'remote', 'list')
    expect(list.code, list.err).toBe(0)
    expect(list.out).toBe('no remotes: `tade remote add <name> --ssh <host>` pairs with one')
    expect(JSON.parse((await tade(where, 'remote', 'list', '--json')).out)).toEqual([])
    const status = await tade(where, 'remote', 'status')
    expect(status.code, status.err).toBe(0)
    expect(status.out).toBe('no remotes: `tade remote add <name> --ssh <host>` pairs with one')
  })

  it('lists each remote as JSON, with how it was last seen and never its session', async () => {
    const where = home(TWO)
    const said = await tade(where, 'remote', 'list', '--json')
    expect(said.code, said.err).toBe(0)
    expect(JSON.parse(said.out)).toEqual([
      {
        name: 'vps',
        ssh: 'far',
        tade: 'tade',
        device: DEVICE,
        host: 'localhost:7699',
        state: null,
        seen: null,
      },
      expect.objectContaining({ name: 'box', state: null }),
    ])
    expect(said.out).not.toContain('session')
    expect(said.out).not.toContain('abcdefghijklmnopqrstuv')
  })

  it('refuses a config it cannot read, saying what tells you why, for every command that reads it', async () => {
    const where = home('remotes: [nope\n')
    for (const args of [['list'], ['status'], ['remove', 'vps']]) {
      const said = await tade(where, 'remote', ...args)
      expect(said.code, args.join(' ')).toBe(1)
      expect(said.err).toContain('could not be read: `tade config --check` says what is wrong')
    }
    expect(where.asked()).toBe('')
  })

  it('refuses a remote that is not in the config, asking nothing of ssh', async () => {
    const where = home(TWO)
    for (const args of [
      ['status', 'nope'],
      ['remove', 'nope'],
    ]) {
      const said = await tade(where, 'remote', ...args)
      expect(said.code, args.join(' ')).toBe(2)
      expect(said.err).toBe('there is no remote called nope')
    }
    expect(where.asked()).toBe('')
    expect(where.config()).toContain('vps:')
  })

  it('signs this machine out there when it removes one, and forgets only that one here', async () => {
    const where = home(TWO)
    const said = await tade(where, 'remote', 'remove', 'vps')
    expect(said.code, said.err).toBe(0)
    expect(said.out).toBe(
      `vps: forgotten here\nand signed out there: far no longer knows device ${DEVICE}`,
    )
    // `tade` as nobody named it: from PATH there, or where our installer puts it.
    expect(where.asked()).toContain(`-- far sh -c `)
    expect(where.asked()).toContain(`exec tade "$@"' tade web revoke ${DEVICE}`)
    expect(where.config()).not.toContain('vps:')
    expect(where.config()).toContain('box:')
  })

  it('forgets one here even where it cannot be signed out there, and says how to finish', async () => {
    const where = home(TWO, "echo 'no such box' >&2\nexit 1")
    const said = await tade(where, 'remote', 'remove', 'vps')
    expect(said.code, said.err).toBe(0)
    expect(said.out).toBe('vps: forgotten here')
    expect(said.err).toBe(
      [
        'it could not be signed out there (there: no such box), so its device is still in that machine’s list:',
        `run \`ssh far tade web revoke ${DEVICE}\` once it answers`,
      ].join('\n'),
    )
    expect(where.config()).not.toContain('vps:')
  })
})
