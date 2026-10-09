import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, parseTemplate } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { WorkflowPanel } from '../../src/panels/workflow/state.ts'
import { panelClick, panelKey } from '../../src/panels.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Intake } from '../../src/wire/intake.ts'

// The workflow editor, driven the way a person drives it: `/workflows`, then
// the keys and the clicks, against a real home with a real draft in it.
//
// **What is asserted is the file**, not a sentence. A form over a file has one
// failure worth designing against — the form and the file being two different
// templates — so every test here reads the draft back off disk afterwards.

const DRAFT = [
  'template: mine',
  'version: 1',
  'title: Reproduce it, then fix it',
  'project_input: project',
  'said_input: request',
  'name_suffix: slug',
  'inputs:',
  '  project: { kind: project }',
  '  request: { kind: text }',
  '  slug: { kind: slug }',
  'agents:',
  '  - name: reproduce',
  '    prompt: Reproduce it.',
  '  - name: fix',
  '    prompt: Fix it.',
  '    after:',
  '      - { agent: reproduce, why: no fix before a failure }',
].join('\n')

function wiring(over: { draft?: string } = {}) {
  const home = tmp('tade-workflows-')
  mkdirSync(join(home, 'templates', 'drafts'), { recursive: true })
  if (over.draft !== undefined) {
    writeFileSync(join(home, 'templates', 'drafts', 'mine.yaml'), over.draft)
  }
  let state: AppState = initialState()
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({ projects: { app: { root: home } } }),
      client: { home, log: { append: async () => {} }, planUsage: () => [], schedules: () => [] },
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: null,
    now: () => 1_000,
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  const intake = new Intake(wire, { advanceQueue: () => {} })
  return {
    home,
    intake,
    panel: () => state.panel as WorkflowPanel,
    view: () => intake.panel()?.workflow ?? null,
    state: () => state,
    setState: (next: AppState) => {
      state = next
    },
    open: (name = 'mine') => intake.actions()['/workflows']?.(name) as Promise<void>,
    /** A press, through the same dispatch the window's keyboard goes through. */
    press: async (key: string | undefined, data = '') => {
      const out = panelKey(state.panel as WorkflowPanel, key, data, intake.inputs())
      state = { ...state, panel: out.panel }
      if (out.submit) {
        await intake.submits().workflow?.(state.panel as WorkflowPanel, out.choice)
      }
    },
    /** A click on one of the page's own controls. */
    click: async (control: string) => {
      const out = panelClick(state.panel as WorkflowPanel, control, intake.inputs())
      state = { ...state, panel: out.panel }
      if (out.submit) {
        await intake.submits().workflow?.(state.panel as WorkflowPanel, out.choice)
      }
    },
    read: () => readFileSync(join(home, 'templates', 'drafts', 'mine.yaml'), 'utf8'),
  }
}

