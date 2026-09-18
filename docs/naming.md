# Naming: what to call this thing instead of Wilco

Research, not a decision. Nothing in the code is renamed by this document.

Checks run on **2026-09-18**. Availability rots fast — everything below is a snapshot, and the
commands used are given so any line can be re-run before anyone acts on it.

## 1. What is being named

Not "a wrapper that says *will comply*". What exists now, from [AGENTS.md](../AGENTS.md) and
[README.md](../README.md):

- A **voice-first control room**: you hold `ctrl+space` and talk to an orchestrator that starts,
  steers and stops other agents, runs commands in terminals, and shows its work.
- **Lanes**: agents are pi processes in terminals owned by a driver (tmux or pty), in the project's
  checkout or in a worktree each, many at once.
- **Status is derived, never remembered**: git, processes, adoption, tests and liveness are probed
  and reduced by a pure function. The product owns no state of its own.
- **A queue, schedules and watches**: work that has not started yet and starts itself by rule; a
  clock; extensions that look before they act and hand findings to new agents.
- **Extensions, telemetry, spend, approvals**: dependencies and Sentry in the box, `gen_ai` traces
  of every agent turn, dollars per agent, a policy for risky commands.

So the name has to carry: **many workers, one place you watch them from, and a voice**. "Wilco" —
one radio word meaning *I will comply* — names a single obedient agent. It is the name of the
smallest version of this product.

### Why the current name has to go (evidence, not vibes)

| Collision | What it is |
|---|---|
| `wilco.com` | **WILCO AG** — Swiss maker of container-closure integrity and visual inspection machines. Live site, clear trademark interest. |
| Wilco | The band. Wikipedia's `Wilco` article is the band; the disambiguation page is long. Unwinnable in search. |
| `trywilco.com` / `wilco.gg` | **Wilco**, the developer-upskilling startup — now "joining Lemonade" (site is a goodbye page). A funded dev-tools company used this exact name in this exact market. |
| npm `wilco` | Taken since 2015 — "an opinionated CSS linter". |
| GitHub `wilco` | Taken (a personal account). `SonnyBonds/wilco` is a C++ build generator. |
| Wilco Publishing | Flight-sim add-on publisher, i.e. the same aviation-radio well the name was drawn from. |
| `wilco.ai` | Parked, "Domain For Sale". |

Checked with: `https://registry.npmjs.org/wilco`, `gh api users/wilco`, `gh api search/repositories
-f q='wilco in:name'`, Wikipedia search API, and HTTP `<title>` fetches of `wilco.com`, `wilco.ai`,
`trywilco.com`, `wilco.gg`.

## 2. What a replacement has to do

Weighted, because these conflict:

1. **Unambiguous in this market** (heaviest). Not a band, not a public company, not an existing
   agent-orchestration repo. Search for `<name> coding agents` must not already answer something else.
2. **Ownable**: npm package name *and* `@scope` free (20 workspace packages need the scope), a
   GitHub org obtainable, and at least one domain we'd be happy to print.
3. **Typed often**: the binary is in muscle memory. ≤ 8 characters is comfortable; a product name
   longer than that needs a short binary (Kubernetes → `kubectl`, GitHub CLI → `gh`).
4. **Said out loud**, by a person wearing a headset, to other people: two or three syllables, no
   spelling ambiguity, no homophone, survives a British and an American mouth.
5. **True to the metaphor**: a place you watch work from and talk into. Cheap "AI" morphemes are out —
   this thing will outlive the current naming fashion.

## 3. How availability and collisions were checked

Every endpoint was **control-tested** against a known-registered and a known-free name before its
results were believed. This matters: `https://www.registry.google/rdap/domain/<d>.dev` returns `404`
for *everything* (it says `web.dev` is free), so an entire first pass of `.dev` results was wrong and
was thrown away and redone.

