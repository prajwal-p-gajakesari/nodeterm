import { describe, expect, it } from 'vitest'
import { announceSetupShareWithdrawals, setupShareView } from './setupSharing'
import type {
  ClaudeAccount,
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

  it('a key that appeared after settings.json was shared: says the account reads it now, and when it is unlinked', () => {
    const v = setupShareView(res(allShared(), { identityKeys: ['apiKeyHelper'] }), true)
    expect(v.warnings).toEqual([
      '~/.claude/settings.json now sets apiKeyHelper, which would replace or redirect this account’s own login — Claude Code already reads it in this account. nodeterm unlinks settings.json and plugins at its next launch; turn this off and on to do it now.'
    ])
  })

  it('a withdrawal — at launch or from the switch — says what was unlinked, why, and how to share again', () => {
    const items = { 'settings.json': { state: 'own' as const, skipped: 'withdrawn-identity' as const } }
    const fromSwitch = setupShareView(res(items, { identityKeys: ['env.ANTHROPIC_API_KEY'] }), true)
    expect(fromSwitch.warnings).toEqual([
      'settings.json and plugins were unlinked: ~/.claude/settings.json sets env.ANTHROPIC_API_KEY, which would replace or redirect this account’s own login. This account’s own settings are back. Once that file is safe again, turn this off and on to share them.'
    ])
    const atLaunch = setupShareView(
      res({ 'settings.json': { state: 'own' } }, { identityKeys: ['apiKeyHelper'], withdrawnAtLaunch: true }),
      true
    )
    expect(atLaunch.warnings[0]).toContain('were unlinked at launch:')
    // The withdrawal sentence REPLACES the plain "not shared" one rather than adding to it.
    expect(atLaunch.warnings).toHaveLength(1)
  })

  it('names the source by its label when $CLAUDE_CONFIG_DIR moved it, in that dir’s own separator', () => {
    const posix = setupShareView(res({}, { systemLabel: '/home/u/claude-main', identityKeys: ['apiKeyHelper'] }), true)
    expect(posix.warnings[0]).toContain('/home/u/claude-main/settings.json sets apiKeyHelper')
    expect(posix.summary).toBe('Nothing in /home/u/claude-main to share yet.')
    const win = setupShareView(res({}, { systemLabel: 'C:\\Users\\me\\claude-main', identityKeys: ['apiKeyHelper'] }), true)
    expect(win.warnings[0]).toContain('C:\\Users\\me\\claude-main\\settings.json sets')
  })

  it('plugins waiting on settings.json says why', () => {
    const v = setupShareView(res({ plugins: { state: 'none', skipped: 'needs-settings' } }), true)
    expect(v.warnings).toEqual([
      'plugins is not shared because settings.json is not — the enabledPlugins that make an installed plugin count are kept there.'
    ])
  })

  it('a shareable item the account still holds its own copy of is said, with the switch-off-and-on remedy', () => {
    const v = setupShareView(
      res({ agents: { state: 'shared' }, 'CLAUDE.md': { state: 'own', available: true }, commands: { state: 'own', available: false } }),
      true
    )
    expect(v.warnings).toEqual([
      'CLAUDE.md is not shared: this account has its own copy. Turn this off and on again to share it (the copy is set aside, not deleted).'
    ])
  })

  it('an unreadable ~/.claude/settings.json is said, not read as "nothing to share"', () => {
    const v = setupShareView(res({}, { settingsUnreadable: true }), true)
    expect(v.warnings).toEqual([
      'settings.json and plugins are not shared: ~/.claude/settings.json could not be read as JSON, so it cannot be checked for keys that would replace this account’s login.'
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
  it('an unreadable ownership record says nothing was changed, and where the record lives', () => {
    const v = setupShareView({ items: [], identityKeys: [], setAsideDir: '', error: 'record-unreadable' }, true)
    expect(v.warnings).toEqual([
      'nodeterm could not read its record of shared links (claude-setup-share.json in its data folder), so nothing was changed.'
    ])
  })

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

describe('announceSetupShareWithdrawals — the launch notice', () => {
  const acct = (over: Partial<ClaudeAccount>): ClaudeAccount => ({ id: 'a1', label: 'work', createdAt: 0, ...over })

  it('raises one toast per account the launch sweep withdrew, and asks only local accounts with the switch on', async () => {
    const asked: string[] = []
    const notes: string[] = []
    await announceSetupShareWithdrawals(
      [
        acct({ id: 'a1', label: 'work', shareSystemSetup: true }),
        acct({ id: 'a2', label: 'calm', shareSystemSetup: true }),
        acct({ id: 'a3', label: 'off' }),
        acct({ id: 'a4', label: 'remote', host: 'u@h', shareSystemSetup: true })
      ],
      async (id) => {
        asked.push(id)
        return res({}, id === 'a1' ? { withdrawnAtLaunch: true, identityKeys: ['apiKeyHelper'] } : {})
      },
      (m) => notes.push(m)
    )
    expect(asked).toEqual(['a1', 'a2'])
    expect(notes).toEqual([
      'Stopped sharing settings.json and plugins with “work”: ~/.claude/settings.json sets apiKeyHelper, which would replace or redirect that account’s own login. See Settings → Accounts.'
    ])
  })

  it('a surface without the method, or a failed read, raises nothing', async () => {
    const notes: string[] = []
    await announceSetupShareWithdrawals(
      [acct({ shareSystemSetup: true })],
      async () => {
        throw Object.assign(new Error('nope'), { code: 'E_UNSUPPORTED' })
      },
      (m) => notes.push(m)
    )
    expect(notes).toEqual([])
  })
})
