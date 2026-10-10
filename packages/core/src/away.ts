import { z } from 'zod'

// The sentences about the away view that have to be said where somebody is
// deciding, and that may never get more comfortable.
//
// **Why they live in the domain and not in `@tade/web`.** Three of them belong
// on a *control*: the one that turns a LAN bind on, and the one that lists the
// devices that have been let in. A control's words are a `Setting`'s `means`
// (`settings.ts`), and `@tade/core` cannot import `@tade/web` — the arrow goes
// the other way and a test holds it. So the choice was a second spelling of
// each sentence beside the control, or one spelling here with `@tade/web`
// re-exporting it. A second spelling is the exact failure these sentences
// exist to prevent: somebody edits the one on the page, the comfortable half
// survives, and the honest half is still true in a file nobody reads.
//
// This is `KEYS_AND_AGENTS`'s treatment (`secrets.ts`) applied to the same
// kind of claim, and said the same way round: **the fact, then the way out, in
// one breath.** A warning with nothing to do about it is one people learn to
// scroll past.
//
// `packages/web/test/separation.test.ts` holds each of them to its words.

/**
 * What is true of a `lan` bind, said on the control that turns one on.
 *
 * It does not say "use HTTPS for security"; it says what anybody on the wifi
 * can read, because the person deciding has to be able to picture it. And the
 * way out is in the same breath.
 */
export const LAN_IS_PLAINTEXT =
  'On your network this is plain HTTP: anybody on the same wifi can read every page it serves ' +
  'and the session cookie with it. `tailscale serve localhost:7654` gives a phone HTTPS while ' +
  'Tade keeps listening on this machine alone, which is a smaller surface than this one.'

/**
 * Why a cookie prefix is not the answer to a port, said where somebody would
 * otherwise believe it is.
 *
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`, and gives real
 * guarantees about all three. It gives **nothing** about ports: RFC 6265 §8.5
 * is unchanged by it. So the honest mitigations are named instead, and this
 * sentence exists because "the prefix fixes it" is what a reader of the
 * attribute list would conclude.
 */
export const COOKIES_IGNORE_PORTS =
  'Cookies are not isolated by port, and no cookie prefix changes that: anything else listening ' +
  'on this address can be sent this session cookie, and can overwrite it. What stands against ' +
  'that is the session being bound to the exact host it was paired for, and TLS, which removes ' +
  'the plaintext the other thing would be reading.'

/**
 * What `HttpOnly` does and what it does not, said once because the short
 * version of it is wrong.
 *
 * It stops a script *reading* the cookie. It does not stop injected script
 * calling `fetch` from the page's own origin with the page's own token — so it
 * is not a defence against cross-site scripting, only against the theft of a
 * credential. What is a defence is the page never building markup: no
 * `innerHTML`, no Markdown, a content policy with nothing inline.
 */
export const HTTPONLY_IS_NOT_XSS =
  'HttpOnly keeps a script from reading this session cookie. It does not keep one from using it: ' +
  'script that got onto the page can call Tade with the page’s own credentials. What stands ' +
  'against that is that the page builds no markup at all.'

/**
 * What is true of every paired device, said wherever one is granted or listed.
 *
 * The same treatment `KEYS_AND_AGENTS` gets, for the same reason: the fact,
 * then the way out, in one breath. Nothing in the file can answer it, so it is
 * said instead.
 */
export const DEVICES_AND_AGENTS =
  'Paired devices and the digests of their credentials live in `web-devices.jsonl`, `0600` — ' +
  'which keeps them from other people, and an agent is not another person. An agent on this ' +
  'machine runs as you with nothing containing it, so it can append a line to that file and pair ' +
  'itself. What stands against that: the device list here shows every device there is, every act ' +
  'one takes is in the journal under its id, and “Disconnect everything” needs no network.'

/** The short clause, for the one line a control gets. */
export const DEVICES_SEEN_BY_AGENTS = 'an agent on this machine could pair itself'

/**
 * What the away view is, said where somebody is turning it on.
 *
 * The two facts a person needs before the switch and not after it: that it
 * dies with the window, so a bookmark tapped with Tade closed is a connection
 * error and not an empty control room; and that it can change nothing, which
 * is what makes turning it on a small decision.
 */
export const AWAY_IS_WHILE_OPEN =
  'The away view answers only while this window is open: close Tade and nothing is listening, ' +
  'which is also why closing Tade is harmless.'

/**
 * What a paired device may and may not do, said where acting is turned on.
 *
 * The same shape as the sentences above: the fact, then what stands against
 * it, in one breath. Three facts, and the middle one is the one a person
 * deciding has to be able to picture — a request from a phone runs in the same
 * conversation as the things they said at the keyboard, and the only thing
 * keeping last week's *turn the checks off* from authorising it is that the
 * refusal is in code rather than in a prompt.
 */
