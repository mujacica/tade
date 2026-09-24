import { describe, expect, it } from 'vitest'
import { REST_ON_SCREEN, speakable, speakableSoFar, spokenSummary } from '../src/speech.ts'

describe('speakable', () => {
  it('leaves plain words exactly as they are', () => {
    expect(speakable('Refunds has an agent on it now.')).toBe('Refunds has an agent on it now.')
    expect(speakable('Third')).toBe('Third')
  })

  it('never reads a code fence out loud', () => {
    const answer = [
      'The retry loop is the problem.',
      '',
      '```ts',
      'for (const attempt of attempts) await charge(attempt)',
      '```',
      '',
      'Two agents are on it.',
    ].join('\n')
    expect(speakable(answer)).toBe('The retry loop is the problem. Two agents are on it.')
  })

  it('drops triple quotes and what is inside them', () => {
    const answer = [
      'It printed:',
      '"""',
      'Traceback (most recent call last)',
      '"""',
      'so it threw.',
    ]
    expect(speakable(answer.join('\n'))).toBe('It printed: so it threw.')
  })

  it('drops a fence nobody closed, rather than reading the rest of the file', () => {
    expect(speakable('Here it is:\n```\nconst x = 1\nconst y = 2')).toBe('Here it is:')
  })

  it('says a path by its file, not segment by segment', () => {
    expect(speakable('The change is in packages/app/src/app.ts, near the top.')).toBe(
      'The change is in app.ts, near the top.',
    )
    expect(speakable('It lives under /Users/me/code/tade.')).toBe('It lives under tade.')
    expect(speakable('Look in src/state.ts.')).toBe('Look in state.ts.')
  })

  it('leaves alone what only looks like a path', () => {
    // One slash between two words is "and/or" far more often than a directory.
    expect(speakable('On 12/05/2024, one and/or the other.')).toBe(
      'On 12/05/2024, one and/or the other.',
    )
    expect(speakable('The task app/refunds is blocked.')).toBe('The task app/refunds is blocked.')
  })

  it('keeps inline code that is words and drops inline code that is not', () => {
    expect(speakable('Run `pnpm check` before you finish.')).toBe(
      'Run pnpm check before you finish.',
    )
    expect(speakable('It calls `this.opts.speaker.speak(text)` twice.')).toBe('It calls twice.')
  })

  it('takes the markup off a heading, a bullet and a link', () => {
    const answer = [
      '## What I found',
      '',
      '- **Two** failures in the *retry* path',
      '- See [the run](https://ci.example.com/42)',
    ].join('\n')
    expect(speakable(answer)).toBe('What I found. Two failures in the retry path. See the run')
  })

  it('reads a table as its cells, never its pipes and dashes', () => {
    const table = ['| task | state |', '| --- | --- |', '| refunds | blocked |'].join('\n')
    expect(speakable(table)).toBe('task, state. refunds, blocked')
  })

  it('is empty when there was nothing but markup', () => {
    expect(speakable('```\ncode\n```')).toBe('')
    expect(speakable('---')).toBe('')
  })

  it('closes each fence with its own marker, never with the other kind', () => {
    // A tilde fence inside a backtick one is content, not the closing half.
    const answer = ['It prints:', '```', 'a ~~~ b', '```', 'and then stops.'].join('\n')
    expect(speakable(answer)).toBe('It prints: and then stops.')
  })

  it('drops only the fence nobody closed, not the ones somebody did', () => {
    const answer = [
      'First:',
      '```',
      'one()',
      '```',
      'then:',
      '```',
      'two()', // nobody ever closes this one
    ].join('\n')
    expect(speakable(answer)).toBe('First: then:')
  })

  it('says a quote, a numbered step and a checkbox as their words', () => {
    expect(speakable('> It said no.')).toBe('It said no.')
    expect(speakable('1. Park it\n2. Start the other')).toBe('Park it. Start the other')
    expect(speakable('- [x] done\n- [ ] not yet')).toBe('done. not yet')
  })

  it('never reads a URL out, in any of the three ways they are written', () => {
    expect(speakable('See https://ci.example.com/42 for the run.')).toBe('See for the run.')
    expect(speakable('See <https://ci.example.com/42>.')).toBe('See.')
    expect(speakable('A picture: ![the graph](graph.png)')).toBe('A picture:')
  })

  it('says inline code that is a path as its file, however deep the path', () => {
    expect(speakable('It is in `src/state.ts` now.')).toBe('It is in state.ts now.')
    const deep = 'a/very/deeply/nested/directory/somewhere/else/entirely/state.ts'
    expect(speakable(`It is in \`${deep}\` now.`)).toBe('It is in state.ts now.')

    // It is the *file* that has to be worth hearing: past forty characters of
    // one, it is a thing to look at rather than a thing to say.
    const shouted = `${'a-very-long-generated-file-name'.repeat(2)}.ts`
    expect(speakable(`It is in \`src/${shouted}\` now.`)).toBe('It is in now.')
  })

  it('joins lines into one breath, so a heading does not run into the line under it', () => {
    expect(speakable('## What I found\nTwo failures')).toBe('What I found. Two failures')
    // A line that already ends in punctuation is not given a second full stop.
    expect(speakable('What I found:\nTwo failures.')).toBe('What I found: Two failures.')
  })
})

