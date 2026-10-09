import { describe, expect, it } from 'vitest'
import type { From, Outcome, ParkCall, WebActing } from '../src/acting.ts'
import { taskRev } from '../src/acting.ts'
import { ACTS, ROUTES, routeFor, routesFor } from '../src/routes.ts'
import { boundTo, KEY, PARK, VERBS, verbFor } from '../src/verbs.ts'
import { BASE } from './harness.ts'

// The table of what a device may ask for, and the shape of an ask.
//
// **What these are about is the half a type cannot say.** That a verb is a
// target plus the state it expects, that a name nobody declared is not a verb,
// that a key is bound to what was actually asked for rather than to the bytes
// that carried it, and that the acting routes are absent until a person turns
// them on. Each of those is a sentence in `verbs.ts` and each is a crafted
// call away from being false.

const BODY = {
  task: 'tade/away-action-gate',
  parked: true,
  was: 'p0',
  key: 'abcdefgh12345678',
  rev: 4,
}

function asked(over: Record<string, unknown> = {}) {
  const got = PARK.read({ ...BODY, ...over })
  if (!got.ok) throw new Error('that body did not parse')
  return got.asked
}

describe('the verb table', () => {
  it('is closed: a name nobody declared is not a verb', () => {
    expect(verbFor('park')).not.toBeNull()
    // The four shapes somebody would try. None of them is a verb, and none of
    // them is a near miss that a prefix or a case-insensitive lookup would let
    // through — `verbFor` is an equality test against a literal list.
    for (const name of ['', 'Park', 'park ', 'park/../exec', 'exec', 'startAgent', 'settings']) {
      expect(verbFor(name), name).toBeNull()
    }
  })

  it('expresses every verb as a target plus the state it expects', () => {
    // DECISIONS §4.6, mechanically: a verb whose body has no `was` is a verb
    // whose replay cannot be refused by a state re-check, and the nonce is
    // only ever a fast path. This is the assertion that keeps the next verb
    // honest rather than the comment above it.
    for (const verb of VERBS) {
      expect(verb.read({ ...BODY, was: undefined }).ok, `${verb.name} with no was`).toBe(false)
      expect(verb.read({ ...BODY, task: undefined }).ok, `${verb.name} with no task`).toBe(false)
      expect(verb.read({ ...BODY, key: undefined }).ok, `${verb.name} with no key`).toBe(false)
    }
  })

  it('needs a scope out of the matrix, and park needs steer', () => {
    // §9.1 puts park at the steer tier. Asserted rather than assumed, because
    // a verb filed one tier too low is a device granted `answer` parking work.
    expect(PARK.needs).toBe('steer')
    for (const verb of VERBS) expect(['answer', 'steer', 'ask']).toContain(verb.needs)
  })
})

describe('reading a body', () => {
  it('refuses a field nobody declared, rather than ignoring it', () => {
    // Strict, so a crafted body cannot carry something along in the hope that
    // a later field name becomes meaningful.
    expect(PARK.read({ ...BODY, by: 'you' }).ok).toBe(false)
    expect(PARK.read({ ...BODY, scopes: ['steer'] }).ok).toBe(false)
  })

  it('refuses a task id that is not one', () => {
    for (const task of [
      '',
      'tade',
      '../../etc/passwd',
      'tade/../other',
      'tade/away/extra',
      'TADE/Away',
      'tade/away action',
    ]) {
      expect(PARK.read({ ...BODY, task }).ok, task).toBe(false)
    }
  })

  it('refuses a key that is not a key, and a revision that is not one', () => {
    for (const key of ['', 'short', 'a'.repeat(65), 'has space 1234567', 'a/../b1234567890']) {
      expect(PARK.read({ ...BODY, key }).ok, key).toBe(false)
    }
    expect(KEY.test('abcdefgh12345678')).toBe(true)
    for (const rev of [-1, 1.5, '4', null]) {
      expect(PARK.read({ ...BODY, rev }).ok, String(rev)).toBe(false)
    }
  })

  it('refuses a parked that is not a boolean, rather than taking it as one', () => {
    // `'false'`, `0` and `null` are all the shapes a loose parse reads as the
    // wrong answer, and the wrong answer here is parking work nobody parked.
    for (const parked of ['true', 'false', 0, 1, null]) {
      expect(PARK.read({ ...BODY, parked }).ok, String(parked)).toBe(false)
    }
  })

  it('carries the project out of the task id, which is the scope boundary', () => {
    expect(asked().project).toBe('tade')
  })
})

