import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { ALERT_COOLDOWN_MS, decideAgentAlert, notifyConsentPatch, type AgentAlertInput } from './agentAlert'

// A realistic clock: production passes Date.now(), so a fixture "now" near zero would hide a
// cooldown that treats a missing stamp as "chimed at 0".
const NOW = 1_760_000_000_000

const ON = {
  soundEffects: true,
  notifyOnClaudeDone: true,
  notifyOnNeedsYou: true,
  notifyConsentAsked: true,
  notifyWhileFocused: false
}

// The shipped defaults, consent given: what an existing user who said yes has.
const DEFAULT_OFF = {
  soundEffects: DEFAULT_SETTINGS.soundEffects,
  notifyOnClaudeDone: DEFAULT_SETTINGS.notifyOnClaudeDone,
  notifyOnNeedsYou: DEFAULT_SETTINGS.notifyOnNeedsYou,
  notifyConsentAsked: true,
  notifyWhileFocused: DEFAULT_SETTINGS.notifyWhileFocused
}

const input = (over: Partial<AgentAlertInput> = {}): AgentAlertInput => ({
  kind: 'done',
  windowFocused: false,
  activeNode: false,
  prefs: ON,
  now: NOW,
  ...over
})

describe('decideAgentAlert — the unread record', () => {
  it('a node you are watching (focused window + its terminal) is not marked unread', () => {
    const d = decideAgentAlert(input({ windowFocused: true, activeNode: true }))
    expect(d.markUnread).toBe(false)
  })

  it('is marked unread while you are in ANOTHER terminal of a focused window', () => {
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: false })).markUnread).toBe(true)
  })

  it('is marked unread when the window is in the background, even if it was the active terminal', () => {
    expect(decideAgentAlert(input({ windowFocused: false, activeNode: true })).markUnread).toBe(true)
  })

  it('acks a finish the user watched, and only a finish', () => {
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: true })).ackDone).toBe(true)
    expect(
      decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, activeNode: true })).ackDone
    ).toBe(false)
    // Not watched ⇒ it is marked unread instead; the ack comes when the user looks.
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: false })).ackDone).toBe(false)
  })
})

describe('decideAgentAlert — quiet (issue #708) and the handoff fold', () => {
  it('quiet silences the chime and the notification but keeps the unread record', () => {
    const d = decideAgentAlert(input({ quiet: true }))
    expect(d).toEqual({ markUnread: true, ackDone: false, sound: false, notify: false, force: false })
  })

  it('quiet keeps the ack of a watched finish', () => {
    const d = decideAgentAlert(input({ quiet: true, windowFocused: true, activeNode: true }))
    expect(d.ackDone).toBe(true)
    expect(d.sound).toBe(false)
  })

  it('a done folded into a handoff ping is silent, and keeps its record', () => {
    const d = decideAgentAlert(input({ handoffFolded: () => true }))
    expect(d).toEqual({ markUnread: true, ackDone: false, sound: false, notify: false, force: false })
  })

  it('never asks the fold for a quiet turn — asking consumes it', () => {
    const fold = vi.fn(() => true)
    decideAgentAlert(input({ quiet: true, handoffFolded: fold }))
    expect(fold).not.toHaveBeenCalled()
  })

  it('never asks the fold for a needs-you alert — the fold is about turn ends only', () => {
    const fold = vi.fn(() => true)
    const d = decideAgentAlert(input({ kind: 'needsYou', handoffFolded: fold }))
    expect(fold).not.toHaveBeenCalled()
    expect(d.sound).toBe(true)
    expect(d.notify).toBe(true)
  })
})

describe('decideAgentAlert — chime', () => {
  it('chimes whether or not the window is focused', () => {
    expect(decideAgentAlert(input({ windowFocused: false })).sound).toBe(true)
    expect(decideAgentAlert(input({ windowFocused: true })).sound).toBe(true)
  })

  it('does not chime with sound effects off', () => {
    expect(decideAgentAlert(input({ prefs: { ...ON, soundEffects: false } })).sound).toBe(false)
  })

  it('keeps a per-node cooldown of its own', () => {
    expect(decideAgentAlert(input({ lastSoundAt: NOW - ALERT_COOLDOWN_MS + 1 })).sound).toBe(false)
    expect(decideAgentAlert(input({ lastSoundAt: NOW - ALERT_COOLDOWN_MS })).sound).toBe(true)
  })
})

