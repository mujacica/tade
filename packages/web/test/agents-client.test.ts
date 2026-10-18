import { describe, expect, it } from 'vitest'
import { byProject, runsOn } from '../src/assets/agents.js'
import { WHY_SAID, withHeld } from '../src/assets/pages/agent-pane.js'
import { UNREAD_SAID } from '../src/assets/pages/agent-said.js'
import { CONVERSATION_WHY, SCREEN_WHY } from '../src/protocol.ts'

// The page's half of an agent looked into, as far as anything offline can see
// it: the sentences it says for each absence, held equal to the words the
// machine sends, and the two folds it draws the side list with.
//
// What it draws, and that leaving a page stops its asking, is a browser's to
// answer (`scripts/browser-desk.ts`).

describe('why there is no screen, said', () => {
  it('has a sentence for every word the machine can send, and none for a word it cannot', () => {
    // **Held equal in both directions**, like `glyphs.js` and the queue's
    // words: a word with no sentence draws as nothing, which reads as a pane
    // that failed to load, and a sentence for a word nobody sends is a branch
    // that hides a rename.
    expect(Object.keys(WHY_SAID).sort()).toEqual([...SCREEN_WHY].sort())
  })

  it('never says a device was refused what it was not granted', () => {
    // A grant is the person at the machine's to make, so the sentence says
    // where it is made rather than that this device did something wrong.
    expect(WHY_SAID['not granted']).toContain('at the machine')
    // And no agent is not "could not read": one is the work, the other is the
    // reading, and somebody does something different about each.
    expect(WHY_SAID['no agent']).not.toBe(WHY_SAID['could not read'])
  })
})

describe('its conversation, asked for again', () => {
  it('says why there is none for every word the machine can send, and none for a word it cannot', () => {
    expect(Object.keys(UNREAD_SAID).sort()).toEqual([...CONVERSATION_WHY].sort())
    expect(UNREAD_SAID['not granted']?.[1]).toContain('at the machine')
  })

  it('keeps the turns it holds where the machine says they have not moved', () => {
    const turns = [{ id: 'reply:1#0' }]
    const was = { conversation: { rev: '7', turns, earlier: false, taken: 2 }, unread: null }
    const same = withHeld(was, {
      screen: null,
      conversation: { rev: '7', turns: null, earlier: false, taken: 0 },
      unread: null,
    })
    expect(same.conversation).toEqual(was.conversation)
    // A revision it never held the turns of is not drawn as an empty conversation.
    const lost = withHeld(null, {
      conversation: { rev: '8', turns: null, earlier: false, taken: 0 },
      unread: null,
    })
    expect(lost).toMatchObject({ conversation: null, unread: 'not read yet' })
    // A whole answer is taken as it is.
    const next = { conversation: { rev: '8', turns: [], earlier: false, taken: 0 }, unread: null }
    expect(withHeld(was, next)).toBe(next)
  })
})

describe('the agents, as the side list draws them', () => {
  it('groups by project in the order it was handed', () => {
    const groups = byProject([
      { id: 'a/one', project: 'a' },
      { id: 'b/two', project: 'b' },
      { id: 'a/three', project: 'a' },
    ])
    expect(groups.map((one) => [one.project, one.agents.map((task) => task.id)])).toEqual([
      ['a', ['a/one', 'a/three']],
      ['b', ['b/two']],
    ])
  })

  it('says what an agent runs on with a dash for what nobody wrote down', () => {
    const one = { project: 'tade', harness: 'pi', model: 'claude-opus-5', account: null }
    expect(runsOn(one)).toBe('tade · pi · claude-opus-5')
    expect(runsOn({ ...one, model: null })).toBe('tade · pi · —')
    // The key it signs in as, beside its harness, where this device may read it.
    expect(runsOn({ ...one, account: { words: 'work@example.invalid' } })).toBe(
      'tade · pi (work@example.invalid) · claude-opus-5',
    )
  })
})
