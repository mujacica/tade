import { describe, expect, it } from 'vitest'
import type { From, Outcome, ParkCall, WebActing } from '../src/acting.ts'
import { BOUNDS, taskRev } from '../src/acting.ts'
import { ACTS, ROUTES, routeFor, routesFor } from '../src/routes.ts'
import {
  ANSWER,
  boundTo,
  CONTEXT,
  DONE,
  INTAKE,
  KEY,
  NOTE,
  PARK,
  QUEUE,
  STEER,
  VERBS,
  type Verb,
  verbFor,
} from '../src/verbs.ts'
import { actingStub, BASE, facts } from './harness.ts'

// The table of what a device may ask for, and the shape of an ask.
//
// **What these are about is the half a type cannot say.** That a verb is a
// target plus the state it expects, that a name nobody declared is not a verb,
// that a key is bound to what was actually asked for rather than to the bytes
// that carried it, and that the acting routes are absent until a person turns
// them on. Each of those is a sentence in `verbs.ts` and each is a crafted
// call away from being false.

/** The four fields every verb's body carries, and nothing else. */
const EVERY = {
  task: 'tade/away-action-gate',
  was: 'p0',
  key: 'abcdefgh12345678',
  rev: 4,
}

/** A park body: `EVERY` plus the one field park declares. */
const BODY = { ...EVERY, parked: true }

/**
 * One valid body per verb, by name.
 *
 * Written out rather than built, because the two cross-product tests below
 * need a body that **parses** for every verb before they can show that one
 * extra field makes it stop parsing — and a body built by guessing which
 * fields a verb takes would be a test about the guessing.
 */
const BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  park: { ...EVERY, parked: true },
  answer: { ...EVERY, approval: 'req-1', allow: true },
  steer: { ...EVERY, said: 'try the other migration' },
  queue: { ...EVERY, change: 'pause' },
  done: { ...EVERY, confirm: true, summary: 'the migration runs' },
  note: { ...EVERY, text: 'the fix is in the adapter' },
  context: { ...EVERY, add: 'the ticket says the column is nullable' },
  intake: { ...EVERY, confirm: true },
}

/** That verb's own valid body, with whatever a test wants changed. */
function bodyFor(verb: Verb, over: Record<string, unknown> = {}): Record<string, unknown> {
  const made = BODIES[verb.name]
  if (made === undefined) throw new Error(`no body written for ${verb.name}`)
  return { ...made, ...over }
}

