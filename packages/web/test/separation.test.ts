import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DRAFTS_ARE_NOT_PUBLISHED,
  DRAFTS_ARE_NOT_PUBLISHED_SHORT,
  INSTALLED_IS_NOT_REVOCABLE,
  INSTALLED_IS_NOT_REVOCABLE_SHORT,
  LAST_VIEW_IS_A_COPY,
  LAST_VIEW_IS_A_COPY_SHORT,
  LOCAL_ONLY_ACTS,
  LOCAL_ONLY_SHORT,
  OFFLINE_NEEDS_HTTPS,
  OFFLINE_NEEDS_HTTPS_SHORT,
  TALKING_IS_NOT_YOU,
  TALKING_IS_NOT_YOU_SHORT,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { readDraftSave, SAVINGS } from '../src/drafted.ts'
import { PUSHINGS, readSubscribe } from '../src/pushed.ts'
import { AUTH_BYTES, P256DH_BYTES } from '../src/pushing.ts'
import {
  ACTING_IS_NOT_YOU,
  ACTING_IS_NOT_YOU_SHORT,
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
  listenOn,
  loopbackHost,
  OFF,
  sameHost,
  scopesOn,
  surfaceOf,
  trusted,
} from '../src/surface.ts'
import { VERBS } from '../src/verbs.ts'

// Two things this package must never become, and the sentences it must never
// stop saying.

const SRC = new URL('../src/', import.meta.url).pathname

function sources(dir = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(at))
    else if (entry.name.endsWith('.ts')) out.push(at)
  }
  return out
}

const FILES = sources()

/**
 * One source with everything inside backticks taken out.
 *
 * These files name what they must never reach, in the comment that says they
 * do not reach it — so a test over the whole text fails on the explanation
 * rather than on the thing, and a test that fails on its own explanation is
 * one somebody deletes.
 */