describe('what a key is bound to', () => {
  it('is the device, the verb, the target and the payload, and nothing else', () => {
    const bound = boundTo('00112233445566aa', asked())
    expect(bound).toBe('00112233445566aa\npark\ntade/away-action-gate\nparked=true')
  })

  it('is the same for two bodies that differ only in how they were written', () => {
    // The canonical form is built from the parsed fields, so key order and
    // whitespace cannot make one act look like two — and `rev`, which is about
    // the screen rather than about the act, is deliberately not in it.
    const one = boundTo('00112233445566aa', asked({ rev: 4 }))
    const two = boundTo('00112233445566aa', asked({ rev: 9 }))
    expect(one).toBe(two)
  })

  it('differs for a different device, task, verb or payload', () => {
    const mine = boundTo('00112233445566aa', asked())
    expect(boundTo('00112233445566bb', asked())).not.toBe(mine)
    expect(boundTo('00112233445566aa', asked({ parked: false }))).not.toBe(mine)
    expect(boundTo('00112233445566aa', asked({ task: 'tade/away-projection' }))).not.toBe(mine)
  })
})

describe('what running one reaches', () => {
  it('is the verb\u2019s own method, with the provenance carried in', async () => {
    const calls: { call: ParkCall; from: From }[] = []
    const acting: WebActing = {
      unlocked: () => true,
      park: (call, from) => {
        calls.push({ call, from })
        return Promise.resolve<Outcome>({ did: true, rev: 'p1', said: 'set aside' })
      },
    }
    await asked().run(acting, { how: 'remote', device: '00112233445566aa' })
    expect(calls).toEqual([
      {
        call: { task: 'tade/away-action-gate', was: 'p0', parked: true },
        from: { how: 'remote', device: '00112233445566aa' },
      },
    ])
  })
})

describe('the route table', () => {
  it('has no acting route at all until a person turns it on', () => {
    // **Read-only enforced by absence, and this is the assertion of it.** Not
    // "the route refuses", which a bug can get past — there is no route, so a
    // crafted call is the `404` of a path nobody built.
    expect(routesFor({ ...BASE, acting: false })).toEqual(ROUTES)
    expect(routeFor('POST', '/api/act/park', routesFor({ ...BASE, acting: false }))).toBeNull()
    expect(routeFor('POST', '/api/act/park', routesFor({ ...BASE, acting: true }))).not.toBeNull()
  })

  it('has one path per verb, each carrying its own scope', () => {
    expect(ACTS.map((route) => route.path)).toEqual(['/api/act/park'])
    for (const route of ACTS) {
      expect(route.method).toBe('POST')
      expect(route.mutates).toBe(true)
      // Never public and never the pairing route: both would take the whole
      // credential layer off a verb.
      expect(route.public).toBeUndefined()
      expect(route.opens).toBeUndefined()
      const verb = verbFor(route.verb ?? '')
      expect(verb?.needs).toBe(route.needs)
    }
  })

  it('answers nothing for a verb that is not in the table, under any method', () => {
    const table = routesFor({ ...BASE, acting: true })
    for (const path of ['/api/act', '/api/act/', '/api/act/exec', '/api/act/park/extra']) {
      expect(routeFor('POST', path, table), path).toBeNull()
    }
    // And not under another method either: a `GET` of a verb is a `404` rather
    // than a `405`, because a `405` says the path is real.
    expect(routeFor('GET', '/api/act/park', table)).toBeNull()
    expect(routeFor('DELETE', '/api/act/park', table)).toBeNull()
  })

  it('takes no path, no command and no setting, in either table', () => {
    // The shape of every `never remote` line, asserted as the absence of a
    // parameter it could arrive in. DESIGN §9.4's own test, extended to the
    // acting half: a route with a `path`, `file`, `dir`, `cmd` or `setting`
    // parameter is the one that turns a verb into arbitrary execution.
    for (const route of [...ROUTES, ...ACTS]) {
      for (const name of [':path', ':file', ':dir', ':cmd', ':command', ':setting', ':key']) {
        expect(route.path.includes(name), `${route.name} ${name}`).toBe(false)
      }
    }
  })
})

describe('a task’s own revision', () => {
  it('is one rule, so the two sides cannot disagree', () => {
    expect(taskRev({ parked: true })).toBe('p1')
    expect(taskRev({ parked: false })).toBe('p0')
    expect(taskRev({ parked: true })).not.toBe(taskRev({ parked: false }))
  })
})
