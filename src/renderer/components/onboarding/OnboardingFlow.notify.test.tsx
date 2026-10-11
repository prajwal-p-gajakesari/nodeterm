// @vitest-environment jsdom
//
// The setup tour's notifications step is one of the places that asks the one-time consent
// question. Its answer must cover BOTH notification kinds: the needs-you toggle ships ON, so a step
// that only wrote the finish toggle would leave a user who said "no" with needs-you banners.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notify = vi.fn(async (_p: unknown) => 'shown' as const)

let OnboardingFlow: typeof import('./OnboardingFlow').OnboardingFlow
let useSettings: typeof import('../../state/settings').useSettings

beforeAll(async () => {
  // A scene draws on a <canvas>; jsdom has no 2D context and would log "Not implemented" per frame.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    notify,
    speech: { models: vi.fn(async () => []), onProgress: vi.fn(() => () => {}), downloadModel: vi.fn() },
    shell: { openExternal: vi.fn() },
    license: { onChange: vi.fn(() => () => {}) }
  }
  ;({ OnboardingFlow } = await import('./OnboardingFlow'))
  ;({ useSettings } = await import('../../state/settings'))
})

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  notify.mockClear()
  // A fresh install: nothing answered yet, both kinds at their shipped default (on).
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<OnboardingFlow onClose={() => {}} />))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
const click = (el: Element): Promise<void> =>
  act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

async function toNotifyStep(): Promise<HTMLButtonElement> {
  await click(button('Set up in a minute →')!)
  for (let i = 0; i < 10 && !button('Enable notifications'); i++) await click(button('Next')!)
  const enable = button('Enable notifications')
  expect(enable, 'the tour must reach its notifications step').toBeTruthy()
  return enable!
}

describe('setup tour — notifications step', () => {
  it('Enable turns on both kinds and records the answer', async () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, notifyOnClaudeDone: false, notifyOnNeedsYou: false }
    })
    await click(await toNotifyStep())
    expect(useSettings.getState().settings).toMatchObject({
      notifyConsentAsked: true,
      notifyOnClaudeDone: true,
      notifyOnNeedsYou: true
    })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })
})