describe('decideAgentAlert — OS notification', () => {
  it('notifies a background finish with notifications on and consent given', () => {
    expect(decideAgentAlert(input()).notify).toBe(true)
  })

  it('never notifies while the window is focused (default behaviour)', () => {
    expect(decideAgentAlert(input({ windowFocused: true })).notify).toBe(false)
    expect(decideAgentAlert(input({ kind: 'needsYou', windowFocused: true })).notify).toBe(false)
  })

  it('needs both the preference and the consent answer', () => {
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyOnClaudeDone: false } })).notify).toBe(false)
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyConsentAsked: false } })).notify).toBe(false)
  })

  it('a background notification never carries force — main keeps its own focused-window skip', () => {
    expect(decideAgentAlert(input())).toMatchObject({ notify: true, force: false })
    expect(decideAgentAlert(input({ kind: 'needsYou' }))).toMatchObject({ notify: true, force: false })
    // Even with the opt-in on: force is for the focused case only.
    const optIn = { ...ON, notifyWhileFocused: true }
    expect(decideAgentAlert(input({ kind: 'needsYou', prefs: optIn }))).toMatchObject({ force: false })
  })

  it('keeps a per-node cooldown separate from the chime', () => {
    // The chime cooled down, the notification did not — and the other way round.
    const recentNotify = decideAgentAlert(input({ lastNotifyAt: NOW - 1000, lastSoundAt: NOW - 60_000 }))
    expect(recentNotify).toMatchObject({ notify: false, sound: true })
    const recentSound = decideAgentAlert(input({ lastSoundAt: NOW - 1000, lastNotifyAt: NOW - 60_000 }))
    expect(recentSound).toMatchObject({ notify: true, sound: false })
  })
})

describe('decideAgentAlert — one toggle per kind', () => {
  it('a finish follows notifyOnClaudeDone, not the needs-you toggle', () => {
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyOnNeedsYou: false } })).notify).toBe(true)
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyOnClaudeDone: false } })).notify).toBe(false)
  })

  it('a needs-you follows notifyOnNeedsYou, not the finish toggle', () => {
    const needs = (prefs: typeof ON): boolean => decideAgentAlert(input({ kind: 'needsYou', prefs })).notify
    expect(needs({ ...ON, notifyOnClaudeDone: false })).toBe(true)
    expect(needs({ ...ON, notifyOnNeedsYou: false })).toBe(false)
  })

  it('both kinds stay behind the one consent answer', () => {
    const prefs = { ...ON, notifyConsentAsked: false, notifyWhileFocused: true }
    expect(decideAgentAlert(input({ kind: 'needsYou', prefs })).notify).toBe(false)
    expect(decideAgentAlert(input({ kind: 'needsYou', prefs, windowFocused: true })).notify).toBe(false)
  })

  it('the toggles gate the notification only — the chime and the unread record are unchanged', () => {
    const off = { ...ON, notifyOnClaudeDone: false, notifyOnNeedsYou: false }
    expect(decideAgentAlert(input({ kind: 'needsYou', prefs: off }))).toEqual({
      markUnread: true,
      ackDone: false,
      sound: true,
      notify: false,
      force: false
    })
  })
})

describe('decideAgentAlert — notify while focused (opt-in)', () => {
  const optIn = { ...ON, notifyWhileFocused: true }

  it('is off by default: a needs-you in another terminal of a focused window does not notify', () => {
    expect(DEFAULT_OFF.notifyWhileFocused).toBe(false)
    expect(decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, prefs: DEFAULT_OFF })).notify).toBe(false)
  })

  it('notifies a needs-you in a session you are not watching, with force', () => {
    const d = decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, activeNode: false, prefs: optIn }))
    expect(d).toMatchObject({ notify: true, force: true, markUnread: true })
  })

  it('never notifies the session you are watching — you can see its prompt', () => {
    const d = decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, activeNode: true, prefs: optIn }))
    expect(d).toMatchObject({ notify: false, force: false, markUnread: false })
  })

  it('never applies to a finished turn — the chime covers that', () => {
    const d = decideAgentAlert(input({ kind: 'done', windowFocused: true, activeNode: false, prefs: optIn }))
    expect(d).toMatchObject({ notify: false, force: false, sound: true })
  })

  it('still needs the needs-you toggle, and still keeps the per-node cooldown', () => {
    const base = { kind: 'needsYou' as const, windowFocused: true, activeNode: false }
    expect(decideAgentAlert(input({ ...base, prefs: { ...optIn, notifyOnNeedsYou: false } })).notify).toBe(false)
    expect(decideAgentAlert(input({ ...base, prefs: optIn, lastNotifyAt: NOW - 1000 })).notify).toBe(false)
  })

  it('reads a hand-edited non-boolean as OFF', () => {
    const prefs = { ...ON, notifyWhileFocused: 'yes' as unknown as boolean }
    expect(decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, prefs })).notify).toBe(false)
  })
})

describe('notifyConsentPatch — one answer covers both kinds', () => {
  it('enabling turns on both notification kinds and records the answer', () => {
    expect(notifyConsentPatch(true)).toEqual({
      notifyConsentAsked: true,
      notifyOnClaudeDone: true,
      notifyOnNeedsYou: true
    })
  })

  it('declining turns BOTH off — the needs-you default is on, so leaving it out would keep it on', () => {
    expect(DEFAULT_SETTINGS.notifyOnNeedsYou).toBe(true)
    const after = { ...DEFAULT_SETTINGS, ...notifyConsentPatch(false) }
    expect(after.notifyOnClaudeDone).toBe(false)
    expect(after.notifyOnNeedsYou).toBe(false)
    expect(after.notifyConsentAsked).toBe(true)
  })
})
