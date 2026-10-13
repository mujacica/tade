import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILT_IN_TEMPLATES, ConfigSchema, parseTemplate, publishTemplate } from '@tade/core'
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

function wiring(over: { draft?: string; fresh?: boolean } = {}) {
  const home = tmp('tade-workflows-')
  if (!over.fresh) mkdirSync(join(home, 'templates', 'drafts'), { recursive: true })
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

  it('says there is no draft of a template that is neither drafted nor published', async () => {
    const w = wiring()
    await w.open('mine')
    expect(w.view()?.problem).toContain('there is no draft at')
  })

  // **What every installation saw.** A fresh home has no `templates` folder,
  // and a template Tade ships never has a draft — so the page opened on the
  // first one and said there was no draft at a `.yaml` under
  // `templates/drafts`, and told somebody to copy one that cannot be copied.
  it('opens on every workflow Tade ships in a fresh home, read only, with nothing wrong', async () => {
    const w = wiring({ fresh: true })
    await w.open('')
    const shipped = Object.keys(BUILT_IN_TEMPLATES)
    expect(shipped.length).toBeGreaterThan(0)
    expect(w.panel().template).toBe(shipped.sort()[0])
    for (const name of shipped) {
      await w.open(name)
      const view = w.view()
      const read = parseTemplate(name, BUILT_IN_TEMPLATES[name] ?? '')
      if (!read.ok) throw new Error(read.problems.join('; '))
      expect(view?.problem, name).toBeNull()
      expect(view?.says).toBe(`v${read.template.version} built in`)
      expect(view?.problems).toEqual([])
      // Its steps are under it, and the preview draws them.
      const steps = view?.rows.filter((row) => row.template === name && row.step >= 0)
      expect(steps?.map((row) => row.label)).toEqual(read.template.agents.map((one) => one.name))
      expect(view?.places.length).toBe(read.template.agents.length)
      // Every field is shown and none can be changed, each saying why.
      expect(view?.fields.length).toBeGreaterThan(0)
      for (const field of view?.fields ?? []) expect(field.off).toContain('Tade ships this one')
    }
  })

  it('refuses an edit to one Tade ships and writes no draft of it', async () => {
    const w = wiring({ fresh: true })
    await w.open('bug-repro-fix-review')
    await w.click('add')
    expect(w.panel().problem).toContain('Tade ships this one')
    expect(existsSync(join(w.home, 'templates'))).toBe(false)
  })

  it('shows a version somebody published and has no draft of, read only', async () => {
    const w = wiring({ draft: DRAFT })
    const done = await publishTemplate({ home: w.home, name: 'mine', personas: new Map() })
    expect(done.kind).toBe('published')
    // The draft goes; the published version is what is left.
    rmSync(join(w.home, 'templates', 'drafts', 'mine.yaml'))
    await w.open('mine')
    expect(w.view()?.problem).toBeNull()
    expect(w.view()?.says).toBe('v1 published')
    await w.click('remove')
    expect(w.panel().problem).toContain('a published version never changes')
    expect(existsSync(join(w.home, 'templates', 'drafts', 'mine.yaml'))).toBe(false)
  })

  it('says a draft that will not read, rather than show the published version over it', async () => {
    const w = wiring({ draft: DRAFT })
    await publishTemplate({ home: w.home, name: 'mine', personas: new Map() })
    writeFileSync(join(w.home, 'templates', 'drafts', 'mine.yaml'), 'template: [')
    await w.open('mine')
    expect(w.view()?.problem).toContain('mine.yaml')
  })

  it('checks a draft against the personas there are, Tade’s own among them', async () => {
    const naming = (one: string) =>
      DRAFT.replace('  - name: fix\n', `  - name: fix\n    persona: ${one}\n`)
    const w = wiring({ draft: naming('implementer') })
    await w.open()
    expect(w.view()?.problems).toEqual([])
    const v = wiring({ draft: naming('wizard') })
    await v.open()
    expect(v.view()?.problems.join(' ')).toContain(
      'the fix step names the persona wizard, and there is no persona called that: pick one of',
    )
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
    const w = wiring()
    // A draft file under that name, put there by hand: it reads, and saving
    // it is still refused, because the shipped one's bytes are in the source.
    const file = join(w.home, 'templates', 'drafts', 'bug-repro-fix-review.yaml')
    const text = DRAFT.replace('template: mine', 'template: bug-repro-fix-review')
    writeFileSync(file, text)
    await w.open('bug-repro-fix-review')
    expect(w.view()?.says).toBe('v1 draft')
    await w.press(undefined, 'X')
    await w.press('tab')
    expect(w.panel().problem).toContain("its bytes are in Tade's own source")
    expect(readFileSync(file, 'utf8')).toBe(text)
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
