// Pure planning for "Share ~/.claude setup". Every case here is a promise about the user's own
// files, decided before any filesystem is touched: what ON may move, what OFF may remove, and the
// shapes that must be left alone in BOTH directions. The real-filesystem half is
// `claude-setup-share.test.ts`.
import { describe, expect, it } from 'vitest'
import { AUTH_ENV_STRIP } from './claude-accounts-core'
import {
  IDENTITY_ENV_KEYS,
  NEVER_SHARED,
  SET_ASIDE_DIR,
  SHARED_SETUP_ITEMS,
  classifySetupItem,
  identityKeysIn,
  planSetupShare,
  sanitizeRecorded,
  sanitizeSetupShareRecord,
  setupItems,
  type SetupShareFacts
} from './claude-setup-share-core'
import type { ClaudeSetupItemName } from '../shared/types'

const SYS = '/home/u/.claude'
const CFG = '/data/claude-accounts/a1'
const ALL = SHARED_SETUP_ITEMS.map((i) => i.name)

/** A system dir holding every item, and an account dir holding only what nodeterm's add path puts
 *  there: its own settings.json (the managed hook). */
function facts(over: Partial<SetupShareFacts> = {}): SetupShareFacts {
  const system: SetupShareFacts['system'] = {}
  for (const { name, kind } of SHARED_SETUP_ITEMS) system[name] = { kind, real: `${SYS}/${name}` }
  return {
    systemDir: SYS,
    configDir: CFG,
    system,
    account: { 'settings.json': { kind: 'file', real: `${CFG}/settings.json` } },
    setAside: {},
    setAsideDir: 'absent',
    settingsIdentity: [],
    recorded: [],
    win: false,
    ...over
  }
}

const ourLink = (name: string, sys = SYS) => ({
  kind: 'link' as const,
  linkTarget: `${sys}/${name}`,
  real: `${sys}/${name}`
})
const stepsOf = (plan: ReturnType<typeof planSetupShare>, name: ClaudeSetupItemName) =>
  plan.items.find((i) => i.name === name)?.steps
const skipOf = (plan: ReturnType<typeof planSetupShare>, name: ClaudeSetupItemName) =>
  plan.skipped.find((s) => s.name === name)?.reason

describe('the allowlist and what outranks it', () => {
  it('never lists the login, conversations, the skills switch or our own folder', () => {
    for (const forbidden of ['.claude.json', '.credentials.json', 'projects', 'skills', SET_ASIDE_DIR]) {
      expect(Object.hasOwn(NEVER_SHARED, forbidden), forbidden).toBe(true)
    }
    for (const name of ALL) {
      expect(Object.hasOwn(NEVER_SHARED, name), `${name} is allowlisted AND forbidden`).toBe(false)
      // A name pattern too, so an entry that would share a secret goes red even when added on purpose.
      expect(name).not.toMatch(/credential|token|secret|auth|\.claude\.json|projects|skills|history|todos/i)
    }
  })

  it('a forbidden name added to the table by mistake is still never walked', () => {
    const table = [
      ...SHARED_SETUP_ITEMS,
      { name: '.claude.json' as ClaudeSetupItemName, kind: 'file' as const },
      { name: 'projects' as ClaudeSetupItemName, kind: 'dir' as const }
    ]
    expect(setupItems(table).map((i) => i.name)).toEqual(ALL)
  })

  it('drops a recorded name that is unknown or forbidden — the record is a hand-editable file', () => {
    expect(sanitizeRecorded(['settings.json', '.claude.json', 'skills', '../x', 7, 'agents', 'agents'])).toEqual([
      'settings.json',
      'agents'
    ])
  })

  it('reads the record file defensively: bad ids, relative dirs and unknown names never survive', () => {
    const rec = sanitizeSetupShareRecord({
      version: 1,
      accounts: {
        good: { dir: CFG, links: ['settings.json', 'projects'] },
        win: { dir: 'C:\\Users\\me\\.claude-2', links: ['agents'] },
        '../evil': { dir: CFG, links: ['agents'] },
        rel: { dir: 'relative/dir', links: ['agents'] },
        empty: { dir: CFG, links: ['nope'] }
      }
    })
    expect(rec.accounts).toEqual({
      good: { dir: CFG, links: ['settings.json'] },
      win: { dir: 'C:\\Users\\me\\.claude-2', links: ['agents'] }
    })
    expect(sanitizeSetupShareRecord(null).accounts).toEqual({})
    expect(sanitizeSetupShareRecord({ accounts: [] }).accounts).toEqual({})
  })
})

