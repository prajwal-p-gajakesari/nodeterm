// @vitest-environment jsdom
//
// Settings → Notifications: the finish and needs-you notifications are separate switches over one
// consent answer, the focused-window opt-in is a sub-gate of needs-you, and every switch writes
// the key it names and nothing else. Rendered with a real, populated settings state (CONTRIBUTING:
// every section renders on each Settings open, visible or not).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

vi.mock('@renderer/lib/sfx', () => ({ playSfx: vi.fn(), checkCustomSfx: vi.fn(async () => true) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notify = vi.fn(async (_p: unknown): Promise<'shown' | 'failed' | 'skipped'> => 'shown')
const openNotificationSettings = vi.fn(async () => {})

let NotificationsSection: typeof import('./NotificationsSection').NotificationsSection
let useSettings: typeof import('../../../state/settings').useSettings

beforeAll(async () => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    notify,
    openNotificationSettings,
    files: { saveAlertSound: vi.fn(), clearAlertSound: vi.fn() }
  }
  ;({ NotificationsSection } = await import('./NotificationsSection'))
  ;({ useSettings } = await import('../../../state/settings'))
})

/** An existing user who said yes to notifications, everything else as shipped. */
const CONSENTED: Settings = { ...DEFAULT_SETTINGS, notifyConsentAsked: true }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  notify.mockReset().mockImplementation(async () => 'shown')
  useSettings.setState({ settings: CONSENTED, hydrated: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const render = (patch: Partial<Settings> = {}): Promise<void> => {
  useSettings.setState({ settings: { ...CONSENTED, ...patch } })
  return act(async () => root.render(<NotificationsSection isActive />))
}
const sw = (label: string): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)
  expect(el, `a "${label}" switch must be in the Notifications section`).toBeTruthy()
  return el!
}
const click = (el: Element): Promise<void> =>
  act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const settings = (): Settings => useSettings.getState().settings

const DONE = 'Notify when a turn finishes'
const NEEDS = 'Notify when an agent needs you'
const FOCUSED = 'Notify about agents that need you while nodeterm is in front'

describe('NotificationsSection — finish and needs-you are separate switches', () => {
  it('shows each switch with its own key, so an upgrade that seeded them differently reads right', async () => {
    await render({ notifyOnClaudeDone: true, notifyOnNeedsYou: false })
    expect(sw(DONE).getAttribute('aria-checked')).toBe('true')
    expect(sw(NEEDS).getAttribute('aria-checked')).toBe('false')
    await render({ notifyOnClaudeDone: false, notifyOnNeedsYou: true })
    expect(sw(DONE).getAttribute('aria-checked')).toBe('false')
    expect(sw(NEEDS).getAttribute('aria-checked')).toBe('true')
  })

  it('turning needs-you on writes only that key, records consent and fires a forced test', async () => {
    await render({ notifyConsentAsked: false, notifyOnClaudeDone: false, notifyOnNeedsYou: false })
    await click(sw(NEEDS))
    expect(settings()).toMatchObject({
      notifyOnNeedsYou: true,
      notifyConsentAsked: true,
      notifyOnClaudeDone: false
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ force: true, nodeId: '' })
  })

  it('turning the finish notification off leaves needs-you alone', async () => {
    await render({ notifyOnClaudeDone: true, notifyOnNeedsYou: true })
    await click(sw(DONE))
    expect(settings()).toMatchObject({ notifyOnClaudeDone: false, notifyOnNeedsYou: true })
    expect(notify).not.toHaveBeenCalled()
  })

  it('a refused test notification shows the repair path under the switch that fired it', async () => {
    notify.mockImplementation(async () => 'failed')
    await render({ notifyOnNeedsYou: false })
    await click(sw(NEEDS))
    const notes = [...host.querySelectorAll('div')].filter(
      (d) => d.textContent?.startsWith('macOS is blocking notifications') && d.querySelector('button')
    )
    expect(notes).toHaveLength(1)
    // It sits in the needs-you row: after its switch, not after the finish switch's row.
    expect(sw(NEEDS).compareDocumentPosition(notes[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sw(DONE).compareDocumentPosition(notes[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await click(notes[0].querySelector('button')!)
    expect(openNotificationSettings).toHaveBeenCalled()
  })
})

describe('NotificationsSection — notify while nodeterm is in front', () => {
  it('ships off', async () => {
    await render()
    expect(sw(FOCUSED).getAttribute('aria-checked')).toBe('false')
  })

  it('writes the opt-in', async () => {
    await render()
    await click(sw(FOCUSED))
    expect(settings().notifyWhileFocused).toBe(true)
    await click(sw(FOCUSED))
    expect(settings().notifyWhileFocused).toBe(false)
  })

  it('is a sub-gate of needs-you: dimmed and inert while needs-you is off', async () => {
    await render({ notifyOnNeedsYou: false })
    const group = sw(FOCUSED).closest('[aria-disabled]')
    expect(group?.getAttribute('aria-disabled')).toBe('true')
    await render({ notifyOnNeedsYou: true })
    expect(sw(FOCUSED).closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false')
  })
})