| Check | How | Semantics |
|---|---|---|
| `.com` | `curl https://rdap.verisign.com/com/v1/domain/<n>.com` | 404 = free, 200 = registered |
| `.dev` | `curl https://pubapi.registry.google/rdap/domain/<n>.dev` | as above (control: `web.dev` → 200) |
| `.io` | `curl https://rdap.identitydigital.services/rdap/domain/<n>.io` | as above |
| `.ai`, `.sh` | `whois -h whois.nic.ai <n>.ai`, `whois -h whois.nic.sh <n>.sh` | "Domain not found" = free |
| `.app .run .tools .works .team` | `curl -L https://rdap.org/domain/<n>.<tld>` (throttled ≥ 3 s; it 429s) | 404 = free |
| npm package | `https://registry.npmjs.org/<n>` | 404 = free |
| npm scope | `https://registry.npmjs.org/-/v1/search?text=scope:<n>` | `total: 0` = nothing published under it |
| GitHub org/user | `gh api users/<n>` | 404 = free |
| GitHub prior art | `gh api search/repositories -f q='<n> in:name' -f sort=stars` | top repos read by hand |
| PyPI / crates.io | `https://pypi.org/pypi/<n>/json`, `https://crates.io/api/v1/crates/<n>` | 404 = free |
| Products/companies | HTTP `<title>` of `<n>.com` and `<n>.ai`; Wikipedia `list=search`; one working pass of DuckDuckGo's HTML endpoint | who is actually sitting on the name |

**Limits, stated plainly.**

- **No trademark register could be searched.** `trademarks.justia.com` is behind Cloudflare (403),
  USPTO's search API rejects anonymous queries, TSDR needs a key, WIPO Global Brand Database needs
  JavaScript. So every "trademark risk" below is an *inference* from registrants, live sites,
  Wikipedia and public knowledge — **not clearance**. Whatever is chosen needs a real search (USPTO
  TESS + EUIPO eSearch, classes 9 and 42) before money is spent on it.
- **Web search was mostly unavailable**: DuckDuckGo's HTML endpoint answered once and then served a
  CAPTCHA; Bing returned unrelated pages; Mojeek and Qwant challenged the request; Google needs JS.
  GitHub search, npm, PyPI, crates.io, Wikipedia and homepage titles carried the collision work
  instead. They cover software collisions well and consumer-brand collisions badly.
- My own knowledge of companies has a cutoff, so "no product I know of" is weaker than the
  registry results and is labelled when it's all there is.

## 4. Two findings that should shape the decision

**(a) Exact-match `.com` is gone. Not "expensive" — gone.** Around ninety-five names were run
through these checks; exactly two had a free `.com` (`watchwright`, `deckhail`). Every real English word tried was registered, and so was
nearly every two-word compound: `lanework`, `watchwork`, `yardwork`, `deckmaster`, `lanemaster`,
`watchward`, `helmhouse`, `lanesmith`, `yardsmith`, `bridgewright`, `tackline`, `watchkeeper`,
`sayward`, `voxdeck`, `bridgekeep`, `standwatch` — all taken, most by holders with no site on them.
So `.com` cannot be a gate. For a developer tool, `.dev` or `.sh` is native and honest; a `.com`
variant (`get<name>.com`, `<name>hq.com`) is a fallback, and buying the exact match later is a
budget question, not a naming one.

**(b) This exact metaphor space is being colonised right now, by tools exactly like this one.**
Found while checking, all of it 2025–2026:

- `watchbill.ai` — "The operating layer for Supervised Autonomy"
- `sortie-ai/sortie` ★187 — "Turn tracker tickets into autonomous agent sessions"
- npm `ringdown` — "a switchboard for coding agents and their humans"
- npm `quarterdeck` — "A quarterdeck foundation for coding agents"
- npm `pitwall` — "Local web app for reviewing Claude Code sessions"
- `racecraft-lab/Paddock` — "AI software factory control plane for GitHub issue-driven workflows"
- `TraceRt314/airboss` — "Control tower TUI for Claude Code and Codex sessions"
- `aethrox/laneward` — "Runs several coding agents on one repo at once, each in its own git worktree"
- `gw7523/watchbill` — "Cockpit CLI that catalogs, parks, and restores coding-agent fleets"
- `jrabercrombie/watchbill`, `Sovereign-Labs-AU/watchbill`, `avanturist322/quarterdeck`,
  `PhilippeTesteroni/claude-quarterdeck`, `dalonsogomez/fairlead` — same idea, same well of words
- `NVIDIA-NeMo/Switchyard` ★3148 — LLM traffic routing across models and providers

Most are hobby repos with single-digit stars, and none of them is a trademark problem. But they are a
warning: **nautical/rail/air-traffic control-room words are the obvious choice, so they are all being
taken this year.** Whatever is picked: re-verify on the day, and take npm package + `@scope` + GitHub
org + domains in one sitting.

## 5. Candidates

Availability shorthand: `✓` free, `✗` taken. "npm" is the bare package name, "@" is the scope.