describe('identityKeysIn — keys that would replace or redirect the account login', () => {
  it('names each key it finds, values never', () => {
    const raw = JSON.stringify({
      apiKeyHelper: '/usr/local/bin/key',
      hooks: { Stop: [] },
      env: { ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', FOO: 'x' }
    })
    const found = identityKeysIn(raw)
    expect(found).toEqual([
      'apiKeyHelper',
      'env.ANTHROPIC_API_KEY',
      'env.ANTHROPIC_BASE_URL',
      'env.CLAUDE_CODE_USE_BEDROCK'
    ])
    expect(JSON.stringify(found)).not.toContain('sk-secret')
  })

  it('an ordinary setup — hooks, permissions, plugins, status line — has none', () => {
    const raw = JSON.stringify({
      hooks: { Notification: [{ hooks: [{ type: 'command', command: 'flowboard push' }] }] },
      permissions: { allow: ['Bash(git *)'] },
      enabledPlugins: { 'x@y': true },
      statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
      env: { EDITOR: 'vim', apiKeyHelper: 'not top-level' }
    })
    expect(identityKeysIn(raw)).toEqual([])
    expect(identityKeysIn('')).toEqual([])
    expect(identityKeysIn(JSON.stringify({ apiKeyHelper: '' }))).toEqual([])
  })

  it('cannot read it ⇒ "unreadable", never "safe"', () => {
    expect(identityKeysIn('{ nope')).toBe('unreadable')
    expect(identityKeysIn('[]')).toBe('unreadable')
    expect(identityKeysIn('"text"')).toBe('unreadable')
  })

  it('derives from the spawn strip list, so a key added there is guarded here too', () => {
    for (const k of AUTH_ENV_STRIP) expect(IDENTITY_ENV_KEYS).toContain(k)
  })
})

describe('planSetupShare — ON from the switch', () => {
  it("sets the account's own settings.json aside and links everything the system has", () => {
    const plan = planSetupShare(facts(), { enabled: true, gesture: 'toggle' })
    expect(plan.refused).toBeUndefined()
    expect(stepsOf(plan, 'settings.json')).toEqual(['set-aside', 'link'])
    for (const name of ['plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles'] as const) {
      expect(stepsOf(plan, name), name).toEqual(['link'])
    }
    expect(plan.items.find((i) => i.name === 'agents')?.target).toBe(`${SYS}/agents`)
    expect(plan.recordAfter).toEqual(ALL)
  })

  it('links nothing the system does not have, and only the kind each item must be', () => {
    const f = facts()
    f.system['CLAUDE.md'] = { kind: 'absent' }
    f.system.agents = { kind: 'file', real: `${SYS}/agents` }
    const plan = planSetupShare(f, { enabled: true, gesture: 'toggle' })
    expect(stepsOf(plan, 'CLAUDE.md')).toBeUndefined()
    expect(stepsOf(plan, 'agents')).toBeUndefined()
    expect(plan.recordAfter).not.toContain('agents')
  })

  it('never sets aside onto a copy already set aside (a rename would replace it)', () => {
    const plan = planSetupShare(facts({ setAside: { 'settings.json': true }, setAsideDir: 'dir' }), {
      enabled: true,
      gesture: 'toggle'
    })
    expect(stepsOf(plan, 'settings.json')).toBeUndefined()
    expect(skipOf(plan, 'settings.json')).toBe('set-aside-occupied')
  })

  it('links an EMPTY slot whose copy is already set aside, leaving that copy where it is', () => {
    const plan = planSetupShare(
      facts({ account: {}, setAside: { 'settings.json': true }, setAsideDir: 'dir' }),
      { enabled: true, gesture: 'toggle' }
    )
    expect(stepsOf(plan, 'settings.json')).toEqual(['link'])
  })

  it('never moves an entry it could not classify', () => {
    const plan = planSetupShare(facts({ account: { agents: { kind: 'other' } } }), {
      enabled: true,
      gesture: 'toggle'
    })
    expect(stepsOf(plan, 'agents')).toBeUndefined()
    expect(skipOf(plan, 'agents')).toBe('own-kept')
  })
})

describe('planSetupShare — the identity guard', () => {
  it('withholds settings.json AND plugins while ~/.claude/settings.json would replace or redirect the login', () => {
    const plan = planSetupShare(facts({ settingsIdentity: ['apiKeyHelper'] }), {
      enabled: true,
      gesture: 'toggle'
    })
    expect(stepsOf(plan, 'settings.json')).toBeUndefined()
    expect(stepsOf(plan, 'plugins')).toBeUndefined()
    expect(skipOf(plan, 'settings.json')).toBe('withheld-identity')
    expect(skipOf(plan, 'plugins')).toBe('withheld-identity')
    // The rest carries no identity and is shared as usual.
    expect(stepsOf(plan, 'CLAUDE.md')).toEqual(['link'])
    expect(stepsOf(plan, 'agents')).toEqual(['link'])
  })

  it('withholds the pair when the system settings cannot be read', () => {
    const plan = planSetupShare(facts({ settingsIdentity: 'unreadable' }), { enabled: true, gesture: 'toggle' })
    expect(skipOf(plan, 'settings.json')).toBe('withheld-unreadable')
    expect(stepsOf(plan, 'plugins')).toBeUndefined()
  })

  it('does not share plugins without a settings.json to enable them', () => {
    const f = facts({ account: {} })
    f.system['settings.json'] = { kind: 'absent' }
    const plan = planSetupShare(f, { enabled: true, gesture: 'toggle' })
    expect(stepsOf(plan, 'plugins')).toBeUndefined()
    expect(stepsOf(plan, 'agents')).toEqual(['link'])
  })
})

describe('planSetupShare — the launch sweep moves nothing', () => {
  it("links empty slots only; the account's own settings.json stays where it is", () => {
    const plan = planSetupShare(facts(), { enabled: true, gesture: 'sweep' })
    expect(stepsOf(plan, 'settings.json')).toBeUndefined()
    expect(skipOf(plan, 'settings.json')).toBe('own-kept')
    expect(stepsOf(plan, 'agents')).toEqual(['link'])
    for (const item of plan.items) expect(item.steps).toEqual(['link'])
  })
})

describe('planSetupShare — OFF', () => {
  it('removes exactly our links and puts each set-aside copy back', () => {
    const account: SetupShareFacts['account'] = {}
    for (const name of ALL) account[name] = ourLink(name)
    const plan = planSetupShare(
      facts({ account, recorded: ALL, setAside: { 'settings.json': true }, setAsideDir: 'dir' }),
      { enabled: false, gesture: 'toggle' }
    )
    expect(stepsOf(plan, 'settings.json')).toEqual(['unlink', 'restore'])
    expect(stepsOf(plan, 'agents')).toEqual(['unlink'])
    expect(plan.recordAfter).toEqual([])
  })

  it('a dangling link of ours (the system copy is gone) is still ours to remove', () => {
    const f = facts({ account: { 'CLAUDE.md': ourLink('CLAUDE.md') }, recorded: ['CLAUDE.md'] })
    f.system['CLAUDE.md'] = { kind: 'absent' }
    expect(classifySetupItem(f, 'CLAUDE.md')).toBe('dangling')
    expect(stepsOf(planSetupShare(f, { enabled: false, gesture: 'toggle' }), 'CLAUDE.md')).toEqual(['unlink'])
    // …and ON leaves it alone rather than "repairing" it.
    expect(stepsOf(planSetupShare(f, { enabled: true, gesture: 'toggle' }), 'CLAUDE.md')).toBeUndefined()
  })

  it('restores a set-aside copy into an empty slot even with nothing to unlink', () => {
    const plan = planSetupShare(facts({ account: {}, setAside: { agents: true }, setAsideDir: 'dir' }), {
      enabled: false,
      gesture: 'toggle'
    })
    expect(stepsOf(plan, 'agents')).toEqual(['restore'])
  })
})

describe('ownership needs the record, not just the shape', () => {
  // The documented two-profile layout: `~/.claude-2/settings.json` is the user's own symlink to
  // `~/.claude/settings.json` — exactly the shape we create. #643's shape-only rule would call it
  // ours and the off-switch would delete it.
  const twoProfile = facts({ account: { 'settings.json': ourLink('settings.json') }, recorded: [] })

  it('a hand-made link of our exact shape is the user’s, and OFF leaves it', () => {
    expect(classifySetupItem(twoProfile, 'settings.json')).toBe('shared-by-you')
    const off = planSetupShare(twoProfile, { enabled: false, gesture: 'toggle' })
    expect(stepsOf(off, 'settings.json')).toBeUndefined()
    // ON neither sets it aside nor records it: its effect already is what sharing would do.
    const on = planSetupShare(twoProfile, { enabled: true, gesture: 'toggle' })
    expect(stepsOf(on, 'settings.json')).toBeUndefined()
    expect(on.recordAfter).not.toContain('settings.json')
  })

  it('a link we recorded but that now points elsewhere is not ours', () => {
    const f = facts({
      account: { agents: { kind: 'link', linkTarget: '/elsewhere/agents', real: '/elsewhere/agents' } },
      recorded: ['agents']
    })
    expect(classifySetupItem(f, 'agents')).toBe('diverged')
    expect(stepsOf(planSetupShare(f, { enabled: false, gesture: 'toggle' }), 'agents')).toBeUndefined()
  })
})

describe('diverged — a program replaced our link with a regular file', () => {
  const diverged = facts({
    account: { 'settings.json': { kind: 'file', real: `${CFG}/settings.json` } },
    recorded: ['settings.json'],
    setAside: { 'settings.json': true },
    setAsideDir: 'dir'
  })

  it('is reported and never overwritten, in either direction', () => {
    expect(classifySetupItem(diverged, 'settings.json')).toBe('diverged')
    const on = planSetupShare(diverged, { enabled: true, gesture: 'toggle' })
    expect(stepsOf(on, 'settings.json')).toBeUndefined()
    expect(skipOf(on, 'settings.json')).toBe('diverged')
    expect(on.recordAfter).toContain('settings.json') // stays recorded so the row keeps saying so
    const off = planSetupShare(diverged, { enabled: false, gesture: 'toggle' })
    expect(stepsOf(off, 'settings.json')).toBeUndefined()
    expect(skipOf(off, 'settings.json')).toBe('not-restored')
  })
})

describe('refusals', () => {
  it('refuses an account dir that is ~/.claude, inside it, or around it', () => {
    for (const [systemDir, configDir] of [
      [SYS, SYS],
      [SYS, `${SYS}/accounts/a1`],
      [`${CFG}/inner`, CFG]
    ]) {
      const plan = planSetupShare(facts({ systemDir, configDir }), { enabled: true, gesture: 'toggle' })
      expect(plan.refused, `${systemDir} vs ${configDir}`).toBe('same-directory')
      expect(plan.items).toEqual([])
    }
  })

  it('refuses when the set-aside folder is not a real folder (a link would aim the renames)', () => {
    for (const enabled of [true, false]) {
      const plan = planSetupShare(facts({ setAsideDir: 'other', recorded: ['agents'] }), {
        enabled,
        gesture: 'toggle'
      })
      expect(plan.refused).toBe('set-aside-unavailable')
      expect(plan.items).toEqual([])
      expect(plan.recordAfter).toEqual(['agents'])
    }
  })
})

describe('Windows paths', () => {
  const WSYS = 'C:\\Users\\me\\.claude'
  const WCFG = 'C:\\Users\\me\\AppData\\Roaming\\node-terminal\\claude-accounts\\a1'

  it('recognises our own junction through the \\\\?\\ prefix and trailing separator readlink returns', () => {
    const f = facts({
      systemDir: WSYS,
      configDir: WCFG,
      win: true,
      account: { agents: { kind: 'link', linkTarget: '\\\\?\\C:\\Users\\me\\.claude\\agents\\' } },
      recorded: ['agents']
    })
    f.system.agents = { kind: 'dir', real: `${WSYS}\\agents` }
    expect(classifySetupItem(f, 'agents')).toBe('shared')
    const off = planSetupShare(f, { enabled: false, gesture: 'toggle' })
    expect(off.items.find((i) => i.name === 'agents')).toMatchObject({ steps: ['unlink'] })
  })

  it('builds a C:\\ target and refuses a C:\\ account dir inside ~/.claude, case-insensitively', () => {
    const f = facts({ systemDir: WSYS, configDir: WCFG, win: true, account: {} })
    const plan = planSetupShare(f, { enabled: true, gesture: 'toggle' })
    expect(plan.items.find((i) => i.name === 'agents')?.target).toBe(`${WSYS}\\agents`)
    const inside = planSetupShare(
      facts({ systemDir: WSYS, configDir: 'c:\\users\\ME\\.claude\\x', win: true }),
      { enabled: true, gesture: 'toggle' }
    )
    expect(inside.refused).toBe('same-directory')
  })
})