describe('writing a stored workflow', () => {
  it('opens on the template and lists its steps under it', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    const view = w.view()
    // The two Tade ships are listed too, because they exist: the list is
    // every template there is, and the chosen one's steps under it.
    expect(view?.rows.map((row) => row.label)).toEqual([
      'bug-repro-fix-review',
      'mine',
      'reproduce',
      'fix',
      'research-then-plan',
    ])
    expect(view?.title).toContain('the template')
    expect(view?.says).toBe('v1 draft')
    // What the validator says, in the validator's own words, so a clean form
    // and a refused publish cannot disagree.
    expect(view?.problems).toEqual([])
  })

  it('draws the resolved tree as the preview, with a column per depth', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    expect(w.view()?.places.map((one) => [one.name, one.depth])).toEqual([
      ['reproduce', 0],
      ['fix', 1],
    ])
    expect(w.view()?.places[1]?.why).toEqual([{ on: 'reproduce', why: 'no fix before a failure' }])
  })

  it('says there is no draft of a template that is only published, and what to do', async () => {
    const w = wiring()
    await w.open('mine')
    expect(w.view()?.problem).toContain('A published version is immutable')
  })

  it('saves a field a letter at a time, and the file is what it says', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    // The keyboard is on the first field of the template's own form, which is
    // its title.
    await w.press(undefined, 'X')
    await w.press('tab')
    expect(w.read()).toContain('title: Reproduce it, then fix itX')
    // And it is a draft, which says so where somebody will find out about it.
    expect(w.read()).toContain('Tade rewrites this file')
  })

  it('ticks a dependency on, and writes the reason beside it', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    // Move to the first step, and find its own `after` tick for the other one.
    await w.press('right')
    const tick = w.view()?.fields.find((one) => one.id === 'after:fix')
    expect(tick?.value).toBe('false')
    await w.click(`field:${tick?.id}`)
    const read = parseTemplate('mine', w.read())
    expect(read.ok && read.template.agents[0]?.after).toEqual([{ agent: 'fix', why: '' }])
    // A wait with no reason is drawn as one nobody can answer later, rather
    // than as a wait like any other.
    const after = w.view()?.places.find((one) => one.name === 'reproduce')
    expect(after?.why).toEqual([{ on: 'fix', why: '' }])
  })

  it('adds a step and takes one away, and every wait on it goes with it', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    await w.click('add')
    expect(w.view()?.rows.map((row) => row.label)).toEqual([
      'bug-repro-fix-review',
      'mine',
      'reproduce',
      'fix',
      'step',
      'research-then-plan',
    ])
    // The form moves to what was added, which is what somebody pressed + for.
    expect(w.panel().row).toBe(2)
    // Remove the first step: the wait the second one had on it goes too.
    w.setState({ ...w.state(), panel: { ...w.panel(), row: 0 } })
    await w.click('remove')
    const read = parseTemplate('mine', w.read())
    expect(read.ok && read.template.agents.map((one) => one.name)).toEqual(['fix', 'step'])
    expect(read.ok && read.template.agents[0]?.after).toEqual([])
  })

  it('will not write a draft for a name Tade ships', async () => {
    const w = wiring({ draft: DRAFT.replace('template: mine', 'template: bug-repro-fix-review') })
    await w.open('bug-repro-fix-review')
    // It will not even read as that template's draft: the name in the block
    // must equal the file's.
    expect(w.view()?.problem).toBeTruthy()
  })

  it('asks before publishing, because a published version never changes', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    await w.click('publish')
    expect(w.panel().asking).toBe('publish')
    // Escape is no, and it is exactly one thing: it answers the question
    // rather than also closing the page.
    await w.press('escape')
    expect(w.panel().asking).toBeNull()
    expect(w.panel().kind).toBe('workflow')
  })

  it('publishes through the same door the command does, and then refuses the same version', async () => {
    const w = wiring({ draft: DRAFT })
    await w.open()
    await w.click('publish')
    await w.press('y')
    expect(w.panel().said).toContain('published mine@1')
    expect(w.view()?.published).toEqual([1])
    const snapshot = readFileSync(join(w.home, 'templates', 'published', 'mine', '1.yaml'), 'utf8')
    expect(snapshot).toContain('immutable')

    // The same version again, unchanged, is not a second publish.
    await w.click('publish')
    await w.press('y')
    expect(w.panel().said).toContain('already published, unchanged')

    // Changed, it is refused with the version to bump to — which is the whole
    // of what immutable means here. The form is put back on the template's own
    // row first, because publishing leaves it wherever it was.
    w.setState({ ...w.state(), panel: { ...w.panel(), row: -1, index: 0 } })
    await w.press(undefined, 'X')
    await w.press('tab')
    expect(w.read()).toContain('X')
    await w.click('publish')
    await w.press('y')
    expect(w.panel().problem).toContain('bump version to 2')
  })

  it('refuses to publish a draft the validator turns down, in its words', async () => {
    const w = wiring({ draft: DRAFT.replace('title: Reproduce it, then fix it', 'title: ""') })
    await w.open()
    expect(w.view()?.problems.join(' ')).toContain('say what this template is for')
    await w.click('publish')
    await w.press('y')
    expect(w.panel().problem).toContain('say what this template is for')
  })
})
