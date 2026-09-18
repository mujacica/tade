---
name: add-voice-intent
description: Add or change something you can say to Tade — a verb in the spoken grammar (park, steer, show, remember...) and what it does. Use when Tade should understand a new kind of sentence.
---

# Adding something you can say

Four files, in this order. The first two are pure and hold the judgement; the last two do the work.

| File | Role |
|---|---|
| `packages/core/src/intent.ts` | the grammar: a sentence becomes an `Intent` |
| `packages/core/src/resolve.ts` | which task it meant, when the verb needs one |
| `packages/voice/core/src/voice.ts` | carrying it out, and what is said back |
| `packages/app/src/app.ts` | what the window supplies so it can happen at all |

## Steps

1. Add the variant to the `Intent` union and parse it in `parseUtterance`. Keep the grammar
   **closed and small**: it exists so common sentences never reach a model, not to understand
   English. Anything it does not recognise already has a home — free text goes to the orchestrator.
2. Say what the verb needs: a task, a project, nothing. `resolveTarget` uses that to decide whether
   it can work out what you meant, and asking is always better than guessing.
3. Handle it in `VoiceSurface.perform` (needs a task) or `act` (does not). Return the sentence that
   will be spoken back.
4. If it needs something only the window can do — moving a pane, raising a terminal window — add an
   **optional** hook to `VoiceOptions` and supply it from `app.ts`. Optional because `tade chat`
   and the tests have no window: without the hook the verb must still answer honestly rather than
   claiming something happened.
5. Add utterances to the corpus in `packages/core/test/intent.test.ts`, including the ways people
   actually say it, the homophones a transcriber will produce (`bark` for `park`), and — just as
   important — a sentence that merely *mentions* the word and must not match it.

## Rules

- **Never guess between two tasks.** Ask. `resolve.ts` returns a question, and the surface asks it;
  a wrong guess carried out silently is the failure people do not forgive.
- **A bare "yes" can never do something destructive.** Anything irreversible needs its own distinct
  phrase, and there is a generative test asserting no ordinary sentence can reach one. If you add a
  destructive verb, it belongs in that set.
- **Say back what it decided and why** (`→ park · checkout/stripe-v15 · "you mentioned it last"`).
  A wrong guess you can see is a wrong guess you can correct.
- **Never claim an effect you did not have.** If the window cannot show you something and the driver
  cannot raise a window, say where to look — do not answer as though it worked.
- **What you said is kept verbatim** where it is recorded: `intent_spoken`, notes, and the `said` on
  an approval. Never store a normalised or paraphrased utterance.