| # | Name | CLI | npm | @ | .com | .dev | .ai | .sh | .io | GH org | Collision risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Watchwright | `wright` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **very low** |
| 2 | Airboss | `airboss` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | dormant | medium (a public company) |
| 3 | Yardmaster | `ym` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | dormant | low |
| 4 | Earshot | `earshot` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | dormant | medium (a voice library) |
| 5 | Lanewright | `lw` | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | low |
| 6 | Orderwire | `ow` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | low |
| 7 | Flightline | `fl` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | dormant | medium (a famous racehorse) |
| 8 | Dogwatch | `dogwatch` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | medium (a consumer brand) |
| 9 | Fairlead | `fairlead` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | medium |
| 10 | Hawser | `hawser` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | medium (an agent repo ★611) |
| 11 | Marshaller | `mar` | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | low, but the word means serialisation |
| 12 | Binnacle | `binnacle` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | dormant | medium |
| 13 | Pelorus | `pelorus` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | high (DORA-metrics tool) |
| 14 | Quarterdeck | `qd` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | high (agent tools + QEMM) |
| 15 | Wheelhouse | `wh` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | dormant | high (python wheels) |
| 16 | Interlock | `interlock` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | high |
| 17 | Apron | `apron` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | high |
| 18 | Sitrep | `sitrep` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | high (Swift tool ★1351) |
| 19 | Muster | `muster` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | dormant | high |
| 20 | Reeve | `reeve` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | high (surname, TUI tool) |
| 21 | Paddock | `paddock` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | high (agent control plane) |
| 22 | Pitwall | `pitwall` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | very high (F1 apps, Claude tool) |
| 23 | Switchyard | `sy` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | very high (NVIDIA NeMo ★3148) |
| 24 | Conn | `conn` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | very high (reads as "connection") |

"dormant" = the GitHub account exists with zero or near-zero public repos, so the handle would have
to be varied (`<name>-dev`, `<name>hq`) or requested.

---

### 1. Watchwright — *the keeper of the watch* · binary `wright`

**Meaning.** A *watch* is the naval shift: who is awake, watching, and answerable right now. A
*wright* is one who makes and keeps a thing working — shipwright, wheelwright. Coined, but every
English speaker parses it in one pass.

**Fit.** Unusually exact for a coinage. The product literally keeps watches (`watch_checked`,
`watch_found`), runs schedules, and the window is the standing watch over every lane. "The wright
keeps the watch; the agents do the work" is the product in one line.

**Collisions.** None found anywhere: no npm package, no npm scope, no PyPI or crates.io package, no
GitHub account, no repo with the word in its name, no Wikipedia entry, no site on the `.com`. Being
coined is also the strongest trademark position available here (fanciful marks are the easiest to
register and defend).

**Domains.** `watchwright.com`, `.dev`, `.ai`, `.sh`, `.io` **all free** (Verisign RDAP,
pubapi.registry.google, whois.nic.ai, whois.nic.sh, Identity Digital, 2026-09-18). The only clean
sweep in this entire list.

**CLI.** The name is 11 characters, so the binary can't be the name. `wright` (6) is unclaimed on a
normal PATH, reads as a word, and types easily: `wright status`, `wright brief`. `ww` is the
two-letter fallback.

**Spoken.** "WATCH-rite". Three syllables, no spelling trap, no homophone collision that matters
("Wright" as a surname is the only echo, and it flatters). Slightly formal; less punchy than Wilco.

---

### 2. Airboss — *the officer who runs the flight deck* · binary `airboss`

**Meaning.** On a carrier, the Air Boss runs the flight deck from the tower: launches, recoveries,
who goes where, by radio, continuously.

**Fit.** The best single-word description of this product that exists in English. Voice-first,
many parallel operations, one person watching from above, nothing stored — the deck is the truth.

**Collisions.** `airboss.com` is **AirBoss of America** — a listed manufacturer of rubber and defense
products, with an "AirBoss Defense Group" division. Different class of goods, but a real company with
real marks and lawyers; this is the one candidate where I'd want clearance before printing anything.
Software-side is nearly clear: npm `airboss` free, `@airboss` empty, PyPI free, and the only repos are
single-star hobby projects — one of which (`TraceRt314/airboss`) is a "control tower TUI for Claude
Code", i.e. the same idea, unpublished and unowned. PyPI and crates.io are free too.

**Domains.** `.com` ✗ (AirBoss of America, since 1995), `.ai` ✗ (2025), `.io` ✗ (2019);
**`.dev` free**, **`.sh` free**, `.run`/`.tools`/`.works`/`.team` free.

