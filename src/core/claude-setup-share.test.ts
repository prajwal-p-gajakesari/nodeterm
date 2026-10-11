// Real-filesystem tests for the "Share ~/.claude setup" applier. The whole risk of this feature is
// that a wrong move or removal costs a user their hooks, their settings or their plugins, so these
// run against real directories, real symlinks and real content — a mocked `fs` would agree with
// whatever the code believed. The system dir and the ownership record are injected: nothing here
// can reach the developer's own `~/.claude` or userData.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync as realpathSyncForTest,
  renameSync as renameSyncForTest,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import path from 'path'
import { testTmpDir } from './test-tmp'
import { applySetupShare, readSetupShareStatus } from './claude-setup-share'
import { SET_ASIDE_DIR } from './claude-setup-share-core'
import type { ClaudeSetupItemName, ClaudeSetupShareResult } from '../shared/types'

let root = ''
let sys = ''
let cfg = ''
let recordFile = ''

const SYSTEM_SETTINGS = JSON.stringify({
  hooks: { Notification: [{ hooks: [{ type: 'command', command: 'flowboard push' }] }] },
  enabledPlugins: { 'demo@local': true }
})
const ACCOUNT_SETTINGS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh managed' }] }] } })

function put(p: string, body: string): void {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const read = (p: string): string => readFileSync(p, 'utf8')
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
/** Every file under a dir with its content, following nothing — the "is the system intact" check. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = e.isSymbolicLink() ? `-> ${readlinkSync(p)}` : read(p)
    }
  }
  walk(dir)
  return out
}
const stateOf = (res: ClaudeSetupShareResult, name: ClaudeSetupItemName) =>
  res.items.find((i) => i.name === name)
const target = { accountId: 'a1' } as const
const on = (gesture: 'toggle' | 'sweep' = 'toggle', extra = {}) =>
  applySetupShare({ ...target, configDir: cfg, systemDir: sys, recordFile, enabled: true, gesture, ...extra })
const off = (extra = {}) =>
  applySetupShare({ ...target, configDir: cfg, systemDir: sys, recordFile, enabled: false, gesture: 'toggle', ...extra })
const status = () => readSetupShareStatus({ ...target, configDir: cfg, systemDir: sys, recordFile })
const recorded = (): unknown => {
  try {
    return JSON.parse(read(recordFile)).accounts.a1?.links ?? []
  } catch {
    return []
  }
}

beforeEach(() => {
  root = testTmpDir('nt-setupshare-')
  sys = path.join(root, 'home', '.claude')
  cfg = path.join(root, 'userData', 'claude-accounts', 'a1')
  recordFile = path.join(root, 'userData', 'claude-setup-share.json')
  put(path.join(sys, 'settings.json'), SYSTEM_SETTINGS)
  put(path.join(sys, 'plugins', 'installed_plugins.json'), '{"version":2}')
  put(path.join(sys, 'CLAUDE.md'), 'be terse')
  put(path.join(sys, 'agents', 'reviewer.md'), 'AGENT')
  put(path.join(sys, 'commands', 'ship.md'), 'COMMAND')
  put(path.join(sys, 'output-styles', 'plain.md'), 'STYLE')
  // What nodeterm's add path leaves in a managed account: its own settings.json (the managed hook)
  // and its own skills — the latter is the other switch's business and must never be touched.
  put(path.join(cfg, 'settings.json'), ACCOUNT_SETTINGS)
  put(path.join(cfg, 'skills', 'manage-nodeterm-canvas', 'SKILL.md'), 'CANVAS')
})

describe('ON from the switch', () => {
  it('links every item, sets the account’s own settings.json aside, and records what it made', () => {
    const res = on()
    expect(res.refused).toBeUndefined()
    for (const name of ['settings.json', 'plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles'] as const) {
      expect(isLink(path.join(cfg, name)), name).toBe(true)
      expect(stateOf(res, name)?.state, name).toBe('shared')
    }
    // The account now reads the system's setup…
    expect(read(path.join(cfg, 'settings.json'))).toBe(SYSTEM_SETTINGS)
    expect(read(path.join(cfg, 'agents', 'reviewer.md'))).toBe('AGENT')
    // …and its own copy is set aside, byte for byte, not deleted.
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(stateOf(res, 'settings.json')?.setAside).toBe(true)
    expect(recorded()).toEqual(['settings.json', 'plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles'])
    // The skills folder is the other switch's: untouched.
    expect(isLink(path.join(cfg, 'skills'))).toBe(false)
    expect(read(path.join(cfg, 'skills', 'manage-nodeterm-canvas', 'SKILL.md'))).toBe('CANVAS')
  })

  it('is idempotent', () => {
    on()
    const again = on()
    expect(again.items.every((i) => !i.error)).toBe(true)
    expect(stateOf(again, 'settings.json')?.state).toBe('shared')
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
  })

  it('edits flow both ways — which is what the Settings copy promises', () => {
    on()
    writeFileSync(path.join(cfg, 'agents', 'new.md'), 'FROM ACCOUNT')
    expect(read(path.join(sys, 'agents', 'new.md'))).toBe('FROM ACCOUNT')
  })

  it('writes the record BEFORE making a link, so a crash cannot leave a link the switch will not remove', () => {
    const seen: unknown[] = []
    on('toggle', {
      ops: {
        symlink: (t: string, p: string, type: 'junction' | 'file') => {
          seen.push(recorded())
          symlinkSync(t, p, type)
        }
      }
    })
    expect(seen.length).toBe(6)
    for (const r of seen) expect(r).toEqual(expect.arrayContaining(['settings.json', 'agents']))
  })
})

describe('OFF', () => {
  it('removes only the links, puts the account’s own settings.json back, and leaves ~/.claude intact', () => {
    const before = snapshot(sys)
    on()
    writeFileSync(path.join(cfg, 'commands', 'added.md'), 'X') // a shared edit, kept in ~/.claude
    const res = off()
    expect(res.items.every((i) => !i.error)).toBe(true)
    for (const name of ['plugins', 'CLAUDE.md', 'agents', 'commands', 'output-styles']) {
      expect(existsSync(path.join(cfg, name)), name).toBe(false)
    }
    expect(isLink(path.join(cfg, 'settings.json'))).toBe(false)
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(snapshot(sys)).toEqual({ ...before, [path.join('commands', 'added.md')]: 'X' })
    expect(existsSync(path.join(cfg, SET_ASIDE_DIR))).toBe(false) // emptied, so tidied away
    expect(recorded()).toEqual([])
    expect(stateOf(res, 'settings.json')?.state).toBe('own')
  })

  it('re-checks each link at the moment it removes it — a real folder swapped in mid-run survives', () => {
    on()
    // The plan for OFF is made up front. While it runs (the settings.json restore is the first
    // rename), something replaces the `plugins` link with a real — empty, so `rmdir` WOULD take
    // it — folder. The unlink of `plugins` must refuse rather than act on the stale plan.
    let swapped = false
    const res = off({
      ops: {
        rename: (from: string, to: string) => {
          if (!swapped) {
            swapped = true
            unlinkSync(path.join(cfg, 'plugins'))
            mkdirSync(path.join(cfg, 'plugins'))
          }
          renameSyncForTest(from, to)
        }
      }
    })
    expect(swapped).toBe(true)
    expect(lstatSync(path.join(cfg, 'plugins')).isDirectory()).toBe(true)
    expect(stateOf(res, 'plugins')?.error).toBe('not-ours')
  })

  it('removing a managed account dir while sharing is on deletes the links, never what they point at', () => {
    // `claude-accounts:remove` is an `fs.rm(recursive)` of the managed dir. It must not follow.
    const before = snapshot(sys)
    on()
    rmSync(cfg, { recursive: true, force: true })
    expect(snapshot(sys)).toEqual(before)
  })
})

describe('the two-profile layout: a hand-made link of the very shape we create', () => {
  it('is the user’s — ON leaves it unrecorded and OFF does not remove it', () => {
    unlinkSync(path.join(cfg, 'settings.json'))
    symlinkSync(path.join(sys, 'settings.json'), path.join(cfg, 'settings.json'))
    const res = on()
    expect(stateOf(res, 'settings.json')?.state).toBe('shared-by-you')
    expect(recorded()).not.toContain('settings.json')
    off()
    expect(isLink(path.join(cfg, 'settings.json'))).toBe(true)
    expect(readlinkSync(path.join(cfg, 'settings.json'))).toBe(path.join(sys, 'settings.json'))
  })

  it('a record written for another directory makes nothing ours', () => {
    on()
    const rec = JSON.parse(read(recordFile))
    rec.accounts.a1.dir = path.join(root, 'somewhere-else')
    writeFileSync(recordFile, JSON.stringify(rec))
    off()
    expect(isLink(path.join(cfg, 'agents'))).toBe(true)
  })
})

describe('diverged — something replaced our link with a regular file', () => {
  /** What an atomic-rename writer does to a symlinked file: a new regular file at the name. */
  const replaceWithFile = (body: string): void => {
    unlinkSync(path.join(cfg, 'settings.json'))
    writeFileSync(path.join(cfg, 'settings.json'), body)
  }

  it('is reported by the status read, and neither the sweep nor OFF overwrites it', () => {
    on()
    replaceWithFile('{"model":"changed-in-account"}')
    expect(stateOf(status(), 'settings.json')?.state).toBe('diverged')
    on('sweep')
    expect(read(path.join(cfg, 'settings.json'))).toBe('{"model":"changed-in-account"}')
    const res = off()
    expect(read(path.join(cfg, 'settings.json'))).toBe('{"model":"changed-in-account"}')
    // The account's earlier copy is NOT lost and NOT put over the new file: it stays set aside.
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(stateOf(res, 'settings.json')).toMatchObject({ setAside: true, skipped: 'not-restored' })
    expect(read(path.join(sys, 'settings.json'))).toBe(SYSTEM_SETTINGS)
  })

  it('the remedy the Settings row names works: delete that file, then turn the switch off and on', () => {
    on()
    replaceWithFile('{}')
    unlinkSync(path.join(cfg, 'settings.json'))
    off()
    // OFF found the slot empty and put the account's original copy back…
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    const res = on()
    // …and ON set it aside again and re-linked.
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'shared', setAside: true })
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
  })

  it('on the desktop the next launch also re-links the emptied slot by itself', () => {
    on()
    replaceWithFile('{}')
    unlinkSync(path.join(cfg, 'settings.json'))
    expect(stateOf(on('sweep'), 'settings.json')?.state).toBe('shared')
  })
})

