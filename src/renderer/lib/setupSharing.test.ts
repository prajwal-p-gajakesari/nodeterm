import { describe, expect, it } from 'vitest'
import { setupShareView } from './setupSharing'
import type {
  ClaudeSetupItemName,
  ClaudeSetupShareItem,
  ClaudeSetupShareResult
} from '@shared/types'

const NAMES: ClaudeSetupItemName[] = ['settings.json', 'plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles']

function res(
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
const allShared = (): Partial<Record<ClaudeSetupItemName, Partial<ClaudeSetupShareItem>>> =>
  Object.fromEntries(NAMES.map((n) => [n, { state: 'shared' as const }]))

describe('setupShareView — ON', () => {
  it('lists what is shared and says the account’s own copy comes back', () => {
    const v = setupShareView(
      res({ ...allShared(), 'settings.json': { state: 'shared', setAside: true } }),
      true
    )
    expect(v.summary).toBe(
      'Sharing settings.json, plugins, CLAUDE.md, agents, commands and output-styles. This account’s own settings.json is set aside and comes back when you turn this off.'
    )
    expect(v.warnings).toEqual([])
  })

  it('distinguishes "nothing to share" from a hand-made link that already does it', () => {
    expect(setupShareView(res(), true).summary).toBe('Nothing in ~/.claude to share yet.')
    expect(setupShareView(res({ 'settings.json': { state: 'shared-by-you' } }), true).summary).toBe(
      'settings.json already points at ~/.claude on its own.'
    )
  })

  it('names the login-replacing keys when settings.json is withheld for them — never their values', () => {
    const v = setupShareView(
      res({ agents: { state: 'shared' }, 'settings.json': { state: 'own', skipped: 'withheld-identity' } }, {
        identityKeys: ['apiKeyHelper', 'env.ANTHROPIC_API_KEY']
      }),
      true
    )
    expect(v.warnings).toEqual([
      'settings.json and plugins are not shared: ~/.claude/settings.json sets apiKeyHelper and env.ANTHROPIC_API_KEY, which would replace or redirect this account’s own login.'
    ])
  })

  it('says loudly when a key appeared after settings.json was already shared', () => {
    const v = setupShareView(res(allShared(), { identityKeys: ['apiKeyHelper'] }), true)
    expect(v.warnings[0]).toContain('now sets apiKeyHelper, which can replace or redirect this account’s own login')
    expect(v.warnings[0]).toContain('Turn this off')
  })

  it('an unreadable ~/.claude/settings.json is said, not read as "nothing to share"', () => {
    const v = setupShareView(res({}, { settingsUnreadable: true }), true)
    expect(v.warnings).toEqual([
      'settings.json and plugins are not shared: ~/.claude/settings.json could not be read as JSON.'
    ])
  })

  it('a diverged file names where it is and the remedy that was tested', () => {
    const v = setupShareView(res({ 'settings.json': { state: 'diverged', setAside: true } }), true)
    expect(v.warnings).toEqual([
      'settings.json is no longer shared — it was replaced by a regular file in /u/claude-accounts/a1. Copy any change you want to keep into ~/.claude, delete it there, then turn this off and on again.'
    ])
  })

  it('a refused Windows file link names Developer Mode; a folder failure names its code', () => {
    const v = setupShareView(
      res({ 'CLAUDE.md': { state: 'none', error: 'EPERM' }, agents: { state: 'none', error: 'EACCES' } }),
      true
    )
    expect(v.warnings).toEqual([
      'CLAUDE.md could not be linked: symlink not permitted (on Windows, enable Developer Mode). This account keeps its own copy.',
      'agents could not be linked (EACCES).'
    ])
  })

  it('an occupied set-aside slot names the folder to clear', () => {
    const v = setupShareView(res({ 'settings.json': { state: 'own', skipped: 'set-aside-occupied' } }), true)
    expect(v.warnings[0]).toBe(
      'settings.json was not shared: /u/claude-accounts/a1/.nodeterm-set-aside already holds a copy of it. Move that copy out first.'
    )
  })
})

describe('setupShareView — OFF', () => {
  it('says nothing after a clean off', () => {
    expect(setupShareView(res({ 'settings.json': { state: 'own' } }), false)).toEqual({ summary: null, warnings: [] })
  })

  it('a copy that could not be put back says where it is', () => {
    const v = setupShareView(res({ 'settings.json': { state: 'diverged', setAside: true, skipped: 'not-restored' } }), false)
    expect(v.warnings).toEqual([
      'settings.json was not put back: something else is in its place now. This account’s earlier copy is in /u/claude-accounts/a1/.nodeterm-set-aside.'
    ])
  })

  it('links that are still there with the switch off are reported, never silently left', () => {
    const v = setupShareView(res({ agents: { state: 'shared' }, commands: { state: 'dangling' } }), false)
    expect(v.warnings).toEqual([
      'agents and commands are still linked to ~/.claude. Turn this on and off again to remove them.'
    ])
  })
})

describe('setupShareView — refusals and failures', () => {
  it('a failed read is never "nothing to share"', () => {
    const v = setupShareView({ items: [], identityKeys: [], setAsideDir: '', error: 'EACCES' }, true)
    expect(v.summary).toBeNull()
    expect(v.warnings).toEqual(['Setup sharing could not be checked (EACCES).'])
  })

  it('explains each refusal', () => {
    expect(setupShareView(res({}, { refused: 'remote-account' }), true).summary).toContain('SSH host')
    expect(setupShareView(res({}, { refused: 'same-directory' }), true).summary).toContain('~/.claude itself')
    expect(setupShareView(res({}, { refused: 'set-aside-unavailable' }), true).warnings[0]).toContain(
      '.nodeterm-set-aside is not a folder'
    )
  })
})
