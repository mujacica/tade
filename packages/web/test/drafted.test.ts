import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type From, Moved, NotOffered, NotThere, type Outcome, TooMuch } from '../src/acting.ts'
import { admitDraft, boundToSaving, carrySave, readDraftSave, type Saved } from '../src/drafted.ts'
import { DRAFT_BOUND, type DraftCall, draftRev, type WebDrafting } from '../src/drafting.ts'
import { namesOnly, type Reach } from '../src/reach.ts'
import { RECEIPTS_FILE, Receipts } from '../src/receipts.ts'
import type { Scope, Surface } from '../src/surface.ts'
import { homeFor } from './harness.ts'

// One field of one draft, end to end, with a real receipt store on disk and a
// window that answers whatever the test wants it to.
//
// **No sockets**, for the reason `acted.test.ts` and `asked.test.ts` have
// none: the cases this is about — the same save sent twice because a phone
// lost signal, a captured request replayed after the draft moved on, a device
// whose reading is a list of two trying to edit a file that could name five —
// are each one line of setup here and a paragraph of ceremony through HTTP.

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: [],
  acting: false,
  talking: false,
  drafting: true,
}

// **`was` through the same function the window compares against**, never a
// literal: two spellings of one revision is a comparison that is always true
// or always false, and neither failure looks like one.
const WAS = draftRev({ hash: 'sha256:9f8e7d6c5b4a' })

/** The device every body here is bound to. */
const DEVICE = '00112233445566aa'

const BODY = {
  template: 'reproduce-and-fix',
  was: WAS,
  scope: 'reproduce',
  field: 'prompt',
  value: 'Write a failing test, and nothing else.',
  key: 'abcdefgh12345678',
  rev: 4,
}

/** A window that does what the test says, and remembers being asked. */
function window_(
  over: { save?: (call: DraftCall, from: From) => Promise<Outcome>; unlocked?: boolean } = {},
): { drafting: WebDrafting; calls: { call: DraftCall; from: From }[] } {
  const calls: { call: DraftCall; from: From }[] = []
  return {
    calls,
    drafting: {
      unlocked: () => over.unlocked ?? true,
      save: (call, from) => {
        calls.push({ call, from })
        return (
          over.save?.(call, from) ??
          Promise.resolve<Outcome>({
            did: true,
            rev: 'sha256:aaaabbbbcccc',
            said: 'prompt saved on the draft',
          })
        )
      },
    },
  }
}

async function context(
  drafting: WebDrafting,
  over: Partial<Saved> = {},
  what = 'drafted',
): Promise<Saved> {
  const home = await homeFor(what)
  const receipts = new Receipts({ home, epoch: 'one' })
  await receipts.open()
  return {
    drafting,
    receipts,
    surface: SURFACE,
    unlocked: true,
    rev: 4,
    reach: namesOnly(DEVICE),
    scopes: ['read', 'draft'] as readonly Scope[],
    origin: { scheme: 'http', host: '127.0.0.1' },
    device: DEVICE,
    now: Date.parse('2026-10-09T14:30:00.000Z'),
    request: 'req_1',
    ...over,
  }
}

const listed = (names: readonly string[]): Reach => ({
  device: DEVICE,
  projects: { kind: 'listed', names: [...names] },
  granted: [],
})