/** Every word of free text any body above carries, for the leakage check. */
const TYPED = [
  'try the other migration',
  'the migration runs',
  'the fix is in the adapter',
  'the ticket says the column is nullable',
]

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
      expect(verb.read(bodyFor(verb)).ok, `${verb.name} body`).toBe(true)
      for (const name of ['was', 'task', 'key', 'rev']) {
        const body = bodyFor(verb, { [name]: undefined })
        expect(verb.read(body).ok, `${verb.name} with no ${name}`).toBe(false)
      }
    }
  })

  it('needs a scope out of the matrix, and each one is written down here', () => {
    // §9.1's matrix, as a table, because a verb filed one tier too low is a
    // device granted `answer` doing something at the `steer` tier. The two
    // gentle ones are gentle for the same reason: they answer something that
    // is **already waiting** and change nothing Tade would start by itself.
    // Everything else changes what gets done, and `done` changes what *other*
    // work does, which is the argument for its tier rather than a feeling
    // about buttons.
    expect(new Map(VERBS.map((verb) => [verb.name, verb.needs]))).toEqual(
      new Map([
        ['park', 'steer'],
        ['answer', 'answer'],
        ['steer', 'steer'],
        ['queue', 'steer'],
        ['done', 'steer'],
        ['note', 'steer'],
        ['context', 'steer'],
        ['intake', 'answer'],
      ]),
    )
    // And none of them needs `read`, which would be every paired device.
    for (const verb of VERBS) expect(['answer', 'steer', 'ask']).toContain(verb.needs)
  })

  it('has a name and a sentence each, and no two share a name', () => {
    const names = VERBS.map((verb) => verb.name)
    expect(new Set(names).size).toBe(names.length)
    for (const verb of VERBS) {
      expect(verb.about.length, verb.name).toBeGreaterThan(10)
      // A name that is a path segment and nothing else: it goes straight into
      // a route's path, so anything with a separator or a dot in it would be
      // a path this table decided rather than a name.
      expect(verb.name, verb.name).toMatch(/^[a-z]+$/)
    }
  })

  it('takes no path, no command, no prompt and no setting, in any body', () => {
    // **The shape of every `never remote` line, asserted as the absence of a
    // field one could arrive in.** A verb that accepted any of these would be
    // the one that turns a request from a phone into a repository edit, a
    // command, a new agent or a widened grant — and none of them is refused
    // here, because the strict parse means there is nowhere to put one.
    for (const verb of VERBS) {
      for (const name of [
        'path',
        'file',
        'dir',
        'cwd',
        'cmd',
        'command',
        'prompt',
        'model',
        'harness',
        'setting',
        'scopes',
        'grant',
        'branch',
        'url',
      ]) {
        expect(verb.read(bodyFor(verb, { [name]: 'anything' })).ok, `${verb.name} ${name}`).toBe(
          false,
        )
      }
    }
  })

  it('refuses a body of nothing, and one that is not an object at all', () => {
    for (const verb of VERBS) {
      for (const body of [undefined, null, '', 0, [], 'park', { task: 'tade/x' }]) {
        expect(verb.read(body).ok, `${verb.name} took ${JSON.stringify(body)}`).toBe(false)
      }
    }
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

describe('what each verb will and will not read', () => {
  it('refuses an approval id that is empty or absurd, and a decision that is not a boolean', () => {
    // The id is **compared** and never parsed, so what is asked of it is only
    // that it is a string somebody could have been given. A missing one would
    // mean answering whichever approval happened to be waiting.
    expect(ANSWER.read({ ...EVERY, approval: 'req-1', allow: true }).ok).toBe(true)
    expect(ANSWER.read({ ...EVERY, approval: '', allow: true }).ok).toBe(false)
    expect(ANSWER.read({ ...EVERY, approval: 'a'.repeat(201), allow: true }).ok).toBe(false)
    expect(ANSWER.read({ ...EVERY, allow: true }).ok).toBe(false)
    for (const allow of ['true', 1, 0, null, undefined]) {
      expect(ANSWER.read({ ...EVERY, approval: 'req-1', allow }).ok, String(allow)).toBe(false)
    }
  })

  it('refuses a message of nothing, and one past the bound, and never truncates', () => {
    expect(STEER.read({ ...EVERY, said: 'try the other migration' }).ok).toBe(true)
    // Whitespace is nothing to say: a body of spaces delivered into a running
    // turn is a message an agent has to decide what to do with.
    for (const said of ['', ' ', '\n\t ', undefined, null, 4]) {
      expect(STEER.read({ ...EVERY, said }).ok, JSON.stringify(said)).toBe(false)
    }
    expect(STEER.read({ ...EVERY, said: 'x'.repeat(BOUNDS.said) }).ok).toBe(true)
    expect(STEER.read({ ...EVERY, said: 'x'.repeat(BOUNDS.said + 1) }).ok).toBe(false)
  })

  it('keeps a message exactly as it arrived, spaces and newlines and all', () => {
    // **Trimmed to decide, never trimmed to store.** `trim` answers whether
    // there is anything to say; what travels is what was typed, because a
    // message delivered with its indentation removed is a different message.
    const said = '  first line\n\n    indented  '
    const got = STEER.read({ ...EVERY, said })
    expect(got.ok && got.asked.payload).toBe(`said=${said}`)
  })

  it('takes the queue\u2019s own words and nothing else', () => {
    for (const change of ['pause', 'resume', 'start', 'wait', 'first']) {
      expect(QUEUE.read({ ...EVERY, change }).ok, change).toBe(true)
    }
    // `order` is the one a device may never ask for: it is a list of task
    // ids, and a list in a body could reorder work in a project this device
    // cannot see. `remove` is not a queue change at all.
    for (const change of ['order', 'remove', 'start ', 'Pause', '', null]) {
      expect(QUEUE.read({ ...EVERY, change }).ok, String(change)).toBe(false)
    }
    expect(QUEUE.read({ ...EVERY, change: 'order', order: ['app/one'] }).ok).toBe(false)
  })

  it('has no shape of a done body that means *do not*', () => {
    expect(DONE.read({ ...EVERY, confirm: true }).ok).toBe(true)
    // The literal is the point: `false`, `0` and a missing field all fail the
    // parse rather than quietly meaning no.
    for (const confirm of [false, 0, 1, 'true', 'yes', null, undefined]) {
      expect(DONE.read({ ...EVERY, confirm }).ok, String(confirm)).toBe(false)
    }
    // A summary is what it finished as, and having nothing to add is allowed.
    expect(DONE.read({ ...EVERY, confirm: true, summary: '' }).ok).toBe(true)
    expect(DONE.read({ ...EVERY, confirm: true, summary: 'x'.repeat(501) }).ok).toBe(false)
  })

  it('asks the same of an intake approval, because it cannot be undone either', () => {
    expect(INTAKE.read({ ...EVERY, confirm: true }).ok).toBe(true)
    for (const confirm of [false, 'true', null, undefined]) {
      expect(INTAKE.read({ ...EVERY, confirm }).ok, String(confirm)).toBe(false)
    }
  })

  it('bounds a note and a context block, and refuses one made of nothing', () => {
    expect(NOTE.read({ ...EVERY, text: 'the fix is in the adapter' }).ok).toBe(true)
    expect(NOTE.read({ ...EVERY, text: 'x'.repeat(BOUNDS.text + 1) }).ok).toBe(false)
    expect(NOTE.read({ ...EVERY, text: '   ' }).ok).toBe(false)
    expect(CONTEXT.read({ ...EVERY, add: 'the column is nullable' }).ok).toBe(true)
    expect(CONTEXT.read({ ...EVERY, add: 'x'.repeat(BOUNDS.add + 1) }).ok).toBe(false)
    expect(CONTEXT.read({ ...EVERY, add: '\n' }).ok).toBe(false)
  })

  it('says what was asked for in Tade’s own words, never in the sender’s', () => {
    // **The `said` on an `Asked` is what goes in the journal and in the
    // receipt**, so a verb that put the message in it would put somebody's
    // typing into a record whose detail keys telemetry reads. Asserted of
    // every verb against every piece of free text any body carries.
    for (const verb of VERBS) {
      const got = verb.read(bodyFor(verb))
      if (!got.ok) throw new Error(`${verb.name} did not parse its own body`)
      expect(got.asked.said.length, verb.name).toBeGreaterThan(0)
      for (const words of TYPED) {
        expect(got.asked.said, `${verb.name} said ${words}`).not.toContain(words)
      }
    }
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
    const acting: WebActing = actingStub({
      park: (call, from) => {
        calls.push({ call, from })
        return Promise.resolve<Outcome>({ did: true, rev: 'p1', said: 'set aside' })
      },
    })
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
    expect(ACTS.map((route) => route.path)).toEqual([
      '/api/act/park',
      '/api/act/answer',
      '/api/act/steer',
      '/api/act/queue',
      '/api/act/done',
      '/api/act/note',
      '/api/act/context',
      '/api/act/intake',
    ])
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
    expect(taskRev(facts())).toBe(taskRev(facts()))
    expect(taskRev(facts({ parked: true }))).not.toBe(taskRev(facts({ parked: false })))
  })

  it('moves when any one thing a verb assumes moves, and for nothing else', () => {
    // **The whole of what belongs in a revision, asserted field by field.** A
    // field here that no verb assumes would refuse acts that are perfectly
    // current every time a figure moved; a thing a verb assumes and that is
    // *not* here is a replay nothing refuses. Both failures are silent, which
    // is why this is a table rather than a sentence.
    const base = taskRev(facts())
    for (const moved of [
      { parked: true },
      { approval: true },
      { question: true },
      { agents: 1 },
      { finished: true },
      { queue: 'ready' },
    ] as const) {
      expect(taskRev(facts(moved)), JSON.stringify(moved)).not.toBe(base)
    }
  })

  it('reads nine agents and ten as the same answer', () => {
    // A count in a revision is about *whether what you saw is still true*, and
    // a task with nine agents and one with ten are the same answer to every
    // verb there is. Capped, so a number nobody acts on cannot churn one.
    expect(taskRev(facts({ agents: 9 }))).toBe(taskRev(facts({ agents: 10 })))
    expect(taskRev(facts({ agents: 1 }))).not.toBe(taskRev(facts({ agents: 2 })))
  })

  it('fits what a caller may echo back', () => {
    // `Was` is 64 characters. A revision over the bound would be one no device
    // could ever send back, which reads as every act being refused.
    const longest = taskRev(facts({ agents: 9, queue: 'scheduled', parked: true }))
    expect(longest.length).toBeLessThanOrEqual(64)
  })
})