describe('the launch sweep', () => {
  it('links empty slots but never sets the account’s own copy aside', () => {
    const res = on('sweep')
    expect(isLink(path.join(cfg, 'settings.json'))).toBe(false)
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'own', skipped: 'own-kept' })
    expect(isLink(path.join(cfg, 'agents'))).toBe(true)
    expect(existsSync(path.join(cfg, SET_ASIDE_DIR))).toBe(false)
  })
})

describe('the identity guard', () => {
  it('does not link settings.json or plugins while ~/.claude/settings.json sets an API key helper', () => {
    put(path.join(sys, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/key', env: { ANTHROPIC_API_KEY: 'sk-x' } }))
    const res = on()
    expect(res.identityKeys).toEqual(['apiKeyHelper', 'env.ANTHROPIC_API_KEY'])
    expect(JSON.stringify(res)).not.toContain('sk-x')
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS) // not even set aside
    expect(existsSync(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(false)
    expect(existsSync(path.join(cfg, 'plugins'))).toBe(false)
    expect(stateOf(res, 'settings.json')?.skipped).toBe('withheld-identity')
    expect(isLink(path.join(cfg, 'agents'))).toBe(true)
  })

  it('reports a key that appeared AFTER settings.json was shared — the account is using it now', () => {
    on()
    put(path.join(sys, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/key' }))
    const s = status()
    expect(stateOf(s, 'settings.json')?.state).toBe('shared')
    expect(s.identityKeys).toEqual(['apiKeyHelper'])
  })

  it('an unreadable ~/.claude/settings.json is withheld, never assumed safe', () => {
    put(path.join(sys, 'settings.json'), '{ not json')
    const res = on()
    expect(res.settingsUnreadable).toBe(true)
    expect(isLink(path.join(cfg, 'settings.json'))).toBe(false)
  })
})

describe('failures put things back', () => {
  it('a refused file link (Windows without Developer Mode) puts the account’s own copy straight back', () => {
    const eperm = (t: string, p: string, type: 'junction' | 'file'): void => {
      if (type === 'file') throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      symlinkSync(t, p, type)
    }
    const res = on('toggle', { ops: { symlink: eperm } })
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'own', setAside: false, error: 'EPERM' })
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(stateOf(res, 'CLAUDE.md')).toMatchObject({ state: 'none', error: 'EPERM' })
    // plugins is a junction and WOULD link — but settings.json just failed, so the account keeps its
    // own enabledPlugins and must not get the global plugins dir under them.
    expect(existsSync(path.join(cfg, 'plugins'))).toBe(false)
    expect(stateOf(res, 'plugins')).toMatchObject({ state: 'none', skipped: 'needs-settings' })
    expect(isLink(path.join(cfg, 'agents'))).toBe(true) // the rest are junctions: unaffected
    expect(recorded()).toEqual(['agents', 'commands', 'output-styles'])
  })

  it('never sets aside onto a copy that appeared there mid-run — a rename would replace it', () => {
    put(path.join(cfg, 'CLAUDE.md'), 'ACCOUNT MEMORY')
    let planted = false
    const res = on('toggle', {
      ops: {
        // The first rename is settings.json's set-aside; by then the plan for CLAUDE.md is made.
        rename: (from: string, to: string) => {
          if (!planted) {
            planted = true
            put(path.join(cfg, SET_ASIDE_DIR, 'CLAUDE.md'), 'PRECIOUS')
          }
          renameSyncForTest(from, to)
        }
      }
    })
    expect(planted).toBe(true)
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'CLAUDE.md'))).toBe('PRECIOUS')
    expect(read(path.join(cfg, 'CLAUDE.md'))).toBe('ACCOUNT MEMORY')
    expect(stateOf(res, 'CLAUDE.md')).toMatchObject({ state: 'own', error: 'EEXIST' })
  })

  it('a failed set-aside moves nothing and links nothing in that slot', () => {
    const res = on('toggle', {
      ops: {
        rename: () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
      }
    })
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'own', error: 'EBUSY' })
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(recorded()).not.toContain('settings.json')
  })
})