**CLI.** `airboss` — 7 characters, one hand mostly, no conflict on PATH.

**Spoken.** Two syllables, hard consonants, carries over a bad microphone: "air boss". Everyone
understands it without being told the naval origin, which is exactly what Wilco never managed.

---

### 3. Yardmaster — *the one who decides which train takes which track* · binary `ym`

**Meaning.** In a classification yard, the yardmaster stands above the tracks and assigns every
movement: what rolls now, what waits in a siding, what couples to what.

**Fit.** The clearest plain-English match for lanes + a queue + derived status. No AI hype, no
nautical cosplay; a person's job, which is the correct register for a tool that is a control room.

**Collisions.** Low and harmless: npm `yardmaster` free, `@yardmaster` empty, GitHub has a
`hubot-yardmaster` Jenkins plugin (★13) and a Walmart yard-management student project; PyPI has a
`yardmaster` package, crates.io does not. `yardmaster.com` is held (403, no readable site),
`yardmaster.ai` is parked. It is an occupational term, so it is
weak as a trademark — hard for us to own, and equally hard for anyone to stop us.

**Domains.** `.com` ✗ (2002), `.dev` ✗, `.ai` ✗ (2026), `.io` ✗ (2026); **`.sh` free**, `.run`,
`.tools`, `.works`, `.team` free.

**CLI.** The weak point. `yardmaster` is 10 characters; `yard` — the natural short form — is Ruby's
YARD documentation binary, which many developers have installed, so it is out. `ym` works but says
nothing.

**Spoken.** Three syllables, warm, unmistakable. "Ask the yardmaster" is a sentence people will say.

---

### 4. Earshot — *everything within earshot* · binary `earshot`

**Meaning.** The distance over which a voice carries.

**Fit.** Names the voice surface and the scope of control at once: the agents within earshot are the
ones you can talk to. Weakness: it says *listening*, not *command* — it is half the product.

**Collisions.** npm `earshot` free, `@earshot` empty, GitHub account dormant. But `pykeio/earshot`
(★198) is a streaming voice-activity-detection library, and `wiringai/mod_earshot` (★53) streams call
audio to AI voice agents — both inside our own voice niche, which is the wrong place to share a name.
Also an indie band and the Canadian campus-radio "Earshot" chart.

**Domains.** `.com` ✗ (1995), `.dev` ✗ (2025), `.ai` ✗ but **explicitly listed for sale**, `.io`
**free**, `.sh` **free**.

**CLI.** `earshot`, 7 characters, pleasant to type.

**Spoken.** Excellent — two syllables, soft, memorable, spells itself.

---

### 5. Lanewright — *the wright who works the lanes* · binary `lw`

**Meaning.** Same construction as Watchwright, pointed at lanes instead of watches.

**Fit.** "Lane" is this codebase's own word for where an agent lives, which is either perfect or
too inside-baseball to mean anything to a newcomer.

**Collisions.** Almost nothing: npm free, `@lanewright` empty, GitHub account free, no repos, no
Wikipedia entry. `lanewright.com` was registered in 2014 with no site.

**Domains.** `.com` ✗; `.dev`, `.ai`, `.sh`, `.io`, `.app`, `.run`, `.tools`, `.works`, `.team` all
**free**.

**CLI.** 10 characters, so `lw` — anonymous.

**Spoken.** Fine but flat; "lane" carries no emotion, and highway-lane imagery competes.

---

### 6. Orderwire — *the always-open voice channel between operators* · binary `ow`

**Meaning.** A real telecom term: the dedicated voice circuit technicians use to coordinate work
across a system while the system carries traffic.

**Fit.** Uncannily close — a permanent voice channel to whoever is doing the work is precisely what
`ctrl+space` is. But the term is known to almost nobody outside telecom, so it teaches nothing.

**Collisions.** npm free, `@orderwire` empty, PyPI and crates free; GitHub org `OrderWire` is taken
by a restaurant ordering platform, which also holds `orderwire.com`. Wikipedia knows the term only
via MIL-STD-188 and SONET articles.

**Domains.** `.com` ✗ (a live F&B platform), `.ai` ✗ (2026), `.io` ✗; **`.dev` free**, **`.sh` free**.

**CLI.** 9 characters; `ow` is unfortunate ("ow").

**Spoken.** Three syllables, slightly clumsy, and heard as "order wire" — people will think it is
about purchase orders.

---

### 7. Flightline — *where the aircraft are parked, serviced and launched from* · binary `fl`

