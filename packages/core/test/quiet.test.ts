import { describe, expect, it } from 'vitest'
import { composePrompt } from '../src/compose.ts'
import { ConfigSchema } from '../src/config.ts'
import { NEVER_GO_QUIET, wentQuiet } from '../src/quiet.ts'

// A turn that ended with nothing said: the rule the orchestrator is told, and
// the sentence Tade says when it happens anyway.

describe('a turn that said nothing', () => {
  it('is a rule the orchestrator is told, not only a net under it', () => {
    // The only turn that can say what a tool answered is the one that called
    // it, so the prompt is the half that can be done properly — and a rule
    // that is only in a file nothing reads is not a rule.
    const prompt = composePrompt({ config: ConfigSchema.parse({ projects: {} }) })
    expect(prompt).toContain(NEVER_GO_QUIET)
    expect(NEVER_GO_QUIET).toContain('Never end a turn with nothing said')
    // Including the clause that stops it inventing one: a turn with nothing
    // to say has a wrong tool call in it, and saying so is the answer.
    expect(NEVER_GO_QUIET).toContain('the wrong one')
  })

  it('is said naming the tool it ended on, and never as a bare "done"', () => {
    const quiet = wentQuiet('status')
    expect(quiet).toContain('status')
    // What the person cannot know from a spinner, which is the whole point of
    // saying anything at all.
    expect(quiet).toContain('is not still thinking')
    // And nothing claiming to be the answer the tool gave: Tade cannot read
    // one back without inventing it.
    expect(quiet).not.toMatch(/\bdone\b/i)
  })
})