describe('the identity guard’s withdrawal', () => {
  const addHelper = (): void =>
    put(path.join(sys, 'settings.json'), JSON.stringify({ ...JSON.parse(SYSTEM_SETTINGS), apiKeyHelper: '/bin/key' }))

  it('the launch sweep unlinks our settings.json + plugins, restores the account’s own, and says so ONCE', () => {
    on()
    const before = snapshot(sys)
    addHelper() // edited after sharing — Claude Code hot-reloads it, so the account already uses it
    const res = on('sweep')
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'own', skipped: 'withdrawn-identity' })
    expect(isLink(path.join(cfg, 'settings.json'))).toBe(false)
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(existsSync(path.join(cfg, 'plugins'))).toBe(false)
    expect(existsSync(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(false)
    // Only those two: the rest stays shared, and nothing in the system dir moved.
    expect(isLink(path.join(cfg, 'agents'))).toBe(true)
    expect(recorded()).toEqual(['CLAUDE.md', 'agents', 'commands', 'output-styles'])
    const { ['settings.json']: _settings, ...rest } = snapshot(sys)
    const { ['settings.json']: _before, ...restBefore } = before
    expect(rest).toEqual(restBefore)
    // Announced to the first status read, and to that one only.
    expect(status().withdrawnAtLaunch).toBe(true)
    expect(status().withdrawnAtLaunch).toBeUndefined()
  })

  it('an ON from the switch withdraws the same two, without a launch notice (the switch is its own)', () => {
    on()
    addHelper()
    const res = on('toggle')
    expect(stateOf(res, 'settings.json')?.skipped).toBe('withdrawn-identity')
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(existsSync(path.join(cfg, 'plugins'))).toBe(false)
    expect(status().withdrawnAtLaunch).toBeUndefined()
  })

  it('once the key is gone, switching off and on shares them again', () => {
    on()
    addHelper()
    on('sweep')
    put(path.join(sys, 'settings.json'), SYSTEM_SETTINGS)
    off()
    const res = on()
    expect(stateOf(res, 'settings.json')?.state).toBe('shared')
    expect(stateOf(res, 'plugins')?.state).toBe('shared')
  })
})

