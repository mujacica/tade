import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  projectDir,
  recordsDir,
  remoteDocumentPath,
  runtimeDir,
  tadeHome,
  taskDir,
  taskFolder,
} from '../src/home.ts'

// Where everything Tade writes about a project goes, and the one way that
// could go wrong.
//
// These are the only roots: a project's folder for what is about the checkout
// everybody shares, a task's for what is about one task's own directory. They
// are pure — nothing here reads or writes anything — so what is worth holding
// is the shape they make and the names they refuse.

describe('where a project and a task are kept', () => {
  const home = '/h/.tade'

  it('is one folder per project, and one per task under it', () => {
    expect(projectDir(home, 'shop')).toBe('/h/.tade/projects/shop')
    expect(taskDir(home, 'shop/refunds')).toBe('/h/.tade/projects/shop/tasks/refunds')
  })

  it('flattens a task id rather than making a folder per level', () => {
    // `tasks/a/b` and the task `a` would otherwise be the same folder.
    expect(taskFolder('shop/a/b')).toBe('a-b')
    expect(taskDir(home, 'shop/a/b')).toBe('/h/.tade/projects/shop/tasks/a-b')
  })

  it('gives a task its own records only when it has a directory of its own', () => {
    // Every task in a project's checkout shares it, so they share one set of
    // records and one lock: four agents there must never start four suites.
    expect(recordsDir(home, 'shop')).toBe('/h/.tade/projects/shop')
    expect(recordsDir(home, 'shop', null)).toBe('/h/.tade/projects/shop')
    expect(recordsDir(home, 'shop', 'shop/refunds')).toBe('/h/.tade/projects/shop/tasks/refunds')
  })

  it('refuses a name that would climb out of the folder above it', () => {
    // A project's name comes out of `config.yaml` and a task's id can reach
    // here as whatever a model put in a tool call. Both are checked by a
    // schema first; this is what stops a path being built out of one that was
    // not. It throws rather than sanitising, because writing to a different
    // folder than the caller asked for is the worse failure.
    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      expect(() => projectDir(home, bad), bad).toThrow(/not a name Tade can make a folder from/)
    }
    for (const bad of ['../../etc/passwd', '..', 'shop/..', 'shop/']) {
      expect(() => taskDir(home, bad), bad).toThrow(/not a name Tade can make a folder from/)
    }
  })
})

describe('the home itself', () => {
  it('is `~/.tade` unless TADE_HOME says otherwise', () => {
    expect(tadeHome({})).toBe(join(homedir(), '.tade'))
    expect(tadeHome({ TADE_HOME: '/somewhere/else' })).toBe('/somewhere/else')
  })
})

describe('where a copy of another machine’s document is kept', () => {
  it('is under that machine’s name, the project and the task’s own folder', () => {
    expect(remoteDocumentPath('/h', 'vps', 'tade/research', 'PLAN.md')).toBe(
      join('/h', 'remotes', 'vps', 'documents', 'tade', 'research', 'PLAN.md'),
    )
  })

  it('refuses every part that would walk out of it, rather than joining it', () => {
    for (const [machine, task, name] of [
      ['../vps', 'tade/research', 'PLAN.md'],
      ['vps', '../tade/research', 'PLAN.md'],
      ['vps', 'tade/../../x', 'PLAN.md'],
      ['vps', 'tade', 'PLAN.md'],
      ['vps', 'tade/research', '../config.yaml'],
      ['vps', 'tade/research', 'a/b'],
      ['vps', 'tade/research', '..'],
      ['vps', 'tade/research', 'a\\b'],
    ] as const) {
      expect(
        () => remoteDocumentPath('/h', machine, task, name),
        `${machine} ${task} ${name}`,
      ).toThrow()
    }
  })
})

describe('where a home’s sockets go', () => {
  it('is a short folder named after the home, the same for the same home', () => {
    const at = runtimeDir('/h/.tade', {})
    expect(dirname(at)).toBe(tmpdir())
    expect(basename(at)).toMatch(/^tade-[0-9a-f]{8}$/)
    expect(runtimeDir('/h/.tade', {})).toBe(at)
    expect(runtimeDir('/other/.tade', {})).not.toBe(at)
  })

  it('is the runtime folder the session has, and Tade’s own over that', () => {
    const name = basename(runtimeDir('/h/.tade', {}))
    expect(runtimeDir('/h/.tade', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      `/run/user/1000/${name}`,
    )
    // Without moving XDG_RUNTIME_DIR, which systemctl --user finds its manager by.
    const both = { XDG_RUNTIME_DIR: '/run/user/1000', TADE_RUNTIME_DIR: '/tmp/suite' }
    expect(runtimeDir('/h/.tade', both)).toBe(`/tmp/suite/${name}`)
    expect(runtimeDir('/h/.tade', { TADE_RUNTIME_DIR: '', XDG_RUNTIME_DIR: '/r' })).toBe(
      `/r/${name}`,
    )
  })
})