function code(text: string): string {
  return text.replaceAll(/`[^`]*`/g, '``')
}

describe('the away server is not the ToolHost', () => {
  it('reaches neither the orchestrator nor a Unix socket', () => {
    // The `ToolHost` is a Unix socket in `@tade/orchestrator`, hosted by the
    // window for its own child agents: undiscoverable, nothing outside the
    // process tree may connect, dead when the window closes. This is a TCP
    // listener a person turns on, for a browser they paired, serving a
    // projection built to leave the machine. Different transport, different
    // authority, different threat model — and the only thing they share is
    // the process. A route that could reach the one from the other would hand
    // a phone every tool the orchestrator has.
    // **Reached, not mentioned**, throughout this file. Several of these
    // sources name the thing in the comment that says they do not touch it,
    // and a test that failed on its own explanation is one somebody deletes.
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      for (const banned of ['@tade/orchestrator', '@tade/app', '@tade/workbench', 'node:net'])
        if (text.includes(`'${banned}`)) problems.push(`${file} imports ${banned}`)
      // The socket itself, as a value rather than as a word in prose.
      for (const reached of ['new ToolHost', 'ToolHost.listen', 'toolHost.'])
        if (text.includes(reached)) problems.push(`${file} reaches ${reached}`)
    }
    expect(problems).toEqual([])
  })

  it('starts nothing: no spawn, no exec, no detached child', () => {
    // Everything Tade starts runs detached, and this starts nothing at all.
    // A server that could spawn is a server that is one route away from being
    // "run an arbitrary command", which is a `never remote` line.
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      for (const banned of [
        'node:child_process',
        'spawn(',
        'execFile(',
        'execSync',
        'spawnSync',
        // `.exec(` is a regular expression's own method and is everywhere in
        // the guard, so the shell forms are named individually rather than by
        // a substring that cannot tell the two apart.
        'exec(`',
        "exec('",
      ])
        if (text.includes(banned)) problems.push(`${file} uses ${banned}`)
    }
    expect(problems).toEqual([])
  })

  it('never reaches what writes a `said` line', () => {
    // `said` has exactly one writer and `namedBy` reads those lines to
    // authorise every `asked`-tier setting change on this machine. A page that
    // could put words in somebody's mouth would inherit authority over all of
    // them.
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} reaches remember()`).not.toMatch(/\.remember\s*\(/)
      expect(text, `${file} reaches say()`).not.toMatch(/\bwire\.say\s*\(/)
    }
  })

  it('writes no config: there is no setting any route can move', () => {
    const problems: string[] = []
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      // The writers by name, and no `config.yaml`: the path is named in prose
      // in three of these files, and what matters is that nothing calls a
      // function that moves a setting.
      for (const banned of ['writeSetting', 'writeKey', 'applySetting', 'writeFileSync'])
        if (text.includes(banned)) problems.push(`${file} uses ${banned}`)
    }
    expect(problems).toEqual([])
  })
})

describe('what a verb may never reach, as the verb table grows', () => {
  it('has no shape a name, a path or a command could be dispatched on', () => {
    // **The guarantee is the absence**, and this is where it stops being a
    // sentence in `acting.ts`. Every verb reaches the window by somebody
    // adding a method to `WebActing` and an entry to `VERBS`; what this
    // asserts is that nothing anybody added takes a name and dispatches on it.
    //
    // **Code, not prose**, which is the same correction the first test in this
    // file carries: `acting.ts` names every one of these in the comment that
    // says it does not have one, so what is read is the file with everything
    // inside backticks taken out. A test that failed on its own explanation is
    // one somebody deletes.
    const text = code(readFileSync(join(SRC, 'acting.ts'), 'utf8'))
    for (const shape of [
      'run(verb',
      'run(name',
      'call(tool',
      'startAgent',
      'setSetting',
      'writeSetting',
      'approveReview',
    ]) {
      expect(text, `acting.ts has ${shape}`).not.toContain(shape)
    }
  })

  it('declares exactly the methods the verb table has, and nothing else', () => {
    // Both directions, mechanically: a method with no verb is a door nothing
    // opens *yet*, which is the one a route somebody adds in a hurry finds —
    // and a verb with no method is a `404` nobody can explain. The names are
    // read out of the interface rather than out of an object, because the
    // interface is the thing a reviewer reads.
    const text = readFileSync(join(SRC, 'acting.ts'), 'utf8')
    const block = /export interface WebActing \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block, 'the WebActing block').not.toBe('')
    const methods = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map((one) => one[1])
    expect(methods.filter((one) => one !== 'unlocked').sort()).toEqual(
      VERBS.map((verb) => verb.name).sort(),
    )
  })

  it('declares exactly the one method the saving table has, and nothing else', () => {
    // Both directions, mechanically, exactly as `WebActing` is held to
    // `VERBS`: a method with no saving is a door nothing opens *yet*, which is
    // the one a route somebody adds in a hurry finds — and a saving with no
    // method is a `404` nobody can explain.
    const text = readFileSync(join(SRC, 'drafting.ts'), 'utf8')
    const block = /export interface WebDrafting \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block, 'the WebDrafting block').not.toBe('')
    const methods = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map((one) => one[1])
    expect(methods.filter((one) => one !== 'unlocked')).toEqual(Object.keys(SAVINGS))
  })

  it('declares exactly the two methods the notification table has, and nothing else', () => {
    // Both directions, mechanically, exactly as `WebActing` is held to `VERBS`
    // and `WebDrafting` to `SAVINGS`. The one that matters here is the
    // direction that would add a method: a `send` on this interface is one
    // line from a route, and a route is one line from a device able to make
    // this machine POST to an address of its choosing.
    const text = readFileSync(join(SRC, 'pushing.ts'), 'utf8')
    const block = /export interface WebPushing \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block, 'the WebPushing block').not.toBe('')
    const methods = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map((one) => one[1])
    expect(methods.filter((one) => one !== 'unlocked').sort()).toEqual(Object.keys(PUSHINGS).sort())
  })

  it('has no shape in the notification half that could send one or read one', () => {
    // The absences, in code. A `send` would make a device the thing that
    // decides when this machine reaches out; a `list` would answer with
    // another phone's endpoint, which is a URL at a push service with a
    // per-device token in it.
    const text = code(readFileSync(join(SRC, 'pushing.ts'), 'utf8'))
    for (const shape of ['send', 'notify', 'test', 'list', 'all', 'devices', 'endpoint(']) {
      expect(text.toLowerCase(), `pushing.ts has ${shape}`).not.toContain(
        `${shape.replace('(', '')}(`,
      )
    }
  })

  it('takes no path, no command and no device in a subscription’s body', () => {
    // The same cross-product the verbs and the saves get. The one that would
    // have got away is `device`: a body that could name one would be a phone
    // subscribing another, and the binding is the whole of what makes a
    // subscription safe.
    const every = {
      endpoint: 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
      p256dh: Buffer.alloc(P256DH_BYTES, 4).toString('base64url'),
      auth: Buffer.alloc(AUTH_BYTES, 7).toString('base64url'),
    }
    expect(readSubscribe(every).ok).toBe(true)
    for (const name of [
      'device',
      'path',
      'file',
      'cwd',
      'cmd',
      'command',
      'prompt',
      'setting',
      'scopes',
      'task',
      'project',
      'title',
      'body',
      'url',
    ]) {
      expect(readSubscribe({ ...every, [name]: 'anything' }).ok, name).toBe(false)
    }
  })

  it('has no shape in the saving half that could publish, make or remove one', () => {
    // The absences, in code: `DRAFTS_ARE_NOT_PUBLISHED` is the sentence and
    // these are what make it true. A `publish` on this interface would be one
    // line away from a route, and a route is one line away from a run.
    const text = code(readFileSync(join(SRC, 'drafting.ts'), 'utf8'))
    for (const shape of ['publish', 'reject', 'remove', 'rename', 'create', 'version']) {
      expect(text.toLowerCase(), `drafting.ts has ${shape}`).not.toContain(`${shape}(`)
    }
  })

  it('takes no path and no command in a save\u2019s body either', () => {
    // The same cross-product the verbs get. A draft is addressed by a name
    // Tade would have written, and the one that got away would not have been
    // a missing file: a name from outside joined onto a path reads somewhere
    // else entirely.
    const every = {
      template: 'reproduce-and-fix',
      was: 'sha256:aaaa',
      key: 'abcdefgh12345678',
      rev: 0,
    }
    for (const name of ['path', 'file', 'cwd', 'cmd', 'command', 'prompt', 'setting', 'scopes']) {
      expect(
        readDraftSave({
          ...every,
          scope: 'template',
          field: 'title',
          value: 'x',
          [name]: 'anything',
        }).ok,
        name,
      ).toBe(false)
    }
    for (const template of ['../../etc/passwd', '/etc/passwd', 'a/b', '~/x']) {
      expect(
        readDraftSave({ ...every, template, scope: 'template', field: 'title', value: 'x' }).ok,
        template,
      ).toBe(false)
    }
  })

  it('takes no path and no command in any verb\u2019s body, over the whole table', () => {
    // The same cross-product `test/verbs.test.ts` runs, asserted here too and
    // on purpose: that file is about what a body parses to, and this one is
    // about the claims this package makes. A verb that accepted one of these
    // is the one that turns a request from a phone into execution.
    const every = {
      task: 'tade/away-steer-and-edit',
      was: 'p0.a0.q0.g0.f0.knone',
      key: 'abcdefgh12345678',
      rev: 0,
    }
    for (const verb of VERBS) {
      for (const name of ['path', 'file', 'cwd', 'cmd', 'command', 'prompt', 'setting', 'scopes']) {
        expect(verb.read({ ...every, [name]: 'anything' }).ok, `${verb.name} ${name}`).toBe(false)
      }
    }
  })
})

describe('what the surface is turned on as', () => {
  it('is off, on this machine, by default', () => {
    expect(OFF.enabled).toBe(false)
    expect(OFF.bind).toBe('loopback')
    expect(listenOn(OFF)).toEqual([])
  })

  it('reads a config that says nothing as off', () => {
    const surface = surfaceOf({
      enabled: false,
      bind: 'lan',
      port: 7654,
      trusted_hosts: ['x'],
      acting: false,
      orchestrator: false,
      push: false,
      push_details: false,
      drafts: false,
      install: false,
      offline: false,
    })
    // `lan` with `enabled: false` is **off**, not "on the network and
    // waiting": two decisions, and the one deciding whether anything listens
    // is read first. Nothing here can turn on what the file did not.
    expect(surface.enabled).toBe(false)
    expect(surface.bind).toBe('loopback')
    expect(surface.trustedHosts).toEqual([])
    expect(listenOn(surface)).toEqual([])
  })

  it('narrows a kept view under installing, which is narrowed under enabled', () => {
    // Three keys and one direction: nothing here can turn on what the file did
    // not, and `offline` is read **under** `install` rather than beside it —
    // what it is for is the cold open, and there is no cold open without a
    // shell to open. A key that could be on while nothing could read it is a
    // setting Tade accepts and ignores.
    const web = {
      enabled: true,
      bind: 'loopback' as const,
      port: 7654,
      trusted_hosts: [],
      acting: false,
      orchestrator: false,
      push: false,
      push_details: false,
      drafts: false,
      install: true,
      offline: true,
    }
    expect(surfaceOf(web)).toMatchObject({ installing: true, keepsView: true })
    expect(surfaceOf({ ...web, install: false })).toMatchObject({
      installing: false,
      keepsView: false,
    })
    expect(surfaceOf({ ...web, offline: false })).toMatchObject({
      installing: true,
      keepsView: false,
    })
    expect(surfaceOf({ ...web, enabled: false })).toMatchObject({
      installing: false,
      keepsView: false,
    })
  })

  it('listens on two addresses, explicitly, for each bind', () => {
    // `::` with `ipv6Only: false` accepts IPv4-mapped connections on many
    // systems and not all, so one listener would make which addresses are
    // served a property of the machine rather than of the setting.
    expect(
      listenOn(
        surfaceOf({
          enabled: true,
          bind: 'loopback',
          port: 1,
          trusted_hosts: [],
          acting: false,
          orchestrator: false,
          push: false,
          push_details: false,
          drafts: false,
          install: false,
          offline: false,
        }),
      ),
    ).toEqual(['127.0.0.1', '::1'])
    expect(
      listenOn(
        surfaceOf({
          enabled: true,
          bind: 'lan',
          port: 1,
          trusted_hosts: [],
          acting: false,
          orchestrator: false,
          push: false,
          push_details: false,
          drafts: false,
          install: false,
          offline: false,
        }),
      ),
    ).toEqual(['0.0.0.0', '::'])
  })

  it('knows this machine in each of its spellings, and nothing else', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
    ])
      expect(loopbackHost(host), host).toBe(true)
    for (const host of [
      'localhost.evil.example',
      '192.168.1.10',
      '10.0.0.1',
      '0.0.0.0',
      '127.0.0.1.evil.example',
    ])
      expect(loopbackHost(host), host).toBe(false)
  })

  it('compares a host without its brackets or its case', () => {
    expect(sameHost('[::1]', '::1')).toBe(true)
    expect(sameHost('Studio.TS.NET', 'studio.ts.net')).toBe(true)
    expect(sameHost('a.example', 'b.example')).toBe(false)
  })
})

describe('what a session minted on an origin may ever do', () => {
  const lan = surfaceOf({
    enabled: true,
    bind: 'lan',
    port: 7654,
    trusted_hosts: ['studio.yak-bebop.ts.net'],
    acting: true,
    orchestrator: false,
    push: false,
    push_details: false,
    drafts: false,
    install: false,
    offline: false,
  })

  it('is everything it was granted, from this machine', () => {
    expect(trusted({ scheme: 'http', host: '127.0.0.1' }, lan)).toBe(true)
    expect(scopesOn({ scheme: 'http', host: 'localhost' }, lan, ['read', 'steer'])).toEqual([
      'read',
      'steer',
    ])
  })

  it('is everything it was granted, over https to a host the config trusts', () => {
    expect(trusted({ scheme: 'https', host: 'studio.yak-bebop.ts.net' }, lan)).toBe(true)
    expect(
      scopesOn({ scheme: 'https', host: 'studio.yak-bebop.ts.net' }, lan, ['read', 'answer']),
    ).toEqual(['read', 'answer'])
  })

  it('is read and nothing else over plain HTTP off this machine', () => {
    // DECISIONS §4.3: `bind: lan` is a read-only transport. A credential that
    // travelled in the clear across a network never buys an act, whatever is
    // turned on later — not a flag that could be raised, not a scope a grant
    // could widen.
    expect(trusted({ scheme: 'http', host: '192.168.1.10' }, lan)).toBe(false)
    expect(
      scopesOn({ scheme: 'http', host: '192.168.1.10' }, lan, ['read', 'steer', 'ask']),
    ).toEqual(['read'])
  })

  it('is nothing at all for an https host nobody wrote down', () => {
    // An `https` origin Tade was never told about is somebody else's name
    // resolving here.
    expect(trusted({ scheme: 'https', host: 'evil.example' }, lan)).toBe(false)
    expect(scopesOn({ scheme: 'https', host: 'evil.example' }, lan, ['read', 'steer'])).toEqual([
      'read',
    ])
  })

  it('grants nothing to a device that was granted nothing', () => {
    expect(scopesOn({ scheme: 'http', host: '127.0.0.1' }, lan, [])).toEqual([])
    expect(scopesOn({ scheme: 'http', host: '192.168.1.10' }, lan, [])).toEqual([])
  })
})

describe('the sentences', () => {
  it('say what a LAN is, and the way out in the same breath', () => {
    expect(LAN_IS_PLAINTEXT).toContain('plain HTTP')
    expect(LAN_IS_PLAINTEXT).toContain('same wifi')
    expect(LAN_IS_PLAINTEXT).toContain('tailscale serve')
  })

  it('never promise a LAN is private', () => {
    for (const sentence of [
      LAN_IS_PLAINTEXT,
      COOKIES_IGNORE_PORTS,
      DEVICES_AND_AGENTS,
      ACTING_IS_NOT_YOU,
    ])
      for (const word of ['secure', 'encrypted', 'private', 'safe'])
        expect(sentence.toLowerCase(), `${word} in ${sentence.slice(0, 30)}`).not.toContain(word)
  })

  it('say a cookie prefix does not isolate ports, which is what it gets named as', () => {
    expect(COOKIES_IGNORE_PORTS).toContain('not isolated by port')
    expect(COOKIES_IGNORE_PORTS).toContain('no cookie prefix changes that')
    // And name the two mitigations that are real, because a correction with no
    // answer in it is one people scroll past.
    expect(COOKIES_IGNORE_PORTS).toContain('exact host')
    expect(COOKIES_IGNORE_PORTS).toContain('TLS')
  })

  it('say what a secure origin is, and that a private address is not one', () => {
    // The fact that surprises people, and the reason it has to be said rather
    // than discovered: a browser refuses all of this off a plain address on a
    // network and explains nothing. `127.0.0.0/8`, `::1` and `localhost` are
    // potentially trustworthy origins; `192.168.*` and `10.*` over plain HTTP
    // are not, however local they feel.
    expect(OFFLINE_NEEDS_HTTPS).toContain('secure origin')
    expect(OFFLINE_NEEDS_HTTPS).toContain('localhost')
    expect(OFFLINE_NEEDS_HTTPS).toContain('not one')
    // And the way out, in the same breath as the refusal.
    expect(OFFLINE_NEEDS_HTTPS).toContain('tailscale serve')
    expect(OFFLINE_NEEDS_HTTPS).toContain('Trusted hostnames')
    // The half people get wrong about the way out: a new name is a new
    // pairing, because a session is bound to the host it was minted on.
    expect(OFFLINE_NEEDS_HTTPS).toContain('pairs again')
    expect(OFFLINE_NEEDS_HTTPS).toContain('nothing is carried across')
    expect(OFFLINE_NEEDS_HTTPS_SHORT).toContain('LAN address is not')
  })

  it('say a 404 does not uninstall, which is the comfortable version of it', () => {
    // The whole reason `/sw.js` answers in both states. A sentence that said
    // *turning it off removes it* would be the easy half, and would be read
    // as a promise about a phone in a drawer.
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('on that device')
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('404')
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('next time that device')
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('never comes back')
    // And what stands instead: what is on the disk is the page and nothing of
    // the work, which is the thing that makes the rest survivable.
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('no project, no task, no note')
    expect(INSTALLED_IS_NOT_REVOCABLE).toContain('without a session')
    expect(INSTALLED_IS_NOT_REVOCABLE_SHORT).toContain('not before')
    for (const comfortable of ['erased', 'wiped', 'removed everywhere', 'guarantee'])
      expect(INSTALLED_IS_NOT_REVOCABLE.toLowerCase(), comfortable).not.toContain(comfortable)
  })

  it('list what a kept view holds rather than calling it minimal', () => {
    // *Minimal* and *redacted* are the words a comfortable version of this
    // would keep while dropping what was actually on the disk. So the list is
    // the sentence, and `test/offline.test.ts` holds the record to it.
    expect(LAST_VIEW_IS_A_COPY).toContain('counts and the moment')
    expect(LAST_VIEW_IS_A_COPY).toContain('no text at all')
    for (const never of ['no title', 'no intent', 'no note', 'no request', 'no name'])
      expect(LAST_VIEW_IS_A_COPY, never).toContain(never)
    expect(LAST_VIEW_IS_A_COPY).toContain('nothing can be acted on')
    expect(LAST_VIEW_IS_A_COPY).toContain('cannot be taken back')
    expect(LAST_VIEW_IS_A_COPY_SHORT).toContain('no text')
  })

  it('narrow what HttpOnly does, rather than calling it an answer to XSS', () => {
    expect(HTTPONLY_IS_NOT_XSS).toContain('does not keep one from using it')
    expect(HTTPONLY_IS_NOT_XSS).toContain('builds no markup')
    expect(HTTPONLY_IS_NOT_XSS.toLowerCase()).not.toContain('survives')
  })

  it('say what a device acting is, and name what it can never reach', () => {
    // **The list is the load-bearing half**, and it is asserted item by item:
    // every one of these is a `never remote` line with an argument behind it
    // (DESIGN §9.1), and a control that quietly stopped naming one would be
    // the comfortable version of this sentence.
    expect(ACTING_IS_NOT_YOU).toContain('never your own words')
    for (const never of [
      'change a setting',
      'read a credential',
      'run a command',
      'start an agent',
      'push',
      'merge',
      'overrule a check',
    ]) {
      expect(ACTING_IS_NOT_YOU, never).toContain(never)
    }
    // And what acting needs, with the way out in the same breath.
    expect(ACTING_IS_NOT_YOU).toContain('https origin you named')
    expect(ACTING_IS_NOT_YOU).toContain('in the clear')
    expect(ACTING_IS_NOT_YOU).toContain('journal under the device')
  })

  it('names what every verb there is actually does, so the sentence cannot fall behind', () => {
    // **The failure this catches is a verb shipping and the sentence not
    // moving.** It is the one place a person deciding whether to turn acting
    // on reads what they are turning on, and the half that would quietly stop
    // being said is the half that grew. One clause per verb, matched loosely
    // because the sentence is prose and not a list — what is held is that each
    // verb's own act is in it somewhere.
    const said = ACTING_IS_NOT_YOU.toLowerCase()
    const names: Record<string, string> = {
      park: 'hold or release',
      answer: 'answer what an agent is waiting on',
      steer: 'tell one something',
      queue: 'queued work',
      done: 'mark work finished',
      note: 'a note',
      context: 'what a task is told',
      intake: 'approve a request',
    }
    expect(Object.keys(names).sort()).toEqual(VERBS.map((verb) => verb.name).sort())
    for (const [verb, clause] of Object.entries(names)) {
      expect(said, `${verb}: ${clause}`).toContain(clause)
    }
  })

  it('say what a device talking to Tade is, and what the narrowing actually is', () => {
    // **The sentence that must never get comfortable**, and the clause that
    // would go first is the one saying what stands against a stranger's words:
    // a closed list of tools, in code. A control that said *Tade is careful
    // with messages from away* would be this sentence with its argument taken
    // out.
    expect(TALKING_IS_NOT_YOU).toContain('never your own words')
    expect(TALKING_IS_NOT_YOU).toContain('cannot authorise a setting change')
    expect(TALKING_IS_NOT_YOU).toContain('refused in code')
    for (const never of [
      'no setting',
      'no credential',
      'no command',
      'no new agent',
      'no push',
      'no merge',
      'no check overruled',
    ]) {
      expect(TALKING_IS_NOT_YOU, never).toContain(never)
    }
    // And where it is: the transcript, marked, and the journal under the id.
    expect(TALKING_IS_NOT_YOU).toContain('transcript')
    expect(TALKING_IS_NOT_YOU).toContain('journal under its id')
    for (const word of ['secure', 'encrypted', 'private', 'safe', 'harmless']) {
      expect(TALKING_IS_NOT_YOU.toLowerCase(), word).not.toContain(word)
    }
  })

  it('say what stays an act at the machine, as a list rather than a promise', () => {
    // **The list is the load-bearing half**, and every one of these has no
    // route at all — `test/routes.test.ts` reads the same names against the
    // whole of what the listener can serve. A control that quietly stopped
    // naming one would be the comfortable version of this sentence.
    for (const never of [
      'Publishing a workflow',
      'turning a source on',
      'granting an account or a tool',
      'changing what a device may do',
      'no route at all',
    ]) {
      expect(LOCAL_ONLY_ACTS, never).toContain(never)
    }
    // And what a granted device *can* do, in the same breath: a page that
    // only listed refusals would read as a surface nobody finished.
    for (const can of ['approve a request', 'follow what the work does', 'save a draft']) {
      expect(LOCAL_ONLY_ACTS, can).toContain(can)
    }
    expect(LOCAL_ONLY_SHORT.length).toBeLessThan(70)
  })

  it('say what a draft is, and name the five things saving one can never reach', () => {
    // The sentence that must never get comfortable. The clause that would go
    // first is the one saying what a draft *is* — a file no run reads — because
    // without it "bounded" is the whole claim.
    expect(DRAFTS_ARE_NOT_PUBLISHED).toContain('no run reads')
    for (const never of [
      'publish one',
      'make one',
      'rename one',
      'delete one',
      'published version',
    ]) {
      expect(DRAFTS_ARE_NOT_PUBLISHED, never).toContain(never)
    }
    // And the bound, named rather than described: one field at a time, through
    // the same validator the file goes through.
    expect(DRAFTS_ARE_NOT_PUBLISHED).toContain('one field at a time')
    expect(DRAFTS_ARE_NOT_PUBLISHED).toContain('same validator')
    expect(DRAFTS_ARE_NOT_PUBLISHED).toContain('an act at this machine')
    for (const word of ['secure', 'encrypted', 'private', 'safe', 'harmless']) {
      expect(DRAFTS_ARE_NOT_PUBLISHED.toLowerCase(), word).not.toContain(word)
    }
    expect(DRAFTS_ARE_NOT_PUBLISHED_SHORT.length).toBeLessThan(80)
  })

  it('have a short clause for the one line a control gets', () => {
    expect(TALKING_IS_NOT_YOU_SHORT.length).toBeLessThan(70)
    expect(TALKING_IS_NOT_YOU_SHORT).toContain('never as your own words')
    // Short enough to sit on a row beside a control, and still carrying the
    // half that matters: that a request from a device is a request.
    expect(ACTING_IS_NOT_YOU_SHORT).toContain('never as your own words')
    expect(ACTING_IS_NOT_YOU_SHORT.length).toBeLessThan(80)
    // And neither of them says a device acts *for* the person, which is the
    // comfortable phrasing that would make `namedBy` sound like it applied.
    for (const sentence of [ACTING_IS_NOT_YOU, ACTING_IS_NOT_YOU_SHORT]) {
      for (const comfortable of ['on your behalf', 'as if you', 'as though you']) {
        expect(sentence.toLowerCase(), comfortable).not.toContain(comfortable)
      }
    }
  })
})

describe('where a notification goes is a setting and never the environment', () => {
  /** The one file that opens a socket to an address a browser chose. */
  const sender = code(readFileSync(join(SRC, 'push-out.ts'), 'utf8'))

  it('calls the library for the cryptography and never for the sending', () => {
    // `web-push` is here as the harness for two protocols (RFC 8292, RFC 8188)
    // and for nothing else. Its own sender resolves the endpoint again — which
    // is the DNS-rebinding bug with a validator in front of it, because
    // `endpoint.ts` checked *an address* and the library would look the name
    // up a second time. So the socket is Tade's, with a `lookup` that answers
    // with the address that was checked.
    //
    // The behaviour tests beside this one would notice the swap by going red
    // on a request stub nothing called; this notices it in the source, which
    // is where somebody reading the file for the first time looks.
    const called = [...sender.matchAll(/webpush\.(\w+)/g)].map((found) => found[1])
    expect([...new Set(called)].sort()).toEqual(['generateRequestDetails', 'generateVAPIDKeys'])
  })

  it('reads no environment variable anywhere in this package', () => {
    // **The second reason the socket is Tade's.** `https-proxy-agent`, which
    // `web-push`'s sender uses, honours `HTTPS_PROXY` — so on a machine with
    // one set, *where Tade sends something* would be decided by a variable
    // rather than by a setting, and that is a `never` in `reach.ts`'s own
    // words. Asked of the whole package rather than of the sender, because the
    // property worth having is that nothing in the away view's data boundary
    // has an environment to be steered by.
    for (const file of FILES) {
      expect(code(readFileSync(file, 'utf8')), file).not.toContain('process.env')
    }
  })
})