**Meaning.** The strip of apron where aircraft sit between sorties, crews working on all of them at
once.

**Fit.** Good: many machines side by side, each being worked on, all visible from one place. "Lanes"
are literally the parking spots.

**Collisions.** npm free and `@flightline` empty, GitHub dormant — but **Flightline** is one of the
most famous racehorses of the decade (top Wikipedia hit), and `flightline.ai` already resolves to a
site called Flightline. Search results would never be ours.

**Domains.** `.com` ✗ (1995), `.dev` ✗, `.ai` ✗, `.sh` ✗, `.io` ✗. Nothing good left.

**CLI.** 10 characters; `fl` is taken by nothing but says nothing.

**Spoken.** Two syllables, clean, easy — the best thing about it.

---

### 8. Dogwatch — *the short watch nobody wants* · binary `dogwatch`

**Meaning.** The brief evening watches aboard ship, split so the same crew never always draws the
worst hours.

**Fit.** Names the watches-and-schedules half of the product, and quietly names the point of it:
the machine takes the ugly shift. Off-metaphor for the control room itself.

**Collisions.** npm free, `@dogwatch` empty. `dogwatch.com` is **DogWatch**, a long-standing US
hidden-dog-fence brand (consumer, trademarked, different class). GitHub has small monitoring tools
(`rapid7/dogwatch`, ★17). Practical problem: "dog" makes readers think pets, and the tone is
slightly self-deprecating.

**Domains.** `.com` ✗, `.dev` ✗ (2020), `.ai` ✗ (2026), `.io` ✗; **`.sh` free**.

**CLI.** `dogwatch`, 8 characters, types fine.

**Spoken.** Two syllables, strong, memorable, faintly comic.

---

### 9. Fairlead — *the fitting that guides many lines so none of them foul* · binary `fairlead`

**Meaning.** A marine fitting that leads a rope where it should go, without chafe or tangle.

**Fit.** The best *mechanism* metaphor in the list: many concurrent lines, guided so they don't
snarl — a queue, worktrees, lanes. The accidental second reading ("leading fairly") is a bonus.

**Collisions.** npm free and `@fairlead` empty, but a **GitHub org `Fairlead` exists with
`fairlead.dev`** (9 repos), `fairlead.com` is a live engineering company, and
`dalonsogomez/fairlead` is already "repo-scoped context guidance for coding agents". Contested.

**Domains.** `.com` ✗, `.dev` ✗ (that org), `.ai` ✗, `.io` ✗; **`.sh` free**, plus `.run`, `.tools`,
`.works`, `.team`.

**CLI.** 8 characters, easy.

**Spoken.** Two syllables, pleasant — but heard as "fair lead", and sales software has ruined
"lead".

---

### 10. Hawser — *the heavy line that holds a ship to the quay* · binary `hawser`

**Meaning.** A thick rope for mooring and towing.

**Fit.** Weak: it is a rope, not a place you watch from or a voice.

**Collisions.** npm free, `@hawser` empty, but `Finsys/hawser` (★611) is "the agent for Dockhand" —
an agent tool with real traction. That alone disqualifies it.

**Domains.** `.com` ✗, `.dev` ✗ (2026), `.ai` ✗, `.io` ✗; **`.sh` free**.

**CLI.** 6 characters, good. **Spoken.** "HAW-zer" — distinctive; some will read "hawker".

---

### 11. Marshaller — *the one on the apron waving the aircraft in* · binary `mar`

**Meaning.** The person who directs moving aircraft by hand signal — the human who tells a large
machine exactly where to go.

**Fit.** Lovely image, fatal in a programming context: in software, *marshalling* means serialising
data, and half the results for the word are XML/JSON marshallers.

**Collisions.** npm `marshaller` is taken (dormant), but **`marshaller.dev`, `.ai`, `.sh`, `.io` are
all free** and `@marshaller` is empty. The meaning collision is the problem, not the registries.

**CLI.** 10 characters. **Spoken.** Three syllables; British/American spellings differ
(marshaler/marshaller), which is a support burden forever.

---

### 12. Binnacle — *the stand on the bridge that holds the instruments* · binary `binnacle`

**Meaning.** The housing at the helm holding the compass, lit so it can be read at night.

**Fit.** Very good, and unusually precise about the architecture: the binnacle holds no truth of its
own, it is where you *read* the ship's state from. That is `deriveState` exactly.

**Collisions.** npm `binnacle` is taken (an abandoned `binnacle.io` logging/push SaaS client), and
GitHub has a scatter of small tools (`traackr/binnacle` for Helm, a Cloudflare-admin desktop app, a
bioinformatics tool). No big product, but the npm name being gone hurts a CLI.