describe('reading a save out of a body', () => {
  it('takes the four fields and nothing else', () => {
    const read = readDraftSave(BODY)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.saving.verb).toBe('draft')
    expect(read.saving.template).toBe('reproduce-and-fix')
    expect(read.saving.was).toBe(WAS)
  })

  it('refuses a field nobody declared, which is what strict is for', () => {
    expect(readDraftSave({ ...BODY, publish: true }).ok).toBe(false)
  })

  it('refuses anything path-shaped in any of the three names', () => {
    // There is nothing in this body that could be a path, and the patterns are
    // how that stops being a sentence. A name Tade would not have written is a
    // caller that is confused, and reading a different file than the one it
    // asked for is worse than refusing.
    for (const template of ['../../etc/passwd', 'a/b', './x', 'Reproduce', '']) {
      expect(readDraftSave({ ...BODY, template }).ok, template).toBe(false)
    }
    for (const scope of ['../x', 'a/b', 'Step', '', '.hidden', '/etc/passwd']) {
      expect(readDraftSave({ ...BODY, scope }).ok, scope).toBe(false)
    }
    for (const field of ['../x', 'Prompt', '', 'a/b', 'after:../x', 'after:/etc']) {
      expect(readDraftSave({ ...BODY, field }).ok, field).toBe(false)
    }
  })

  it('takes `template` as a scope, which is the one literal there is', () => {
    expect(readDraftSave({ ...BODY, scope: 'template', field: 'title' }).ok).toBe(true)
  })

  it('takes every field id the designer’s own form produces', () => {
    // **Including the dependency fields**, which is the pair a narrower
    // pattern would have refused: a tick per other step and the reason beside
    // it, and the reason is the field the whole designer argument is about.
    for (const field of [
      'title',
      'about',
      'project_input',
      'said_input',
      'name_suffix',
      'name',
      'persona',
      'done',
      'produces',
      'prompt',
      'touches',
      'reads',
      'leaves_checks',
      'after:reproduce',
      'why:reproduce',
      'after:fix-extra',
      'why:step.one',
    ]) {
      expect(readDraftSave({ ...BODY, field }).ok, field).toBe(true)
    }
  })

  it('takes a step name with the characters a step name may have', () => {
    // `editWorkflow`'s own rule. A narrower pattern here would refuse a
    // legitimate step rather than protecting anything: a scope reaches no
    // path, so what a bad one meets is a lookup that finds nothing.
    for (const scope of ['fix', 'fix-extra', 'step.one', 'step_two', 'a1']) {
      expect(readDraftSave({ ...BODY, scope }).ok, scope).toBe(true)
    }
  })

  it('refuses a value over the bound rather than cutting it', () => {
    // Half of what somebody wrote, saved as though it were the whole, is a lie
    // about what they meant.
    expect(readDraftSave({ ...BODY, value: 'x'.repeat(DRAFT_BOUND + 1) }).ok).toBe(false)
  })

  it('takes an empty value, because clearing a field is a real edit', () => {
    const read = readDraftSave({ ...BODY, value: '' })
    expect(read.ok).toBe(true)
  })

  it('says what was asked for without the value in it', () => {
    const read = readDraftSave(BODY)
    if (!read.ok) return
    // The journal line and the receipt. What somebody typed on a phone is not
    // a record Tade writes about them; the **length** is a count, and a count
    // is a thing Tade may say.
    expect(read.saving.said).toContain('saved prompt on reproduce-and-fix')
    expect(read.saving.said).toContain(`${BODY.value.length} characters`)
    expect(read.saving.said).not.toContain('failing test')
  })

  it('binds the key to the device, the draft, the field and the value', () => {
    const read = readDraftSave(BODY)
    if (!read.ok) return
    const bound = boundToSaving(DEVICE, read.saving)
    expect(bound).toContain('reproduce-and-fix')
    expect(bound).toContain('field=prompt')
    // The value is bound too, so a correction after a typo is a second act
    // rather than an already-done.
    expect(bound).toContain(BODY.value)
  })
})

describe('whether a save may go through', () => {
  const saving = () => {
    const read = readDraftSave(BODY)
    if (!read.ok) throw new Error('the fixture does not parse')
    return read.saving
  }

  it('goes through for a trusted origin, the scope and every project', async () => {
    expect(admitDraft(saving(), await context(window_().drafting)).ok).toBe(true)
  })

  it('is refused while the setting is off, in either of its two readings', async () => {
    const now = await context(window_().drafting, { unlocked: false })
    expect(admitDraft(saving(), now).ok).toBe(false)
    const table = await context(window_().drafting, {
      surface: { ...SURFACE, drafting: false },
    })
    expect(admitDraft(saving(), table).ok).toBe(false)
  })

  it('is refused for a device granted both acting tiers and not this', async () => {
    // The whole reason `draft` is its own scope: eight bounded things about
    // work that exists is not a file every future run would be stamped from.
    const now = await context(window_().drafting, {
      scopes: ['read', 'answer', 'steer', 'ask'] as readonly Scope[],
    })
    const admitted = admitDraft(saving(), now)
    expect(admitted.ok).toBe(false)
    if (admitted.ok) return
    expect(admitted.why).toContain('needs draft')
  })

  it('is refused for a device whose reading is a list rather than every project', async () => {
    // **This door's own check**, and it takes the place of the per-project
    // boundary a verb has: a workflow names the repository it works in through
    // an input and can name any of them, so a phone granted one repository of
    // five may not edit a file that could name the other four. There is no
    // later moment to ask it at — a draft saved now is read by a run next week.
    const now = await context(window_().drafting, { reach: listed(['sentry', 'tade']) })
    const admitted = admitDraft(saving(), now)
    expect(admitted.ok).toBe(false)
    if (admitted.ok) return
    expect(admitted.why).toContain('needs every project')
    expect(admitted.why).toContain('reads 2')
  })

  it('is refused off a trusted origin, however much was granted', async () => {
    const now = await context(window_().drafting, {
      origin: { scheme: 'http', host: '192.168.1.5:7654' },
    })
    expect(admitDraft(saving(), now).ok).toBe(false)
  })

  it('is refused from a screen that is ancient, and from one ahead of the server', async () => {
    const old = await context(window_().drafting, { rev: 4_000 })
    expect(admitDraft(saving(), old).ok).toBe(false)
    const future = await context(window_().drafting, { rev: 1 })
    expect(admitDraft(saving(), future).ok).toBe(false)
  })
})

