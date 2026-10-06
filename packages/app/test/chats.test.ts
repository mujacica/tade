import { CHATS, HARNESS_CHOICES, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { initialState, terminalsOf, withTerminals } from '../src/model.ts'
import { bottomNewItems, chatMenuItems, terminalMenuItems } from '../src/panels/menu/state.ts'
import { type SpendBy, spendView } from '../src/spend.ts'

// Chats in the window: the tabs they are, the menu that opens one, and what
// one costs — which has to read as neither a project's nor a task's.

const NOW = Date.parse('2026-09-13T12:00:00.000Z')

let seq = 0
const usage = (task: string | null, detail: Record<string, unknown>): TadeEvent =>
  ({
    seq: ++seq,
    ts: '2026-09-13T11:00:00.000Z',
    type: 'usage',
    urgency: 'routine',
    task,
    lane: null,
    run: `r${seq}`,
    detail,
  }) as TadeEvent

describe('a chat’s tab in the lower pane', () => {
  const tabs = [
    { id: 'app/terminals/1', project: 'app', name: 'terminal 1' },
    { id: 'shop/terminals/1', project: 'shop', name: 'terminal 1' },
    { id: `${CHATS}/1/agent`, project: '', name: 'pi 1' },
  ]

  it('is there whichever project you are standing in, and a terminal’s is not', () => {
    const inApp = withTerminals({ ...initialState(), project: 'app' }, tabs)
    expect(terminalsOf(inApp).map((tab) => tab.name)).toEqual(['terminal 1', 'pi 1'])
    const inShop = withTerminals({ ...initialState(), project: 'shop' }, tabs)
    expect(terminalsOf(inShop).map((tab) => tab.id)).toEqual([
      'shop/terminals/1',
      `${CHATS}/1/agent`,
    ])
  })

  it('is there with no project open at all', () => {
    const nowhere = withTerminals({ ...initialState(), project: null }, tabs)
    expect(terminalsOf(nowhere).map((tab) => tab.id)).toContain(`${CHATS}/1/agent`)
  })
})

describe('the `+` at the end of the tabs', () => {
  const items = bottomNewItems(HARNESS_CHOICES)

  it('offers a terminal and one agent per harness', () => {
    expect(items.map((item) => item.id)).toEqual([
      'terminal',
      ...HARNESS_CHOICES.map((harness) => `chat:${harness.id}`),
    ])
    expect(items[0]?.note).toBe('ctrl+t')
  })

  it('keeps a harness that cannot run here, with the reason', () => {
    const items = bottomNewItems([
      { id: 'later', title: 'Later', about: 'is not built yet', ready: false },
    ])
    expect(items[1]).toMatchObject({ id: 'chat:later', off: 'is not built yet' })
  })
})

describe('what a chat’s own tab menu offers', () => {
  it('nothing that is a shell’s: no command to run, nothing to clear, no rename', () => {
    const chat = chatMenuItems().map((item) => item.id)
    expect(chat).not.toContain('run')
    expect(chat).not.toContain('clear')
    // Its name is its harness and its id, and the id is what steers it.
    expect(chat).not.toContain('rename')
    expect(terminalMenuItems().map((item) => item.id)).toEqual(
      expect.arrayContaining(['run', 'clear', 'rename']),
    )
  })

  it('says what closing one does, because that is the question somebody has', () => {
    const close = chatMenuItems().find((item) => item.id === 'close')
    expect(close).toMatchObject({ danger: true, note: 'the conversation stays' })
  })
})

describe('what a chat costs', () => {
  // Three agents on one morning: one on a task, one chat, and the
  // orchestrator's own turns, which carry no task at all.
  const events = [
    usage('app/refunds', { model: 'claude-opus-5', harness: 'claude-code', tokens: 400, usd: 2 }),
    usage(`${CHATS}/1`, {
      model: 'claude-opus-5',
      harness: 'claude-code',
      account: 'work',
      provider: 'anthropic',
      tokens: 100,
      usd: 0.5,
      priced: 'exact',
    }),
    usage(null, { by: 'orchestrator', model: 'claude-opus-5', tokens: 10, usd: 0.1 }),
  ]
  const view = (by: SpendBy) =>
    spendView(events, {
      window: 'all',
      by,
      now: NOW,
      openedAt: NOW,
      projects: ['app'],
      budgets: {},
    })

  it('is a row of its own, and not a project’s', () => {
    const rows = view('project').rows
    const chats = rows.find((row) => row.label === CHATS)
    expect(chats).toMatchObject({ kind: 'chat', usd: 0.5, tokens: 100 })
    // Not drawn as a repository, and not folded into the orchestrator's row
    // either, which is what `elsewhere` — a figure with no task — is.
    expect(rows.find((row) => row.kind === 'project')?.label).toBe('app')
    expect(rows.find((row) => row.kind === 'orchestrator')?.label).toBe('orchestrator')
  })

  it('is listed by its id, which is what steers and stops it', () => {
    const row = view('agent').rows.find((one) => one.label === `${CHATS}/1`)
    expect(row).toMatchObject({ kind: 'chat', usd: 0.5 })
  })

  it('counts towards the sign-in and the provider it ran through, like any agent', () => {
    expect(view('account').rows.map((row) => row.label)).toContain('claude-code @work')
    expect(view('provider').rows.map((row) => row.label)).toContain('anthropic')
  })

  it('leaves what nothing priced unknown rather than nought', () => {
    // A harness that declared it prices nothing, on a model no rate knows:
    // the one shape where nobody can say what a turn cost.
    const said = usage(`${CHATS}/2`, {
      tokens: 900,
      harness: 'pi',
      priced: 'none',
      model: 'kimi-k9',
    })
    const page = spendView([said], {
      window: 'all',
      by: 'project',
      now: NOW,
      openedAt: NOW,
      projects: [],
      budgets: {},
    })
    const unknown = page.rows.find((row) => row.label === CHATS)
    // Nothing vouched for a dollar, so the row says so rather than drawing
    // $0.00 over an agent that plainly ran — and the tokens no money covers
    // are counted as exactly that.
    expect(unknown).toMatchObject({ tokens: 900, usd: 0, priced: 'none' })
    expect(page.tokensUnpriced).toBe(900)
  })
})