**Domains.** `.com` ✗ (1996), `.dev` ✗, `.ai` ✗, `.io` ✗ (the dead SaaS); **`.sh` free**, `.tools`,
`.works`, `.team` free.

**CLI.** 8 characters, fine. **Spoken.** "BIN-a-kul" — three syllables, slightly antique, needs
explaining once. People will spell it with one N.

---

### 13. Pelorus — *the sighting instrument for taking bearings* · binary `pelorus`

Meaning and fit are strong (you sight other vessels from your own bridge). But
**`dora-metrics/pelorus`** (★253, Red Hat) is an established DevOps-measurement tool in an adjacent
category, `linuxserver/pelorus` is "agentic control of Linux desktops", and npm `pelorus` is taken.
`.dev` and `.sh` free, `.com`/`.ai`/`.io` gone. Too much confusion for too little gain.

### 14. Quarterdeck — *where the officer of the deck stands* · binary `qd`

Perfect meaning, terrible availability: npm `quarterdeck` is already "a quarterdeck foundation for
coding agents", two more Claude-Code tools use the word, `quarterdeck.co.uk` is a live company, and
Quarterdeck Office Systems (QEMM) still owns the memory of anyone over 45. Only `.sh` free.

### 15. Wheelhouse — *the enclosed bridge; also "in my wheelhouse"* · binary `wh`

The idiom is a gift and the literal meaning is right. But in Python, a *wheelhouse* is a directory of
built wheels — npm taken, PyPI taken, GitHub full of wheel-caching tools, `wheelhouse.com` redirects
to a software-review aggregator. Only `.sh` free. Too noisy.

### 16. Interlock — *railway interlocking: signals that cannot allow conflicting routes* · binary `interlock`

The safety metaphor for a queue is excellent ("no two agents on the same track"). Reality: npm taken,
`ehazlett/interlock` ★974, `usbarmory/interlock` ★307, and `interlock.com` sells ignition-interlock
(drunk-driving) services. Search is hostile. `.sh` and `.io` free.

### 17. Apron — *the airport surface where aircraft are worked on* · binary `apron`

Short, sayable, and the aviation meaning is exactly "the place where the parked machines are
serviced". But the everyday meaning (kitchen) swamps it, npm is taken, `apron.ai` belongs to Assaia
(an actual aviation-AI company, on the apron), and `antoinemine/apron` (★147) is a well-known static
analysis library. `.sh` free only.

### 18. Sitrep — *situation report* · binary `sitrep`

This is `wilco brief` as a name, and it is short and military-crisp. But `twostraws/Sitrep` (★1351)
is a widely used Swift analyser, `babel-plugin-sitrep` has ★433, npm is taken, and `.com`, `.dev`,
`.ai`, `.sh` and `.io` are all registered. Also: it names one feature, not the product.

### 19. Muster — *to assemble the crew, and answer for who is present* · binary `muster`

"Muster the agents" is a good sentence, and a muster is exactly a roll-call of who is working. But
npm is taken, `facebookarchive/muster` and `sinatra/mustermann` are in results, "Muster" is German
for *pattern* (and a famous tennis player), and every domain is gone. Too generic.

### 20. Reeve — *the old officer who oversaw other people's work* · binary `reeve`

Five letters, one syllable, great CLI, and the etymology (shire-reeve → sheriff) is a real find. Undone
by people: Christopher Reeve dominates the word, npm `reeve` is taken, `yetidevworks/reeve` (★89) is a
dev-environment TUI, and `reeve.com` is a radio-observatory site. No domains.

### 21. Paddock — *where the race teams work between sessions* · binary `paddock`

Good motorsport metaphor and easy to say, but `racecraft-lab/Paddock` is already "AI software factory
control plane", npm is taken, `truespar/paddock` (★91) is an inference server, and the top Wikipedia
hit is the Las Vegas mass shooter. No.

### 22. Pitwall — *the wall where the engineers watch telemetry and talk to the driver* · binary `pitwall`

The single most accurate metaphor for a voice-first control room, and therefore the most taken: F1
telemetry apps in every direction (the one search that worked returned eight of them), npm `pitwall`
is a Claude-Code session reviewer, `pitwall.ai` is a live AI company, `pit-wall.com` is someone's
site. Only `.io` free. Dead on arrival.

### 23. Switchyard — *where wagons are sorted onto tracks* · binary `sy`