describe('the ownership record', () => {
  it('an unreadable record aborts — nothing is linked and the file is not overwritten', () => {
    put(recordFile, '{ "version": 1, "accounts": { "other": { "dir": "/x", "links": ["agents"] } ')
    const bytes = read(recordFile)
    const res = on()
    expect(res.error).toBe('record-unreadable')
    expect(read(recordFile)).toBe(bytes)
    expect(isLink(path.join(cfg, 'agents'))).toBe(false)
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
    expect(status().error).toBe('record-unreadable')
  })

  it('so does a record path that cannot be read at all (a folder there)', () => {
    mkdirSync(recordFile, { recursive: true })
    expect(on().error).toBe('record-unreadable')
    expect(isLink(path.join(cfg, 'agents'))).toBe(false)
  })

  it('only a MISSING record reads as empty', () => {
    expect(existsSync(recordFile)).toBe(false)
    expect(on().error).toBeUndefined()
  })

  it('a crash between the record write and the set-aside leaves the account’s own copy, read as its own', () => {
    put(recordFile, JSON.stringify({ version: 1, accounts: { a1: { dir: realpathSyncForTest(cfg), links: ['settings.json'] } } }))
    expect(stateOf(status(), 'settings.json')?.state).toBe('own')
    // …and the switch then does what it would have: set it aside and link.
    const res = on()
    expect(stateOf(res, 'settings.json')).toMatchObject({ state: 'shared', setAside: true })
    expect(read(path.join(cfg, SET_ASIDE_DIR, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
  })
})

describe('the source is the system Claude dir, $CLAUDE_CONFIG_DIR included', () => {
  it('with no systemDir given, links point into $CLAUDE_CONFIG_DIR and the label names it', () => {
    const moved = path.join(root, 'claude-main')
    put(path.join(moved, 'agents', 'only-here.md'), 'MOVED')
    const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME }
    process.env.CLAUDE_CONFIG_DIR = moved
    // A scratch HOME too: were the default ever `homedir()/.claude` again, this test must read an
    // empty scratch dir and fail, never the developer's own ~/.claude.
    process.env.HOME = path.join(root, 'scratch-home')
    try {
      const res = applySetupShare({ ...target, configDir: cfg, recordFile, enabled: true, gesture: 'toggle' })
      expect(read(path.join(cfg, 'agents', 'only-here.md'))).toBe('MOVED')
      expect(res.systemLabel).toBe(moved)
      expect(isLink(path.join(cfg, 'CLAUDE.md'))).toBe(false) // ~/.claude's would-be items are not touched
    } finally {
      if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved.cfg
      if (saved.home === undefined) delete process.env.HOME
      else process.env.HOME = saved.home
    }
  })
})

describe('refusals', () => {
  it('refuses an account dir that resolves to ~/.claude, and writes nothing', () => {
    const linkedToSystem = path.join(root, 'claude-2')
    symlinkSync(sys, linkedToSystem)
    const before = snapshot(sys)
    const res = applySetupShare({
      ...target,
      configDir: linkedToSystem,
      systemDir: sys,
      recordFile,
      enabled: true,
      gesture: 'toggle'
    })
    expect(res.refused).toBe('same-directory')
    expect(snapshot(sys)).toEqual(before)
    expect(existsSync(recordFile)).toBe(false)
  })

  it('refuses when the set-aside folder is a link, so no rename can be aimed elsewhere', () => {
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, path.join(cfg, SET_ASIDE_DIR))
    const res = on()
    expect(res.refused).toBe('set-aside-unavailable')
    expect(readdirSync(elsewhere)).toEqual([])
    expect(read(path.join(cfg, 'settings.json'))).toBe(ACCOUNT_SETTINGS)
  })
})
