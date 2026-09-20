---
name: redraw-the-pictures
description: Redraw the README's pictures after changing how the window looks, and photograph the running window to check them. Use whenever a change touches layout, colour, a panel, a control or anything else somebody can see — the pictures are part of the change, not a follow-up.
---

# Redrawing the pictures

`images/` is generated. Every picture in the README is drawn from a scenario the golden tests
protect, so **a change to how the window looks is a change to the README**, and a commit that
changes one without the other leaves the page showing a window Tade no longer has.

Nothing here is ever taken by hand, touched up, or cropped in an image editor.

## When

Any change that somebody could see, including:

- a row, a column, a panel, a divider, a scrollbar — anything in `packages/app/src/view.ts`,
  `panel-view.ts`, `ui.ts` or `layout.ts`
- a colour, a control's look, a shade — anything in `skin.ts`
- a label, a button, a heading, a hint somebody reads
- what an extension's `view` returns, which the window draws in a panel
- the markdown renderer, the diff, the editor, the highlighter

If you are unsure, run it: redrawing is seconds and costs nothing when nothing changed.

## The three commands

```sh
pnpm vitest run packages/app -u     # 1. accept the goldens (the look, as ANSI and as text)
pnpm screens                        # 2. look at every scenario on one page, in colour
pnpm screens --assets               # 3. redraw images/ from those same scenarios
```

Run them in that order, and **look at step 2 before accepting anything**. Where a drawing no longer
matches its golden the page shows both, golden first: that side-by-side is the review.

Then `git status images/` must be either empty or part of your diff. Both are fine; a surprise is
not.

## Checking the pictures are the program

The pictures are drawn by the real renderer over made-up state. That is what lets them show an agent
at work without an agent, and it is also what they cannot prove: whether the program a person
installs paints what that renderer draws.

```sh
pnpm screens --live [dir]                 # run the real `tade` and photograph it
pnpm screens --live [dir] --home ~/.tade  # …on your own home, instead of a seeded one
```

This starts the actual binary in a real terminal — Tade's own pty driver, with a real terminal
emulator behind it — on a disposable home with real git repositories in it, presses real keys at it
(`f1`, `ctrl+,`, `ctrl+k`, `ctrl+t`), and writes what the program painted as SVG and as the rows the
terminal holds. Nothing is drawn and nothing is recreated.

It reaches what a machine with no agents running can reach: the window on a fresh project, the keys
sheet, settings, extensions and search. It cannot reach an agent at work — that is a model and a
bill — which is exactly the line between what it checks and what the scenarios are for.

It says when it could not read something in the stream, and when a take came back showing the screen
of the take before it (a key that did not arrive, a panel that did not open). Both are failures a
photograph cannot show you, so neither is ever silent.

Use it when a change is to how things are *painted* rather than to what is drawn, when a picture
looks wrong and you cannot see why in the golden, and before a release. It is how the gap between
two buttons was found to be coming back painted (`styledLine`, the pty driver) — a bug no golden
could see, because the goldens never go through a terminal.

## Adding a picture

1. Add a scenario to `packages/app/test/screens/scenarios.ts` — a state and a frame, fixed data
   only: no clock, no git, no terminal.
2. Add an entry to `PICTURES` in `packages/app/scripts/pictures.ts`: the file, the scenario, the
   crop (a rectangle, or `'panel'` for whatever panel floats over the window), and `about` — what
   somebody who cannot see it is told, which is the alt text and is not optional.
3. Reference it from `README.md`. `packages/app/test/pictures.test.ts` fails on a picture the README
   asks for that nothing draws, and on a file in `images/` that nothing shows.
4. `pnpm screens --assets`.

## Gotchas

- **A fixture must not be kinder than reality, or harsher.** A lane is resized to the pane it is
  drawn in (`fitLane`), so a canned lane screen written for a full-width pane and then used in a
  split draws text running off the edge — a picture of a bug Tade does not have. Write each
  scenario's `screen` at the width the pane it lands in actually has.
- **Every picture's `about` is read aloud.** It is what a screen reader says and what a search engine
  indexes; `pictures.test.ts` holds it to a length, not to a quality.
- **The theme is written down once**, in `packages/app/scripts/terminal.ts`: a terminal's default ink
  and ground are the person's, not the program's, and text Tade leaves unpainted has to come out as
  *something*. Change it there, never per picture.
- **The reel at the top of the README** (`REEL`) is several scenarios one after another as a
  stylesheet, not a video. Adding a frame is adding a scenario to its list.
