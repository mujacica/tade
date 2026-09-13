import { describe, expect, it } from 'vitest'
import { branchPreview, newTaskPanel, panelClick, panelKey } from '../src/panels.ts'

// What a key or a click does to a panel, without a terminal.

const open = () => newTaskPanel(['checkout', 'search'], 'search')

describe('the New task panel', () => {
  it('opens on the project you are in, with the words ready to type', () => {
    const panel = open()
    expect(panel.project).toBe('search')
    expect(panel.field).toBe('intent')
    expect(panel.start).toBe(true)
  })

  it('keeps what was typed exactly, pastes included', () => {
    let panel = open()
    for (const data of ['Fix ', 'the Refund', ' bug']) {
      panel = (panelKey(panel, undefined, data).panel ?? panel) as typeof panel
    }
    // `intent_spoken` is verbatim; so is everything that becomes one.
    expect(panel.intent).toBe('Fix the Refund bug')
  })

  it('does not type an arrow key as words', () => {
    const panel = panelKey(open(), 'left', '\x1b[D').panel
    expect(panel?.intent).toBe('')
  })

  it('refuses to run with nothing said, and says why in the panel', () => {
    const outcome = panelKey(open(), 'enter', '\r')
    expect(outcome.submit).toBe(false)
    expect(outcome.panel?.error).toContain('what needs doing')
  })

  it('runs once, and is busy while it does', () => {
    const typed = { ...open(), intent: 'tidy the readme' }
    const outcome = panelKey(typed, 'enter', '\r')
    expect(outcome.submit).toBe(true)
    expect(outcome.panel?.busy).toBe(true)
    // A second enter while busy must not make a second task.
    expect(panelKey(outcome.panel ?? typed, 'enter', '\r').submit).toBe(false)
  })

  it('closes on escape, and on Cancel', () => {
    expect(panelKey(open(), 'escape', '\x1b').panel).toBeNull()
    expect(panelClick(open(), 'cancel').panel).toBeNull()
  })

  it('moves between projects with a click or the arrows', () => {
    expect(panelClick(open(), 'project:checkout').panel?.project).toBe('checkout')
    const onProjects = { ...open(), field: 'project' as const }
    expect(panelKey(onProjects, 'right', '').panel?.project).toBe('checkout')
  })

  it('shows the branch the words would make before it exists', () => {
    expect(branchPreview('Refunds are charged twice')).toBe('wilco/refunds-are-charged-twice')
  })

  it('says there is nowhere to start work when there are no projects', () => {
    expect(newTaskPanel([], null).error).toContain('No projects yet')
  })
})
