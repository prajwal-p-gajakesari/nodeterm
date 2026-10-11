/**
 * What one agent turn-end / needs-you event does to the user: the unread record, the read ack, the
 * chime and the OS notification.
 *
 * Canvas's agent-status listener used to decide all four inline, in a closure inside a `useEffect`
 * no harness can dispatch at, so the only tests it could have were source pins. The decision is
 * lifted here so it can be pressed like any other function; the listener only gathers the facts
 * (window focus, which terminal is active, the cooldown stamps) and applies the answer.
 *
 * ## The two halves, and the line between them
 *
 * The unread dot and its ack are a RECORD: "something happened here while you were not looking".
 * The chime and the OS notification are INTERRUPTS. Issue #708's quiet rule (`fanoutStillWorking`)
 * and the handoff fold (`lib/handoffPings`) silence interrupts only — a dot is a different fact
 * from a chime, and suppressing the record to fix a noisy interrupt would trade a noisy bug for a
 * silent one. `decideAgentAlert` keeps that line: neither `quiet` nor the fold can reach
 * `markUnread` / `ackDone`.
 *
 * ## "Watching"
 *
 * A node is being WATCHED when the window has focus AND it is the terminal the user is in
 * (`agentStatus.activeId`). That is the unread rule's own definition, and nothing else here gets a
 * second one: a finish while you are in another terminal, or with the window in the background,
 * still flags unread.
 */

/** What happened: a turn finished (`done`), or the agent needs you (`waiting` / `blocked` — a
 *  question or an approval; the two alert identically). Same vocabulary as the chime (`SfxKind`). */
export type AgentAlertKind = 'done' | 'needsYou'

/** Per-node floor between two chimes, and between two OS notifications (separate clocks). */
export const ALERT_COOLDOWN_MS = 5000

/** The settings this decision reads — a structural slice of `Settings`. */
export interface AgentAlertPrefs {
  soundEffects: boolean
  notifyOnClaudeDone: boolean
  notifyConsentAsked: boolean
}

export interface AgentAlertInput {
  kind: AgentAlertKind
  /** `document.hasFocus()` when the event lands. */
  windowFocused: boolean
  /** This node is the terminal the user is in (`agentStatus.activeId === nodeId`). */
  activeNode: boolean
  /** Issue #708: the parent still holds working subagent cards. Silences the interrupts only. */
  quiet?: boolean
  /**
   * Did a handoff ping just announce this turn end (`suppressDoneAfterHandoff`)? A CALLBACK, not a
   * boolean, because asking CONSUMES the fold: it is asked only for a `done` that would otherwise
   * interrupt — a quiet fan-out turn must leave the fold for the turn end it was armed for.
   */
  handoffFolded?: () => boolean
  prefs: AgentAlertPrefs
  now: number
  /** When this node last chimed / last raised an OS notification (absent = never). */
  lastSoundAt?: number
  lastNotifyAt?: number
}

export interface AgentAlertDecision {
  /** Flag the node unread (it finished or needs you while you were not watching it). */
  markUnread: boolean
  /** Ack a finish the user watched happen, so the notch / phone stop glowing for it. */
  ackDone: boolean
  /** Play the chime for this kind. The caller stamps the sound cooldown when it does. */
  sound: boolean
  /** Raise an OS notification. The caller stamps the notification cooldown when it does. */
  notify: boolean
}

export function decideAgentAlert(i: AgentAlertInput): AgentAlertDecision {
  const watching = i.windowFocused && i.activeNode
  // Watched it finish? Then it is already read. Nothing marks it unread in this branch, so without
  // an explicit ack there would never BE a read signal — and the notch capsule's green blob and the
  // phone's Live Activity would keep glowing for a turn the user sat and watched end.
  const record = { markUnread: !watching, ackDone: watching && i.kind === 'done' }
  const silent: AgentAlertDecision = { ...record, sound: false, notify: false }
  // Everything below is an INTERRUPT, and this is where a quiet alert stops.
  if (i.quiet) return silent
  // An agent that just filed its card into a handoff column was already announced to the assignee;
  // its turn end seconds later is the same moment. Asked only here, for the reason on the field.
  if (i.kind === 'done' && i.handoffFolded?.()) return silent
  // Sound fires whether or not the window is focused: it is the one alert that catches a finish
  // while you are in the app but looking at another node.
  const sound = !!i.prefs.soundEffects && cooledDown(i.now, i.lastSoundAt)
  // OS notification only when the whole window is in the background, with consent.
  const notify =
    !i.windowFocused &&
    !!i.prefs.notifyOnClaudeDone &&
    !!i.prefs.notifyConsentAsked &&
    cooledDown(i.now, i.lastNotifyAt)
  return { ...record, sound, notify }
}

function cooledDown(now: number, last: number | undefined): boolean {
  return last === undefined || now - last >= ALERT_COOLDOWN_MS
}