describe('spokenSummary', () => {
  it('says a short answer whole, and says nothing about a rest there is none of', () => {
    const answer = 'Refunds has an agent on it now. Which opus: 4.1, 4.6 or 5?'
    expect(spokenSummary(answer)).toBe(answer)
  })

  it('stops after a few sentences and leaves the rest on the screen', () => {
    const answer = [
      'The retry loop charges twice.',
      'It is in the webhook handler.',
      'Two agents are on it.',
      'The first one has a branch already.',
      'I can start a third.',
    ].join(' ')
    const said = spokenSummary(answer)
    expect(said).toBe(
      `The retry loop charges twice. It is in the webhook handler. Two agents are on it. ${REST_ON_SCREEN}`,
    )
  })

  it('a code block is not what it summarises', () => {
    const answer = [
      'Two tests fail.',
      '',
      '```sh',
      'pnpm vitest run packages/core',
      '```',
      '',
      'Both are in state.ts.',
    ].join('\n')
    expect(spokenSummary(answer)).toBe('Two tests fail. Both are in state.ts.')
  })

  it('cuts one very long sentence at a word rather than stopping dead', () => {
    const long = `It ${'went on and on '.repeat(40)}forever.`
    const said = spokenSummary(long)
    expect(said.length).toBeLessThan(400)
    expect(said.endsWith(REST_ON_SCREEN)).toBe(true)
    expect(said).not.toMatch(/\son$/)
  })

  it('says nothing at all for an answer that was all markup', () => {
    expect(spokenSummary('```\nconst x = 1\n```')).toBe('')
  })
})

describe('speakableSoFar', () => {
  it('hands back finished sentences and keeps the rest', () => {
    expect(speakableSoFar('First sentence. Second')).toEqual({
      say: ['First sentence.'],
      keep: 'Second',
    })
  })

  it('waits for a fence to close rather than saying half of one', () => {
    const first = speakableSoFar('Here it is. ```ts\nconst x = 1\n')
    expect(first.say).toEqual(['Here it is.'])
    expect(first.keep).toContain('```')

    const whole = speakableSoFar(`${first.keep}const y = 2\n\`\`\`\nThat is the bug.\n`)
    expect(whole.say).toEqual(['That is the bug.'])
    expect(whole.keep).toBe('')
  })

  it('says nothing for a chunk that is only markup', () => {
    expect(speakableSoFar('```\n').say).toEqual([])
  })

  it('hands back every sentence a fast chunk finished, in order', () => {
    // A model that answers in one burst still has to come out one sentence at
    // a time, in the order it wrote them.
    expect(speakableSoFar('One. Two. Three. And a half').say).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('waits for the breath after a full stop, which is what ends a sentence', () => {
    // Nothing after the stop yet: the next chunk may be `5` of `3.5`.
    expect(speakableSoFar('It costs 3.')).toEqual({ say: [], keep: 'It costs 3.' })
    expect(speakableSoFar('It costs 3.5 dollars. ').say).toEqual(['It costs 3.5 dollars.'])
  })

  it('carries a sentence across as many chunks as it arrives in', () => {
    let keep = ''
    const said: string[] = []
    for (const chunk of ['The retry ', 'loop charges ', 'twice. It is ', 'in the webhook. ']) {
      const so = speakableSoFar(keep + chunk)
      keep = so.keep
      said.push(...so.say)
    }
    expect(said).toEqual(['The retry loop charges twice.', 'It is in the webhook.'])
    expect(keep).toBe('')
  })

  it('a line of its own ends a sentence, even with no full stop', () => {
    expect(speakableSoFar('## What I found\n').say).toEqual(['What I found'])
  })
})
