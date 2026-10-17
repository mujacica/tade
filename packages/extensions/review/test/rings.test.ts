import { doorbellRings, type WatchDoorbell } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { reviewExtension } from '../src/extension.ts'

// Which GitHub deliveries make the four review watches that had none look now
// (`RINGS`), read the way the window's doorbell reads them (`doorbellFor`):
// the watch as the host offers it, and `doorbellRings` against a schedule of
// it on a project whose own repository is github.com/acme/api. A delivery only
// makes a watch look sooner, and its poll stays, so each case asks two things:
// that what can change what the look finds rings it, and that what cannot —
// another repository, another kind of delivery — does not. The CI, comment and
// conflict rings are held in `branch.test.ts`.

const HERE = 'github.com/acme/api'

/** What a watch rings for, as the host hands it to the window. */
async function bellOf(watch: string): Promise<WatchDoorbell> {
  const host = await ExtensionHost.load({
    builtin: [reviewExtension],
    config: { extensions: { review: {} }, projects: {} },
    home: tmp('tade-rings-home-'),
    env: { PATH: '/usr/bin' },
  })
  const bell = host.watches().find((one) => one.id === `review.${watch}`)?.doorbell
  if (bell === undefined) throw new Error(`review.${watch} declares no doorbell`)
  return bell
}

/** Whether a GitHub delivery of `event` about `where` wakes a schedule of this watch on HERE. */
function rings(bell: WatchDoorbell, event: string, where: string | null = HERE): boolean {
  return doorbellRings(bell, { source: 'github', event, where }, { input: {}, repository: HERE })
}

describe('what rings a review watch that reads reviews and branches', () => {
  it('rings the reviewer for a review opened or pushed to, on this repository alone', async () => {
    const bell = await bellOf('to-review')
    expect(bell.input).toBeUndefined()
    expect(rings(bell, 'pull_request')).toBe(true)
    expect(rings(bell, 'pull_request', 'github.com/acme/other')).toBe(false)
    // CI finishing and somebody commenting move nothing it keys on: a review
    // is of one head, and a head only moves with a push to the review.
    for (const event of ['check_suite', 'issue_comment', 'push']) {
      expect(rings(bell, event)).toBe(false)
    }
  })

  it('rings the fix for a review landing on a review, as notes or whole', async () => {
    const bell = await bellOf('review-fix')
    expect(bell.input).toBeUndefined()
    expect(rings(bell, 'pull_request_review')).toBe(true)
    expect(rings(bell, 'pull_request_review_comment')).toBe(true)
    expect(rings(bell, 'pull_request_review', 'github.com/acme/other')).toBe(false)
    // A push moves the head past any review of it, so there is nothing new to
    // fix until a reviewer has read the new one — which rings this then.
    for (const event of ['pull_request', 'check_suite', 'push']) {
      expect(rings(bell, event)).toBe(false)
    }
  })

  it('rings for a review asked of you, which GitHub sends as a pull_request', async () => {
    const bell = await bellOf('requested')
    expect(bell.input).toBeUndefined()
    expect(rings(bell, 'pull_request')).toBe(true)
    expect(rings(bell, 'pull_request', 'github.com/acme/other')).toBe(false)
    // `review_requested` is the action, never the event's name: declared as
    // one, it would be a doorbell that never rang.
    expect(bell.events).not.toContain('review_requested')
    for (const event of ['check_suite', 'push', 'issue_comment']) {
      expect(rings(bell, event)).toBe(false)
    }
  })

  it('rings for a branch pushed, on this repository alone', async () => {
    const bell = await bellOf('pushed')
    expect(bell.input).toBeUndefined()
    expect(rings(bell, 'push')).toBe(true)
    expect(rings(bell, 'push', 'github.com/acme/other')).toBe(false)
    for (const event of ['pull_request', 'check_suite', 'pull_request_review']) {
      expect(rings(bell, event)).toBe(false)
    }
  })

  it('rings none of them for a source that is not GitHub', async () => {
    for (const watch of ['to-review', 'review-fix', 'requested', 'pushed']) {
      const bell = await bellOf(watch)
      expect(
        doorbellRings(
          bell,
          { source: 'slack', event: bell.events[0] ?? '', where: HERE },
          { input: {}, repository: HERE },
        ),
      ).toBe(false)
    }
  })
})