describe('carrying one save out', () => {
  const saving = () => {
    const read = readDraftSave(BODY)
    if (!read.ok) throw new Error('the fixture does not parse')
    return read.saving
  }

  it('reaches the window with the device’s own provenance', async () => {
    const made = window_()
    const wrote = await carrySave('save', BODY, await context(made.drafting))
    expect(wrote.refusal).toBeNull()
    expect(wrote.body?.did).toBe(true)
    // `remote`, and the device's id: a save recorded as the person's own doing
    // would make every fold of the journal count it as theirs.
    expect(made.calls[0]?.from).toEqual({ how: 'remote', device: DEVICE })
    expect(made.calls[0]?.call.field).toBe('prompt')
  })

  it('writes the audit line whatever happened, the draft named in it', async () => {
    const wrote = await carrySave('save', BODY, await context(window_().drafting))
    expect(wrote.did.tool).toBe('draft')
    expect(wrote.did.task).toBe('reproduce-and-fix')
    expect(wrote.did.why).toBe('done')
  })

  it('writes one for a refusal too, which is the case audit matters most in', async () => {
    const made = window_()
    const wrote = await carrySave(
      'save',
      BODY,
      await context(made.drafting, { reach: listed(['sentry']) }, 'drafted-refused'),
    )
    expect(wrote.refusal?.error).toBe('out_of_scope')
    expect(wrote.did.state).toBe('refused')
    expect(wrote.did.task).toBe('reproduce-and-fix')
    // And nothing reached the window.
    expect(made.calls).toHaveLength(0)
  })

  it('answers a name nobody declared with a 404 and reaches nothing', async () => {
    const made = window_()
    const wrote = await carrySave('publish', BODY, await context(made.drafting, {}, 'drafted-404'))
    expect(wrote.refusal?.error).toBe('no_such')
    expect(made.calls).toHaveLength(0)
  })

  it('answers a malformed body without reaching the window', async () => {
    const made = window_()
    const wrote = await carrySave(
      'save',
      { ...BODY, template: '../x' },
      await context(made.drafting, {}, 'drafted-malformed'),
    )
    expect(wrote.refusal?.error).toBe('malformed')
    expect(made.calls).toHaveLength(0)
  })

  it('answers the same save sent twice out of the record, writing once', async () => {
    // The one failure a phone on a train actually has: save, lose signal, save
    // again.
    const made = window_()
    const ctx = await context(made.drafting, {}, 'drafted-twice')
    const first = await carrySave('save', BODY, ctx)
    const again = await carrySave('save', BODY, ctx)
    expect(first.refusal).toBeNull()
    expect(again.refusal).toBeNull()
    expect(again.did.why).toBe('already saved')
    expect(made.calls).toHaveLength(1)
  })

  it('refuses a key bound to a different value, rather than writing it', async () => {
    const made = window_()
    const ctx = await context(made.drafting, {}, 'drafted-reused')
    await carrySave('save', BODY, ctx)
    const other = await carrySave('save', { ...BODY, value: 'something else' }, ctx)
    expect(other.refusal?.error).toBe('reused')
    expect(made.calls).toHaveLength(1)
  })

  it('answers a draft that moved with what is true now', async () => {
    const made = window_({
      save: () => Promise.reject(new Moved('it has been edited', 'sha256:ffffffffffff')),
    })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-moved'))
    expect(wrote.refusal?.error).toBe('gone')
    // The truth goes back with the refusal, so the page redraws rather than
    // showing a toast about a world it cannot see.
    expect(wrote.refusal?.rev).toBe('sha256:ffffffffffff')
  })

  it('answers a draft or a step that is not there with a 404', async () => {
    const made = window_({ save: () => Promise.reject(new NotThere('no such step')) })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-gone'))
    expect(wrote.refusal?.error).toBe('no_such')
  })

  it('answers a field the validator refuses with its own sentence’s refusal', async () => {
    const made = window_({ save: () => Promise.reject(new NotOffered('that is not a field')) })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-no'))
    expect(wrote.refusal?.error).toBe('not_offered')
  })

  it('answers a value the window found too long with too_big', async () => {
    const made = window_({ save: () => Promise.reject(new TooMuch('too long')) })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-big'))
    expect(wrote.refusal?.error).toBe('too_big')
  })

  it('says what broke, in a warning, and refuses rather than answering nothing', async () => {
    const made = window_({ save: () => Promise.reject(new Error('the disk is full')) })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-broke'))
    expect(wrote.refusal?.error).toBe('broke')
    expect(wrote.warning).toContain('the disk is full')
  })

  it('answers nothing-to-do as an answer rather than a failure', async () => {
    // A value that was already what it is: `did: false`, which is a fact about
    // the draft and not a refusal.
    const made = window_({
      save: () => Promise.resolve({ did: false, rev: WAS, said: 'it was already that' }),
    })
    const wrote = await carrySave('save', BODY, await context(made.drafting, {}, 'drafted-same'))
    expect(wrote.refusal).toBeNull()
    expect(wrote.body?.did).toBe(false)
    expect(wrote.did.why).toBe('nothing to do')
  })

  it('answers two saves in one tick with one write and one in-flight answer', async () => {
    // The two-presses-in-one-tick case, which is what a double tap on a phone
    // is: the claim is synchronous and marks before its first `await`, so the
    // second press finds the first in flight and is answered with its outcome
    // rather than writing a second time.
    const made = window_({
      save: () =>
        new Promise((done) =>
          setTimeout(() => done({ did: true, rev: 'sha256:later', said: 'saved' }), 5),
        ),
    })
    const ctx = await context(made.drafting, {}, 'drafted-tick')
    const [first, second] = await Promise.all([
      carrySave('save', BODY, ctx),
      carrySave('save', BODY, ctx),
    ])
    expect(made.calls).toHaveLength(1)
    expect(first.refusal).toBeNull()
    expect(second.refusal).toBeNull()
    // One of them is told it was already going, and neither is told nothing.
    expect([first.did.why, second.did.why]).toContain('already going')
  })

  it('answers `unsure` where the save that was already going threw', async () => {
    // Two presses in one tick, and the first one failed. The second cannot be
    // told it worked and must not be run again — so it is `unsure`, which is
    // Tade saying it does not know rather than guessing either way.
    const made = window_({
      save: () =>
        new Promise((_done, failed) => setTimeout(() => failed(new Error('the disk went')), 5)),
    })
    const ctx = await context(made.drafting, {}, 'drafted-threw')
    const [first, second] = await Promise.allSettled([
      carrySave('save', BODY, ctx),
      carrySave('save', BODY, ctx),
    ])
    expect(made.calls).toHaveLength(1)
    const errors = [first, second].map((one) =>
      one.status === 'fulfilled' ? one.value.refusal?.error : 'threw',
    )
    // One of them is the save that broke, and the other is told `unsure`.
    expect(errors).toContain('broke')
    expect(errors).toContain('unsure')
  })

  it('answers a save whose window died in the middle with `unsure`, for ever', async () => {
    // **An `asked` line with nothing after it is a window that died mid-save**,
    // and the answer is that Tade does not know whether it happened, will not
    // do it again, and says so — because nothing here promises exactly-once
    // side effects. Written as a line from an **earlier lifetime**, which is
    // what that actually is: a claim made in this process would be in flight
    // rather than unfinished.
    const home = await homeFor('drafted-unsure')
    await writeFile(
      join(home, RECEIPTS_FILE),
      `${JSON.stringify({
        kind: 'asked',
        key: BODY.key,
        bound: createHash('sha256').update(boundToSaving(DEVICE, saving()), 'utf8').digest('hex'),
        epoch: 'the window before this one',
        at: new Date(Date.parse('2026-10-09T13:00:00.000Z')).toISOString(),
        device: DEVICE,
        verb: 'draft',
        task: BODY.template,
      })}\n`,
      'utf8',
    )
    const made = window_()
    const receipts = new Receipts({ home, epoch: 'two' })
    await receipts.open()
    const wrote = await carrySave('save', BODY, {
      ...(await context(made.drafting, {}, 'drafted-unsure-ctx')),
      receipts,
    })
    expect(wrote.refusal?.error).toBe('unsure')
    expect(made.calls).toHaveLength(0)
  })

  it('runs nothing where the record of being about to could not be written', async () => {
    // **Fail closed**, the same ordering a verb has — and it matters more
    // here: an unrecorded save is a file on disk Tade cannot say anything
    // true about.
    const made = window_()
    const ctx = await context(made.drafting, {}, 'drafted-nowrite')
    const wrote = await carrySave('save', BODY, {
      ...ctx,
      receipts: {
        ...ctx.receipts,
        claim: () => Promise.reject(new Error('the disk is full')),
      } as unknown as typeof ctx.receipts,
    })
    expect(wrote.refusal?.error).toBe('broke')
    expect(wrote.warning).toContain('could not write down that a device saved a draft')
    expect(made.calls).toHaveLength(0)
  })

  it('refuses while the window says saving is locked, without reaching it', async () => {
    const made = window_({ unlocked: false })
    const wrote = await carrySave(
      'save',
      BODY,
      await context(made.drafting, { unlocked: false }, 'drafted-locked'),
    )
    expect(wrote.refusal?.error).toBe('locked')
    expect(made.calls).toHaveLength(0)
  })
})