Right metaphor, wrong year: **`NVIDIA-NeMo/Switchyard`** (★3148) routes LLM traffic across models and
providers — adjacent enough to be confused with us forever. npm taken, JBoss SwitchYard is still in
search results. Nothing free.

### 24. Conn — *"you have the conn": command of the ship's movement* · binary `conn`

The four-letter CLI of anyone's dreams and a genuinely apt meaning (the conn is control handed over
and handed back — exactly the orchestrator/agent relationship). But `conn` reads as an abbreviation
of *connection* in every developer's eye, npm is taken, GitHub search for it returns connection
libraries with five-figure stars, and Conning is an insurance asset manager. Unsearchable.

### Checked and dropped early

Each of these failed on one hard fact, so they were not written up:

`Bosun` (npm `bosun` is *already* "manages AI agent executors"; `bosun-ai/*` orgs; Stack Exchange's
Bosun) · `Sortie` (`sortie-ai/sortie` ★187, same product) · `Watchbill` (`watchbill.ai` — "operating
layer for Supervised Autonomy") · `Ringdown` (npm: "a switchboard for coding agents") ·
`Laneward` (a repo that runs agents in worktrees already uses it) · `Crowsnest`
(`mainsail-crew/crowsnest` ★403) · `Readback`, `Tarmac`, `Capstan`, `Squawk`, `Deckhand`,
`Flightdeck`, `Vigil`, `Gantry`, `Gangway`, `Siding`, `Kedge` (npm taken **and** every checked TLD
taken) · `Belay`, `Davit`, `Berth`, `Slipway`, `Boatyard`, `Railyard`, `Bollard`, `Windlass`,
`Purser`, `Sheave`, `Moorage` (npm **and** `.com` both taken — no further checks warranted) · `Talkback` (Android's screen reader) · `Tally` (Tally accounting, tally.so) ·
`Roundhouse` (RoundhousE migrations) · `Talkyard` (Talkyard forum software) · `Squelch` (radio term,
but npm taken and eight unrelated repos) · `Sayso`, `Behest`, `Conning`, `Steerhouse`, `Lanewise`,
`Lanewell`, `Bittacle`, `Deckwright`, `Watchhouse`, `Deckhail` (weak meaning, awkward to say, or
both).

## 6. Shortlist and recommendation

| | Watchwright | Airboss | Yardmaster |
|---|---|---|---|
| Says what it is | keeps the watch | runs the deck | assigns the tracks |
| Ambiguity today | none found | a listed manufacturer | an occupational term |
| npm pkg + scope | free + free | free + free | free + free |
| Domain we'd print | `watchwright.com` (free) | `airboss.dev` / `.sh` | `yardmaster.sh` |
| GitHub org | free | dormant account | dormant account |
| Binary | `wright` (6) | `airboss` (7) | `ym` (2) |
| Said out loud | 3 syllables, formal | 2 syllables, instant | 3 syllables, warm |
| Trademark position | fanciful — strongest | risky, needs clearance | descriptive — weak |

**Recommendation: Watchwright, with `wright` as the binary.**

Because the brief's two hard requirements are *unambiguous* and *we can get a domain*, and it is the
only candidate that satisfies both without argument: nothing on npm, nothing on GitHub, nothing on
Wikipedia, no site anywhere, and `.com`/`.dev`/`.ai`/`.sh`/`.io` all free on the same day — which,
after checking sixty-odd names, I did not expect to find twice. It is also the only shortlisted name
whose trademark position is actually defensible, and it happens to describe the thing the product
alone does: it keeps the watch, derives who is standing it, and wakes people up. The cost is honest:
eleven letters, three syllables, and a binary that isn't the product's name — the same trade
Kubernetes and GitHub CLI made.

- **Take Airboss instead if punch beats ownership.** It is the better *spoken* name and needs no
  explanation, and `airboss`-the-binary is the nicest in the list. Before committing, get a real
  trademark opinion on AirBoss of America / AirBoss Defense Group in classes 9 and 42, accept that
  `airboss.com` will never be ours, and re-check that hobby "control tower TUI" repo.
- **Take Yardmaster if plainness beats both.** Nothing to explain to anyone, no metaphor tax, and
  no realistic enemy — but no distinctive mark to own and no binary worth typing.
- Whichever it is: **register in one sitting** — npm package + `@scope`, GitHub org, `.com`/`.dev`/
  `.sh` — because §4(b) shows this vocabulary being consumed month by month.

## 7. What a rename would actually touch

Measured, not estimated: **2881 occurrences of "wilco" (case-insensitive) across 380 tracked files**.
Grouped by what breaks if you get it wrong.

**Free to change (cosmetic, no state depends on it)**

| Thing | Where |
|---|---|
| Binary name `wilco` | `packages/cli/package.json` (`bin`), root `pnpm wilco` script, README install/use |
| Default attach command `wilco attach <lane>` | `packages/drivers/pty/src/index.ts` |
| ASCII banner and the "will comply" tagline | `README.md`, `packages/app/src/screen.ts` — **the pun dies with the name; a new one is needed** |
| Docs | `README.md`, `AGENTS.md`, `CLAUDE.md` (a link), 22 markdown files, 16 recipes in `.claude/skills/` |
| Notices | `THIRD_PARTY_NOTICES.md` + `scripts/notices.ts` (regenerate with `pnpm notices`) |
| Prompts that say the agent "runs in Wilco" | `composeAgentPrompt`, the orchestrator prompt (re-run the live test afterwards: it is the only evidence a model still picks the right tool from the new words) |

**Mechanical but wide (one sweep, then `pnpm check`)**

| Thing | Count |
|---|---|
| `@wilco/*` package scope | 20 workspace packages, plus every import in the repo |
| Root package name `wilco` | 1 |
| `WILCO_*` environment variables | 20 distinct (`WILCO_HOME`, `WILCO_TELEMETRY_DSN`, `WILCO_LIVE`, `WILCO_SOCKET`, `WILCO_TASK_ID`, …) — two of them are documented for users, so accept both names for a release |

**Careful: renaming these strands work that is currently running or already on disk**

| Thing | Where | Why it needs a compatibility path |
|---|---|---|
| `~/.wilco` home | `wilcoHome()` in `packages/core/src/config.ts` | Holds `config.yaml`, `memory.jsonl` (notes — nothing can recover them), `events.jsonl` + its SQLite index, `schedules.jsonl`, `lanes.json`, `window.json`, `skills/`, `extensions/active|proposed/`. Move on first start, or read the old path when the new one is absent. |
| Per-project `.wilco/` | 141 references in `.ts` alone; `tasks/<name>/task.yaml`, `context.md`, and `mkrepo` fixtures | Every existing task lives there, and a task's id is in its file, not its branch. |
| Branch prefix `wilco/` | `TASK_BRANCH_PREFIX` in `packages/status/src/status.ts` and `packages/workbench/src/tasks.ts`, `app.ts`, `mkrepo.ts` | Branches already pushed keep the old prefix. Status must recognise both, probably forever. |
| pi session ids `wilco-<task>` | `sessionIdFor()` in `packages/harnesses/pi/src/adapter.ts` | The id is what makes reopening a conversation ordinary. Change the formula and every existing agent loses its history — and task names are never reused, so there is no second chance. Keep the old prefix for tasks that already have a session. |
| tmux socket `-L wilco`, session `wilco`, options `@wilco-lane` / `@wilco-spec` | `packages/drivers/tmux/src/index.ts` | A window that renames these cannot `list` or `adopt` the lanes the previous one left running — it would report healthy agents as gone. Adopt the old names too, or drain before upgrading. |
| Journal event kinds `wilco_opened`, `wilco_closing` | `packages/core/src/events.ts`, workbench | `events.jsonl` is the truth and is append-only; old kinds must stay readable, so add new names rather than rewriting history. |
| Tool names `wilco_*` | 36 distinct (`wilco_status`, `wilco_plan`, `wilco_task_create`, `wilco_run_start`, `wilco_done`, …) | These are the model's vocabulary. `wilco_done` in particular is what every agent is told to call; a rename mid-flight leaves running agents calling a tool that no longer exists. Rename with the prompts, in one release. |
| Telemetry | `telemetry/shape.ts` (`KEPT` allow-list), Sentry project/environment naming, README's `projects: { wilco: … }` example | The allow-list is names-only by design; renaming keys changes what is sendable. |

**Suggested order.** Secure the name (npm scope + package, GitHub org, domains) → rename the
outward-facing surface with the old binary kept as an alias for one release → rename the `@scope`
and env vars, accepting both → leave the on-disk and protocol names (`~/.wilco`, `.wilco/`,
`wilco/` branches, `wilco-` sessions, tmux names, event kinds) behind compatibility readers, and
delete those readers only once no machine has an old home on it.

---

*Nothing was renamed in the process of writing this. The only file added is this one.*
