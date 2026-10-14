---
name: redraw-the-pictures
description: Redraw the README's pictures after changing how the window or the away view's page looks, and photograph the running window, or ask a browser about the page, to check them. Use whenever a change touches layout, colour, a panel, a control, a page's script or stylesheet, or anything else somebody can see — the pictures are part of the change, not a follow-up.
---

# Redrawing the pictures

`images/` is generated. Every picture in the README is drawn from a scenario the golden tests
protect, so **a change to how the window looks is a change to the README**, and a commit that
changes one without the other leaves the page showing a window Tade no longer has.

Nothing here is ever taken by hand, touched up, or cropped in an image editor.

**You will be told when you forget.** `packages/app/test/pictures.test.ts` draws every picture again
and holds it to the bytes in `images/`, naming the ones that moved — and it is in `test:smoke`, so
the commit hook says it in a few seconds rather than CI saying it in an hour. Nothing writes the
pictures for you: the test only ever tells you to run step 3 below.

## When

Any change that somebody could see, including:

- a row, a column, a panel, a divider, a scrollbar — anything in `packages/app/src/view/`,
  `packages/app/src/panels/`, `view.ts`, `ui.ts` or `layout.ts`
- a colour, a control's look, a shade — anything in `skin.ts`
- a label, a button, a heading, a hint somebody reads
- what an extension's `view` returns, which the window draws in a panel
- the markdown renderer, the diff, the editor, the highlighter
- anything in `packages/web/src/assets/` that draws on one of the away view reel's screens — the
  overview, an agent, the plans, the spend, the conversation, the frame around them — and what the
  projection hands it (below)

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
not — and if you skip step 3, the test is the surprise instead.

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

## The away view's page

`away-page.svg` (`PAGE_REEL` in `packages/app/scripts/pictures.ts`) is the page a phone opens, and
it is **the page drawing itself, never a screenshot**: the page's own `boot.js`, routed to each
screen, booted in a stand-in document (`packages/web/scripts/still-dom.ts`) and answered the way
the server answers it — the projection of `scenarios/away-page.ts`, the same morning as the
window's pictures — then written out as XHTML into an SVG's `<foreignObject>` with the page's own
stylesheets (`page-svg.ts`). The browser showing the README lays it out. So `pnpm screens
--assets` redraws it like any other picture, and `pictures.test.ts` holds it to its bytes.

What makes the bytes the same everywhere, and each is load-bearing:

- **A visit is a process of its own** (`still.ts` spawns `still-visit.ts`), because a page load
  is a page of its own: the page numbers its headings and keeps folds in its modules, and a
  second boot in one process carries on from the first. The process gets `TZ=UTC` and nothing
  else from the environment; the clock is the world's and a date the page spells is `en-US`.
  Node 22 and Node 26 draw it to the same byte.
- **The stylesheets are pinned to the size** (`still-css.ts`): a media query and a viewport unit
  are about the picture, which a README draws at any width, so they are answered for the frame;
  `:root`, `html` and `body` become `.still-html` and `.still-body`, every rule is scoped under
  its size so a desk and a phone share one picture, and a rule naming a class no frame has is cut.
- **Nothing in it moves.** Every `animation`, `transition` and `@starting-style` is left out: a
  thumbnailer, a PDF and WebKit draw at the first instant, where a screen rising in is blank. And
  no scrollbar, which a phone and a Mac never draw at rest.
- **The frames are cut twice.** WebKit paints a `<foreignObject>`'s HTML through a `<g>` whose
  opacity is 0, so `cuts(holds, '.still-html')` hides each frame's page by its own opacity too.
- **No layout, so 0 for every measure** — except where a visit wrote down what a browser
  measured (`measured: { '.runs-map': 510 }`, the plan map's room on a 1280 desk).
- **The stage refuses what is not the page**: a boot that threw, the pairing screen, a page that
  never went live and *Nothing here* each throw rather than becoming a picture. A selector the
  stand-in cannot read throws too, and `packages/web/test/still.test.ts` reads every one the
  page asks, offline.

Whether the stand-in builds what a browser builds is the one thing it cannot say about itself:

```sh
pnpm screens --page [dir]   # every screen of the reel in Chromium, compared, and photographed
```

It serves the same world through the real server, pairs through the real page, has Chromium
build each screen at the same size, clock, zone and language, and writes each out with the same
serializer: `same`, `layout` (only an SVG's geometry differs — it prints what Chromium measures,
which is the number to write into `measured`), or `differs`, which exits 1. Into `dir` go the
page as Chromium drew it (`<n>-page.png`) and each frame of the picture as an `<img>`
(`frame-<n>.png`), to look at side by side. It needs Playwright, which is not in the lockfile:
run it from a scratch clone with `node_modules/playwright` linked in, never in a shared checkout.
Without it every screen is `unrun` and it exits 2.

A new screen in the reel is a path on `PAGE_REEL.desk` or `.phone` (`pictures.test.ts` holds
each to a route the page knows), and whatever it reads added to the world.

## Adding a picture

1. Add a scenario to the file for what it is about under `packages/app/test/screens/scenarios/` —
   a state and a frame, fixed data only: no clock, no git, no terminal. The world they are all
   drawn against is `scenarios/fixtures.ts`; `scenarios.ts` only gathers them.
2. Add an entry to `PICTURES` in `packages/app/scripts/pictures.ts`: the file, the scenario, the
   crop (a rectangle, or `'panel'` for whatever panel floats over the window), and `about` — what
   somebody who cannot see it is told, which is the alt text and is not optional.
3. Reference it from `README.md`. `packages/app/test/pictures.test.ts` fails on a picture the README
   asks for that nothing draws, on a file in `images/` that nothing shows, and on a file whose bytes
   are not what the renderer draws today.
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
  stylesheet, not a video. Adding a frame is adding a scenario to its list. The away view's reel is
  cut by the same stylesheet (`cuts`).
- **Playwright hides the caret by writing an inline style** onto the box it is in, which the next
  screen's document then carries as `style=""`. `--page` screenshots with `caret: 'initial'`.
- **`images/` is out of Biome's reach** (`biome.json`). Biome reads an SVG as HTML, so it held the
  page's runtime markup inside the away view's picture to rules for markup somebody writes, and
  would have reformatted bytes `pictures.test.ts` holds. What a picture's markup may say is the
  page's own harness's question (axe, in `packages/web/scripts/browser.ts`).
