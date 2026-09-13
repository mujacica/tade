---
name: change-the-window
description: Change what `wilco app` shows, or which keys it claims — panes, the projects list, the orchestrator strip, dictation, focus rules. Use for any change to the window's behaviour or layout.
---

# Changing the window

`packages/app` is the window. It is deliberately four files, and the split is the point:

| File | Holds | Testable without |
|---|---|---|
| `model.ts` | What is shown, as data: panes, focus, key meanings | a terminal |
| `view.ts` | `renderApp(state, frame) → string[]`, one row per line | a terminal |
| `router.ts` | Whether a keystroke is for the agent or for Wilco | a terminal |
| `live.ts` | Where the facts come from: status, lanes, approvals, the journal | a workbench (the fold is pure) |
| `app.ts` | Wiring only: pi-tui, the voice surface, the workbench | — |
| `screen.ts` | The screen Wilco asks you things on: setup, settings | a terminal (rendering is pure) |

Put behaviour in `model.ts` and drawing in `view.ts`. If `app.ts` grows a rule, it is in the wrong
file and cannot be tested.

## Conventions

- **The geometry contract.** `renderApp` returns exactly `height` rows, each exactly `width` visible
  columns. A row that is off by one corrupts the whole screen, so every view test asserts it with
  `visibleWidth` at several window sizes, tiny ones included.
- **Measure with `visibleWidth` / `truncateToWidth`** from pi-tui, never `String.length`: lane
  screens carry ANSI, and `length` counts escape bytes as characters.
- **Tail, don't clip.** A pi-tui stack allocates height and then cuts children off *at the bottom*,
  which would show the top of an agent's screen and hide its newest output. The window composes its
  own rows and keeps the last N itself. Do the same for anything that grows.
- **Claim as few keys as possible.** Whatever the window does not claim is typed straight into the
  focused agent, so its own keybindings keep working. **Never claim a printable character** — that
  is why push-to-talk is `ctrl+space` and not `space`: you have to be able to type a space.
- **Key names are decided in `keys.ts`, meanings in `model.ts`.** `appKey(data, ctx)` turns bytes
  into a name; `keyAction(key, state)` decides what it means. Keeping them apart is what lets talk be
  hold-to-talk on one terminal and a toggle on another without the model knowing.
- **Hold-to-talk needs key releases**, which only some terminals report. Check
  `terminal.kittyProtocolActive` and degrade to a toggle; never assume releases arrive.
- **`addInputListener` runs before the focused component**, and returning `{ consume: true }` stops
  the keystroke there. Returning `undefined` lets it through to the agent — that is the default.
- **Nothing steals the screen while you are typing.** A pane may raise itself only for a `blocking`
  event, and only after `FOCUS_GUARD_MS` of no input. Route new auto-focus rules through
  `shouldRaise` rather than adding a second path.
- **Focus survives a refresh.** Status is polled constantly; `withTasks` keeps your place and only
  moves focus when the task is gone.
- **Every exchange shows its reasoning** (`→ verb · task · "why"`). A wrong guess must be visible and
  correctable, never silently obeyed.

## Steps

1. Add the state and its rules to `model.ts` as pure functions, with tests in `test/model.test.ts`.
2. Draw it in `view.ts`, and assert the geometry contract in `test/view.test.ts`.
3. If it needs a key, name it in `keys.ts` (test the real escape bytes — verify them against
   `parseKey` rather than writing them from memory) and give it meaning in `keyAction`.
4. If it needs a new fact, add it to `live.ts`; keep the fold from status/lanes/approvals pure and
   test that, not the polling.
5. Wire it in `app.ts`. No rules here.
6. If the wiring changed, cover it in `test/app.test.ts`, which runs the window headlessly against a
   real workbench and a real repository. `App` takes its `terminal` and `speaker` as options, and
   `Terminal.start(onInput)` hands back the callback the TUI registers — so a fake terminal can press
   keys and keep what was drawn instead of drawing it. Poll for what should appear: rendering is
   batched, so asserting on the very next line is a flake. Point `home` at a tmp dir, or status reads
   the real machine's agent transcripts.
7. Update the **window** section of `README.md`.
8. `pnpm check`.

## Gotchas

- `Component` requires `invalidate()` as well as `render(width)`; it is not optional.
- Constructor parameter properties are not erasable syntax: declare the field, then assign it.
- Run the suite on its own. A monorepo `tsc` alongside it starves the tests that spawn real git and
  PTY processes, and they time out looking exactly like a regression.
