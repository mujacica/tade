import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade intake` from the outside: against a real repository, with a home made
// for the test, and with no window anywhere — because writing a request into
// the spool and reading what is in it are both questions of the filesystem.
//
// **Writing a request is not making work**, and these are the tests that hold
// that: the command says what the owner's own rule would currently do with
// what it just wrote, so a request written against a grant that is off says so
// rather than sitting in a folder looking accepted.

describe('tade intake', () => {
  let home: string
  let repo: ReturnType<typeof mkrepo>
  let env: Record<string, string>

  const tade = (
    ...args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })

  const config = (grant: string[] = []) =>
    writeFileSync(
      join(home, 'config.yaml'),
      `${[
        'projects:',
        '  app:',
        `    root: ${repo.root}`,
        ...(grant.length > 0
          ? ['surfaces:', '  intake:', '    enabled: true', '    sources:', '      cli:', ...grant]
          : []),
      ].join('\n')}\n`,
    )

  const spooled = () => readdirSync(join(home, 'intake')).filter((name) => name.endsWith('.json'))

  beforeEach(() => {
    repo = mkrepo()
    home = tmp('tade-cli-intake-')
    config()
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('writes a request, and says the rule would not act on it yet', async () => {
    const { code, stdout } = await tade(
      'intake',
      'add',
      'app',
      '--id',
      'req-1',
      '--from',
      'kim',
      '--body',
      'the export button 500s',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('wrote req-1 at revision 1 for app')
    // Off is the default, so what it says is that nothing will come of this
    // until somebody grants it — never silence.
    expect(stdout).toContain('would not act on it yet')
    expect(stdout).toContain('Nothing starts from here')
    expect(spooled()).toEqual(['req-1.0001.json'])
    const written = JSON.parse(readFileSync(join(home, 'intake', 'req-1.0001.json'), 'utf8'))
    expect(written).toMatchObject({
      id: 'req-1',
      revision: 1,
      project: 'app',
      requester: { id: 'kim', bot: false },
      body: 'the export button 500s',
      closed: false,
    })
  })

  it('says the rule would accept it, and under which grant, once one allows it', async () => {
    config(['        accept: true', '        projects: [app]', '        from: [kim]'])
    const { stdout } = await tade(
      'intake',
      'add',
      'app',
      '--id',
      'req-1',
      '--from',
      'kim',
      '--body',
      'a request',
      '--json',
    )
    const said = JSON.parse(stdout)
    expect(said.would).toContain('would accept it, propose')
    expect(said.would).toContain('surfaces.intake.sources.cli')
  })

  it('writes a new revision rather than editing the one that is there', async () => {
    const add = (body: string) =>
      tade('intake', 'add', 'app', '--id', 'req-1', '--from', 'kim', '--body', body)
    await add('first')
    await add('second')
    expect(spooled()).toEqual(['req-1.0001.json', 'req-1.0002.json'])
    // The first revision is untouched: it is the record of what the text was
    // when a task may have been made from it.
    expect(JSON.parse(readFileSync(join(home, 'intake', 'req-1.0001.json'), 'utf8')).body).toBe(
      'first',
    )
    const { stdout } = await tade('intake', 'list', 'app')
    // The newest of each by default, which is the one anything would act on.
    expect(stdout).toBe('cli:req-1  r2  app  @kim')
    const all = await tade('intake', 'list', '--all')
    expect(all.stdout.split('\n')).toHaveLength(2)
  })

  it('withdraws a request as a new revision that says so', async () => {
    await tade('intake', 'add', 'app', '--id', 'req-1', '--from', 'kim', '--body', 'a request')
    const { code, stdout } = await tade(
      'intake',
      'add',
      'app',
      '--id',
      'req-1',
      '--from',
      'kim',
      '--close',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('withdrew req-1 at revision 2')
    expect((await tade('intake', 'list')).stdout).toContain('withdrawn')
  })

  it('refuses a request with nobody behind it, and one with an unusable id', async () => {
    const nobody = await tade('intake', 'add', 'app', '--body', 'a request')
    expect(nobody.code).toBe(2)
    expect(nobody.stderr).toContain('say who asked')
    const bad = await tade(
      'intake',
      'add',
      'app',
      '--id',
      '../../etc/passwd',
      '--from',
      'kim',
      '--body',
      'a request',
    )
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('not a usable request id')
    const quiet = await tade('intake', 'add', 'app', '--from', 'kim', '--body', '   ')
    expect(quiet.code).toBe(2)
    expect(quiet.stderr).toContain('say what the request is')
  })

  it('reads the request from a file when it is too long to type', async () => {
    const path = join(home, 'body.md')
    writeFileSync(path, 'the export button 500s when the selection is empty\n')
    const { code } = await tade(
      'intake',
      'add',
      'app',
      '--id',
      'req-1',
      '--from',
      'kim',
      '--body-file',
      path,
    )
    expect(code).toBe(0)
    expect(
      JSON.parse(readFileSync(join(home, 'intake', 'req-1.0001.json'), 'utf8')).body,
    ).toContain('selection is empty')
  })

  it('says what the grant is, and the two sentences a person deciding needs', async () => {
    const off = await tade('intake', 'grant')
    expect(off.code).toBe(0)
    expect(off.stdout).toContain('surfaces.intake.enabled: false')
    expect(off.stdout).toContain('.from: nobody')
    expect(off.stdout).toContain('.mode: propose')
    expect(off.stdout).toContain('empty means nobody')
    // The half a control is tempted to leave out: whose words reach an agent
    // that runs as you, with your keys.
    expect(off.stdout).toContain('runs as you, with your keys')
  })

  it('says there is nothing in the spool rather than nothing at all', async () => {
    expect((await tade('intake', 'list')).stdout).toBe('nothing in the spool')
    await tade('intake', 'add', 'app', '--id', 'req-1', '--from', 'kim', '--body', 'a request')
    expect((await tade('intake', 'list', 'other')).stdout).toBe('nothing for other')
  })

  it('names a file in the spool it could not read', async () => {
    await tade('intake', 'add', 'app', '--id', 'req-1', '--from', 'kim', '--body', 'a request')
    writeFileSync(join(home, 'intake', 'hand-edited.json'), '{ not json')
    const { stdout, stderr } = await tade('intake', 'list')
    expect(stdout).toContain('cli:req-1')
    expect(stderr).toContain('hand-edited.json could not be read')
  })
})
