// @vitest-environment jsdom
//
// "Share ~/.claude setup" in Settings → Accounts. Pinned here, because none of it is visible from
// core: the filesystem is reconciled BEFORE the flag is persisted (the launch sweep replays the
// flag), a refusal stores nothing, a remote account shows the switch disabled with the reason, and
// — the reason the panel reads status on open — a shared file that was since replaced, or a
// ~/.claude/settings.json that now replaces the account's login, is said ON THE ROW, outside the
// folded options, while the switch still reads "on".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import {
  DEFAULT_SETTINGS,
  type ClaudeAccount,
  type ClaudeSetupItemName,
  type ClaudeSetupShareItem,
  type ClaudeSetupShareResult
} from '@shared/types'

const local: ClaudeAccount = { id: 'a1', label: 'work', createdAt: 0 }
const remote: ClaudeAccount = { id: 'a2', label: 'server', host: 'u@h', createdAt: 0 }
const NAMES: ClaudeSetupItemName[] = ['settings.json', 'plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles']

function report(
  items: Partial<Record<ClaudeSetupItemName, Partial<ClaudeSetupShareItem>>> = {},
  over: Partial<ClaudeSetupShareResult> = {}
): ClaudeSetupShareResult {
  return {
    items: NAMES.map((name) => ({ name, state: 'none', setAside: false, ...items[name] })),
    identityKeys: [],
    configDir: '/u/claude-accounts/a1',
    setAsideDir: '/u/claude-accounts/a1/.nodeterm-set-aside',
    ...over
  }
}
const allShared = report({
  'settings.json': { state: 'shared', setAside: true },
  plugins: { state: 'shared' },
  'CLAUDE.md': { state: 'shared' },
  agents: { state: 'shared' }
})

let setSetupSharing = vi.fn(async (_id: string, _on: boolean) => allShared)
let setupSharingStatus = vi.fn(async (_id: string) => report())

function install(): void {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: { setSkillSharing: vi.fn(), setSetupSharing, setupSharingStatus },
    settings: { save: async () => {} }
  }
}

async function renderSection(accounts: ClaudeAccount[]): Promise<{ host: HTMLElement; root: Root }> {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const switchFor = (host: HTMLElement, label: string): HTMLButtonElement => {
  const el = host.querySelector(`[aria-label="Share ~/.claude setup with ${label}"]`)
  expect(el, `no setup switch for ${label}`).toBeTruthy()
  return el as HTMLButtonElement
}
const flagOf = (id: string): boolean | undefined =>
  useSettings.getState().settings.claudeAccounts.find((a) => a.id === id)?.shareSystemSetup
/** The row's visible text with the folded options taken out — what a user sees without expanding. */
const unfoldedText = (host: HTMLElement): string => {
  const clone = host.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details').forEach((d) => d.remove())
  return clone.textContent ?? ''
}

beforeEach(() => {
  document.body.innerHTML = ''
  setSetupSharing = vi.fn(async (_id: string, _on: boolean) => allShared)
  setupSharingStatus = vi.fn(async (_id: string) => report())
  install()
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — share ~/.claude setup', () => {
  it('reconciles the filesystem, then persists the flag, and shows what is shared', async () => {
    const { host, root } = await renderSection([local])
    expect(flagOf('a1')).toBeUndefined()
    await act(async () => {
      switchFor(host, 'work').click()
    })
    expect(setSetupSharing).toHaveBeenCalledWith('a1', true)
    expect(flagOf('a1')).toBe(true)
    expect(host.textContent).toContain('Sharing settings.json, plugins, CLAUDE.md and agents.')
    expect(host.textContent).toContain('own settings.json is set aside')
    act(() => root.unmount())
  })

  it('does NOT persist the flag when the reconcile refused, and says why', async () => {
    setSetupSharing = vi.fn(async () => report({}, { refused: 'set-aside-unavailable' }))
    install()
    const { host, root } = await renderSection([local])
    await act(async () => {
      switchFor(host, 'work').click()
    })
    expect(flagOf('a1')).toBeUndefined()
    expect(unfoldedText(host)).toContain('.nodeterm-set-aside is not a folder')
    act(() => root.unmount())
  })

  it('reads status on open and puts a diverged file on the row, outside the folded options', async () => {
    setupSharingStatus = vi.fn(async () =>
      report({ 'settings.json': { state: 'diverged', setAside: true }, agents: { state: 'shared' } })
    )
    install()
    const { host, root } = await renderSection([{ ...local, shareSystemSetup: true }])
    expect(setupSharingStatus).toHaveBeenCalledWith('a1')
    expect(switchFor(host, 'work').getAttribute('aria-checked')).toBe('true')
    expect(unfoldedText(host)).toContain('settings.json is no longer shared')
    expect(unfoldedText(host)).toContain('/u/claude-accounts/a1')
    act(() => root.unmount())
  })

  it('warns on the row when ~/.claude/settings.json now replaces the account’s login', async () => {
    setupSharingStatus = vi.fn(async () =>
      report({ 'settings.json': { state: 'shared' } }, { identityKeys: ['apiKeyHelper'] })
    )
    install()
    const { host, root } = await renderSection([{ ...local, shareSystemSetup: true }])
    expect(unfoldedText(host)).toContain('now sets apiKeyHelper, which would replace or redirect this account’s own login')
    expect(unfoldedText(host)).toContain('nodeterm unlinks settings.json and plugins at its next launch')
    act(() => root.unmount())
  })

  it('a withdrawal the launch sweep made is on the row, outside the folded options', async () => {
    setupSharingStatus = vi.fn(async () =>
      report({ 'settings.json': { state: 'own' } }, { identityKeys: ['apiKeyHelper'], withdrawnAtLaunch: true })
    )
    install()
    const { host, root } = await renderSection([{ ...local, shareSystemSetup: true }])
    expect(unfoldedText(host)).toContain('settings.json and plugins were unlinked at launch')
    act(() => root.unmount())
  })

  it('a status read that FAILED is said, never shown as "nothing to share"', async () => {
    setupSharingStatus = vi.fn(async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    install()
    const { host, root } = await renderSection([{ ...local, shareSystemSetup: true }])
    expect(unfoldedText(host)).toContain('Setup sharing could not be checked (EACCES).')
    expect(host.textContent).not.toContain('Nothing in ~/.claude to share yet.')
    act(() => root.unmount())
  })

  it('shows a remote account the switch DISABLED with the reason, and never asks core about it', async () => {
    const { host, root } = await renderSection([remote])
    expect(switchFor(host, 'server').disabled).toBe(true)
    expect(host.textContent).toContain('their setup lives on that machine')
    expect(setupSharingStatus).not.toHaveBeenCalled()
    act(() => root.unmount())
  })
})