export const ACTING_IS_NOT_YOU =
  'A request from a paired device is never your own words. On work you already set up it can ' +
  'answer what an agent is waiting on, tell one something, hold or release queued work, add a ' +
  'note or a line to what a task is told, mark work finished, and approve a request a grant ' +
  'here already allowed. It can never change a setting, read a credential, run a command, ' +
  'start an agent, push, merge or overrule a check. Acting needs this machine itself or an https ' +
  'origin you named in Trusted hostnames, so a credential that crossed a network in the clear ' +
  'never buys one — and every act is in the journal under the device that took it.'

/** The short clause, for the one line a control gets. */
export const ACTING_IS_NOT_YOU_SHORT = 'a device acts as a request, never as your own words'

/**
 * The away view's own config block: `surfaces.web`.
 *
 * Here rather than in `config.ts` for the reason the sentences above are here:
 * every one of these keys is a decision about who can reach the control room
 * and what they may do with it, and the words that have to be said about each
 * are three lines away instead of in another file. `config.ts` composes it the
 * way it composes `IntakeSurface`, and `surfaceOf` (`@tade/web`'s
 * `surface.ts`) is still the one reader.
 *
 * **Off, and the default is the decision.** `enabled` is a listener on this
 * machine; `bind` is whether that listener is on your network; `acting` is
 * whether a paired device may change anything at all; `orchestrator` is
 * whether one may say something to the model that holds the tools. Four
 * decisions, never one, because conflating the first two is how a laptop in a
 * cafe serves its control room to the cafe, conflating the third with either
 * is how reading from the sofa turns into acting from anywhere, and the fourth
 * is a different kind of thing again — eight bounded verbs against free text.
 * All of them are `never` in `reach.ts` by subtree: each changes who can reach
 * Tade, or what they can do.
 */
export const WebSurface = z
  .strictObject({
    /** Serve it at all. Nothing listens while this is false. */
    enabled: z.boolean().default(false),
    /**
     * `loopback` is this machine alone, and is a secure context, so
     * every browser capability works. `lan` is every interface, in the
     * clear, and is a **read-only transport**: a session minted over
     * plain HTTP off this machine can never act, whatever is turned on
     * later (`scopesOn`).
     */
    bind: z.enum(['loopback', 'lan']).default('loopback'),
    /**
     * Unassigned in IANA's registry, which is the whole of why it is
     * this number. Already in use is a **named warning** and nothing
     * listens — never a quiet bind elsewhere, which is a URL in
     * somebody's hand that goes nowhere.
     */
    port: z.int().min(1).max(65535).default(7654),
    /**
     * Names beyond this machine's own addresses that may reach it: a
     * tailnet, a tunnel. An `https` one of these is also the only
     * origin off this machine a device may ever *act* from, which is
     * what makes a trusted path a prerequisite rather than a nicety.
     */
    trusted_hosts: z.array(z.string().min(1)).default([]),
    /**
     * Whether a paired device may change anything at all.
     *
     * **A third decision, and `false` is the whole of Phase 1's guarantee.**
     * With this off there is no acting route in the table at all
     * (`routesFor`), so a crafted call is the same `404` as a path nobody
     * built — read-only is enforced by absence rather than by a flag a bug
     * could get past. It is not enough on its own either: a device still
     * needs the scope a person granted it at the machine, and the request
     * still needs a trusted origin. `ACTING_IS_NOT_YOU` is the sentence that
     * goes with it, and what acting can never reach is in it rather than left
     * to be inferred.
     *
     * Turning it **on** takes effect the next time Tade starts, because the
     * route table is built with the listener. Turning it **off** is read at
     * every act, which is the asymmetry worth having: the direction that
     * takes away authority is immediate.
     */
    acting: z.boolean().default(false),
    /**
     * Whether a paired device may talk to the orchestrator.
     *
     * **A fourth decision, and the one that is categorically different from
     * the other three.** `acting`'s verbs are bounded: each names a target and
     * the state it expects, each is enumerable, and the worst a crafted one
     * can do is the thing it says on it. This hands **free text to a model
     * that holds tools**, which is the difference between answering a question
     * and being able to ask for anything — so it is its own setting, its own
     * event type and its own provenance, and it must never share a switch with
     * `acting` (DESIGN.md Phase 3).
     *
     * What makes it safe is not the sentence Tade prepends to the turn. It is
     * that while a remote turn is in flight the orchestrator's own tools are
     * narrowed to a closed list — `@tade/orchestrator`'s `origin.ts` — and
     * everything unnamed is refused at the two gates the model calls through,
     * so an old `said` line of the person's and an `open`-tier setting are both
     * out of reach however the request is worded. A harness that cannot be
     * narrowed that way serves no remote turn at all and says so, rather than
     * running one unrestricted.
     *
     * Turning it **on** takes effect the next time Tade starts, for the reason
     * `acting` does: the route table is built with the listener. Turning it
     * **off** is read at every turn, so the direction that takes authority
     * away is immediate.
     */
    orchestrator: z.boolean().default(false),
  })
  .prefault({})
