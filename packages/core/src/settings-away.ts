import {
  ACTING_IS_NOT_YOU,
  AWAY_IS_WHILE_OPEN,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT,
} from './away.ts'
import type { Config } from './config.ts'
import type { SettingGroup } from './settings.ts'

// The away view's five controls, as a person changes them.
//
// Its own half of `settingsOf`, split off for the reason the projects half
// was: that file reached the size a file is allowed to be. It is a seam rather
// than a cut — these five are exactly the keys `reach.ts` refuses to the
// orchestrator by subtree, and exactly the ones whose `means` carries a
// sentence the domain says once (`away.ts`) so that no control can say the
// comfortable half of it.
//
// **All five are `live: false`, honestly.** The listener comes up when the
// window starts, and the epoch a connected phone holds is per server start —
// so turning one on mid-session would have to tear down and rebuild something
// somebody is looking at. Saying *takes effect on restart* is the honest
// answer; doing nothing and saying nothing is the setting Tade accepts and
// ignores.

export function awayGroup(config: Config): SettingGroup {
  const web = config.surfaces.web
  return {
    id: 'away',
    title: 'Away view',
    about: `One page, served from this machine, to a phone you paired by scanning a code in the window. It shows what is working, what is queued, what is stopped and what it cost, and until you turn Acting on it can change nothing. ${AWAY_IS_WHILE_OPEN} Off by default, and ${DEVICES_SEEN_BY_AGENTS}, which is why the device list shows every device there is.`,
    keywords: [
      'away',
      'web',
      'phone',
      'mobile',
      'browser',
      'remote',
      'page',
      'server',
      'listen',
      'port',
      'pair',
      'pairing',
      'qr',
      'device',
      'devices',
      'lan',
      'tailscale',
      'proxy',
      'https',
      'act',
      'acting',
    ],
    settings: [
      {
        path: 'surfaces.web.enabled',
        title: 'Serve the away view',
        means:
          'on: a listener while the window is open, for devices you pair at the machine; off: nothing is listening at all',
        value: String(web.enabled),
        fallback: 'false',
        type: { kind: 'flag' },
        // Honestly `false`: the listener comes up when the window starts and
        // the epoch a connected phone holds is per server start, so turning
        // this on mid-session would have to tear down and rebuild something
        // a person is looking at. Said rather than half-done.
        live: false,
      },
      {
        path: 'surfaces.web.bind',
        // Deliberately a *second* decision from `enabled`, which is why it is
        // a second row rather than a third option on the first one: "on" and
        // "on the network" being one control is how a laptop in a café ends
        // up serving its control room to the café.
        title: 'Who can reach it',
        means: `loopback: this machine alone, which is what a tunnel or tailscale serve connects to; lan: every interface, in the clear. ${LAN_IS_PLAINTEXT}`,
        value: web.bind,
        fallback: 'loopback',
        type: { kind: 'choice', options: ['loopback', 'lan'] },
        live: false,
        keywords: ['network', 'wifi', 'plaintext', 'interface', 'expose'],
      },
      {
        path: 'surfaces.web.port',
        title: 'Port',
        means:
          'the port it listens on, and the one the pairing code carries. Already in use is said and nothing listens — never a quiet bind somewhere else',
        value: String(web.port),
        fallback: '7654',
        type: { kind: 'number' },
        live: false,
      },
      {
        path: 'surfaces.web.acting',
        // A **third** decision, and a row of its own for the same reason
        // `bind` is one: reading from the sofa and changing work from anywhere
        // are different things to want, and a control that granted both at
        // once would be a yes to a question nobody was asked. Still not
        // enough on its own — a device needs the scope you grant it in the
        // away panel, and the request needs this machine or an https host you
        // named — which is why the sentence says what acting can never reach
        // rather than leaving it to be inferred.
        title: 'Let a paired device act',
        means: `on: a device you have granted it can answer an approval, steer an agent and park or pick up work; off: there is no route to do any of it. ${ACTING_IS_NOT_YOU}`,
        value: String(web.acting),
        fallback: 'false',
        type: { kind: 'flag' },
        // `false` like the rest, and honestly asymmetric: turning it **on**
        // needs a restart because the route table is built with the listener,
        // and turning it **off** is read at every act, so the direction that
        // takes authority away is immediate. Said that way round rather than
        // claimed to be live.
        live: false,
        keywords: ['act', 'acting', 'approve', 'steer', 'park', 'change', 'answer', 'verb'],
      },
      {
        path: 'surfaces.web.trusted_hosts',
        title: 'Trusted hostnames',
        means:
          'names beyond this machine’s own addresses that may reach it — a tailnet name, a tunnel. This is also the only way an https origin off this machine is trusted, because no forwarded header is ever read: a proxy is trusted by being named here, never by what it writes in a header',
        value: web.trusted_hosts.join(' '),
        fallback: 'none',
        type: { kind: 'text', placeholder: 'studio.yak-bebop.ts.net' },
        live: false,
        keywords: ['tailscale', 'tailnet', 'tunnel', 'cloudflare', 'reverse proxy', 'origin'],
      },
    ],
  }
}
