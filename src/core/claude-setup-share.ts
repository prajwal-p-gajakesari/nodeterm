// Apply the per-account "Share ~/.claude setup" plan. The decisions live in the pure
// `claude-setup-share-core.ts`; this file reads the two directories and the ownership record, hands
// them over, performs the steps, and then READS AGAIN to report what is actually there — the result
// is a description of the account dir after the call, never a claim that the writes worked.
//
// SYNCHRONOUS on purpose, unlike the async skills applier. The launch sweep runs inside
// `agent-integrations.ts`'s reconcile right BEFORE the (synchronous) managed-hook install into the
// same account dir. If this were async, the hook installer would win the race for an empty
// `settings.json` slot — it creates a real file there — and the account would silently stop
// sharing, at every boot. Order is the whole fix, and only a synchronous call can promise it.
//
// THREE PLATFORM / SAFETY DECISIONS:
//  1. Link type per item kind: `'junction'` for a folder (no Developer Mode or elevation needed on
//     Windows, same choice as #643), `'file'` for settings.json / CLAUDE.md. A junction cannot point
//     at a file, and a Windows FILE symlink needs Developer Mode or elevation — the EPERM is reported
//     on the item and the account's own copy is put straight back. Never a hardlink: nodeterm's own
//     settings transaction publishes by rename to the file's realpath, which would cut a hardlink on
//     the first hook write. On POSIX Node ignores the type.
//  2. Every rename is `renameAtomicSync` and is preceded by an lstat that the destination is EMPTY:
//     a POSIX rename onto an existing file — or an existing empty directory — silently replaces it,
//     and replacing the account's set-aside copy is exactly the loss this whole design avoids.
//  3. An unlink re-checks rule 1 on the live entry immediately before it, then `unlink`, then `rmdir`
//     for a Windows junction. Both fail on a real non-empty directory, so even a plan that somehow
//     named a real folder could not delete it.
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'fs'
import { homedir } from 'os'
import path from 'path'
import type {
  ClaudeSetupItemName,
  ClaudeSetupShareItem,
  ClaudeSetupShareResult
} from '../shared/types'
import { renameAtomicSync } from './fs-atomic'
import { writeManagedHookFileAtomic } from './agents/hooks/install-helper'
import { platform } from './platform'
import { normalizeLinkPath } from './claude-skill-share-core'
import { claudeSystemConfigDir } from './agents/hooks/claude'
import {
  SET_ASIDE_DIR,
  classifySetupItem,
  describeSetupShare,
  identityKeysIn,
  isOurSetupLink,
  planSetupShare,
  sanitizeRecorded,
  sanitizeSetupShareRecord,
  setupItems,
  setupShareRefusal,
  type SetupAccountEntry,
  type SetupShareFacts,
  type SetupShareRecordFile,
  type SetupSystemEntry
} from './claude-setup-share-core'

/** How the source dir is named in a sentence: `~/.claude` when it is that, else its path. The
 *  source is `claudeSystemConfigDir()` — `$CLAUDE_CONFIG_DIR` when the app's environment sets it,
 *  which is the dir the system account (and nodeterm's own system hook install) actually uses. */
function systemLabelFor(dir: string, win: boolean): string {
  return normalizeLinkPath(dir, win) === normalizeLinkPath(path.join(homedir(), '.claude'), win)
    ? '~/.claude'
    : dir
}

/**
 * Withdrawals the launch sweep made in THIS process run, by account id → the key names that caused
 * them. The sweep runs at boot, before any window exists, so a broadcast would reach nobody; the
 * renderer asks once settings have loaded (`announceSetupShareWithdrawals`), and the first status
 * read for that account TAKES the entry, so the notice is raised once per withdrawal, not per read.
 */
const withdrawnAtLaunch = new Set<string>()

/** The ownership record, in nodeterm's OWN userData: which items nodeterm linked into which
 *  account dir. Not inside the account dir, which for a linked account is the user's folder. */
export const SETUP_SHARE_RECORD_FILE = 'claude-setup-share.json'

export interface SetupShareOps {
  symlink: (target: string, p: string, type: 'junction' | 'file') => void
  rename: (from: string, to: string) => void
}

export interface SetupShareTarget {
  accountId: string
  configDir: string
  /** The shared source; defaults to `claudeSystemConfigDir()`. Injected by the tests: this module
   *  CREATES LINKS AND MOVES FILES, and a suite run against a real home directory would be one bug
   *  away from editing it. */
  systemDir?: string
  /** The record file; defaults to `<userData>/claude-setup-share.json`. */
  recordFile?: string
  win?: boolean
}

const codeOf = (e: unknown): string =>
  (e as NodeJS.ErrnoException | undefined)?.code ?? (e instanceof Error ? e.message : 'failed')

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function readSystem(dir: string, name: string): SetupSystemEntry {
  const p = path.join(dir, name)
  try {
    // stat, not lstat: a `~/.claude/agents` that is itself a link into a dotfiles repo is a good
    // folder to share, and Claude Code reads it as one.
    const st = statSync(p)
    const kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
    return { kind, real: realOrSelf(p) }
  } catch (e) {
    // A dangling system link is "nothing to share", not a failure.
    return { kind: codeOf(e) === 'ENOENT' ? 'absent' : 'other' }
  }
}

function readAccount(dir: string, name: string): SetupAccountEntry {
  const p = path.join(dir, name)
  let st
  try {
    st = lstatSync(p)
  } catch (e) {
    // Unreadable is `other` — the planner can only ever leave it alone. Never `link`: that is the
    // one classification that can authorise a removal.
    return { kind: codeOf(e) === 'ENOENT' ? 'absent' : 'other' }
  }
  if (st.isSymbolicLink()) {
    let linkTarget: string | undefined
    try {
      linkTarget = readlinkSync(p)
    } catch {
      return { kind: 'other' }
    }
    let real: string | undefined
    try {
      real = realpathSync(p)
    } catch {
      real = undefined // dangling
    }
    return { kind: 'link', linkTarget, real }
  }
  return { kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', real: realOrSelf(p) }
}

/**
 * Only a MISSING record is an empty one. Any other failure — unparseable JSON, EACCES, EBUSY, a
 * folder at the path — THROWS, so the caller reports it and writes nothing: the record holds every
 * account's links, and publishing "empty" over a file we merely could not read would turn every
 * other account's links into "shared-by-you" ones the off-switch can no longer remove.
 */
function readRecordFile(file: string): SetupShareRecordFile {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return { version: 1, accounts: {} }
    throw Object.assign(new Error(`cannot read ${file}`), { code: 'record-unreadable' })
  }
  try {
    return sanitizeSetupShareRecord(JSON.parse(raw))
  } catch {
    throw Object.assign(new Error(`cannot parse ${file}`), { code: 'record-unreadable' })
  }
}

interface ReadState {
  facts: SetupShareFacts
  systemLabel: string
  configDir: string
  setAsidePath: string
  recordFile: string
  win: boolean
}

function readState(t: SetupShareTarget): ReadState {
  const win = t.win ?? process.platform === 'win32'
  const systemDir = t.systemDir ?? claudeSystemConfigDir()
  const sysReal = realOrSelf(systemDir)
  const cfgReal = realOrSelf(t.configDir)
  const setAsidePath = path.join(t.configDir, SET_ASIDE_DIR)
  const recordFile = t.recordFile ?? path.join(platform().userDataDir, SETUP_SHARE_RECORD_FILE)

  let setAsideDir: SetupShareFacts['setAsideDir'] = 'absent'
  try {
    const st = lstatSync(setAsidePath)
    setAsideDir = st.isDirectory() && !st.isSymbolicLink() ? 'dir' : 'other'
  } catch (e) {
    setAsideDir = codeOf(e) === 'ENOENT' ? 'absent' : 'other'
  }

  const system: SetupShareFacts['system'] = {}
  const account: SetupShareFacts['account'] = {}
  const setAside: SetupShareFacts['setAside'] = {}
  for (const { name } of setupItems()) {
    system[name] = readSystem(sysReal, name)
    account[name] = readAccount(t.configDir, name)
    if (setAsideDir === 'dir') {
      try {
        lstatSync(path.join(setAsidePath, name))
        setAside[name] = true
      } catch (e) {
        // Anything but "nothing there" counts as occupied: we must never rename onto it.
        setAside[name] = codeOf(e) !== 'ENOENT'
      }
    }
  }

  let settingsIdentity: SetupShareFacts['settingsIdentity'] = []
  if (system['settings.json']?.kind === 'file') {
    try {
      settingsIdentity = identityKeysIn(readFileSync(path.join(sysReal, 'settings.json'), 'utf8'))
    } catch {
      settingsIdentity = 'unreadable'
    }
  }

  // The record counts only for the SAME directory it was written for: a linked account whose
  // configDir was hand-edited to another folder has no links of ours there.
  const rec = readRecordFile(recordFile).accounts[t.accountId]
  const recorded =
    rec && normalizeLinkPath(rec.dir, win) === normalizeLinkPath(cfgReal, win) ? rec.links : []

  return {
    facts: {
      systemDir: sysReal,
      configDir: cfgReal,
      system,
      account,
      setAside,
      setAsideDir,
      settingsIdentity,
      recorded,
      win
    },
    systemLabel: systemLabelFor(systemDir, win),
    configDir: t.configDir,
    setAsidePath,
    recordFile,
    win
  }
}

function writeRecord(
  file: string,
  accountId: string,
  dir: string,
  links: readonly ClaudeSetupItemName[]
): void {
  const rec = readRecordFile(file)
  const before = JSON.stringify(rec.accounts[accountId] ?? null)
  if (links.length) rec.accounts[accountId] = { dir, links: [...links] }
  else delete rec.accounts[accountId]
  if (JSON.stringify(rec.accounts[accountId] ?? null) === before) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeManagedHookFileAtomic(file, JSON.stringify(rec, null, 2), undefined, 0o600)
}

/** What a reconcile adds to the status of an item: why it was left alone, or what failed. */
type ItemNotes = Partial<Record<ClaudeSetupItemName, Pick<ClaudeSetupShareItem, 'skipped' | 'error'>>>

function report(s: ReadState, notes: ItemNotes = {}): ClaudeSetupShareResult {
  const id = s.facts.settingsIdentity
  return {
    items: describeSetupShare(s.facts).map((item) => ({ ...item, ...notes[item.name] })),
    identityKeys: Array.isArray(id) ? id : [],
    ...(id === 'unreadable' ? { settingsUnreadable: true } : {}),
    systemLabel: s.systemLabel,
    configDir: s.configDir,
    setAsideDir: s.setAsidePath
  }
}

/** The status the Settings row shows on open. Reads only. Never throws. */
export function readSetupShareStatus(t: SetupShareTarget): ClaudeSetupShareResult {
  try {
    const s = readState(t)
    const refused = setupShareRefusal(s.facts)
    const withdrawn = withdrawnAtLaunch.delete(t.accountId)
    const res = refused ? { ...report(s), refused } : report(s)
    return withdrawn ? { ...res, withdrawnAtLaunch: true } : res
  } catch (e) {
    console.warn('[setup-share] status failed', t.configDir, e)
    return { items: [], identityKeys: [], setAsideDir: '', error: codeOf(e) }
  }
}

/** Must be empty right now: a rename onto an existing entry replaces it on POSIX. */
function mustBeAbsent(p: string): void {
  try {
    lstatSync(p)
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return
    throw e
  }
  throw Object.assign(new Error(`${p} is occupied`), { code: 'EEXIST' })
}

function ensureSetAsideDir(p: string): void {
  try {
    mkdirSync(p)
  } catch (e) {
    if (codeOf(e) !== 'EEXIST') throw e
  }
  const st = lstatSync(p)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw Object.assign(new Error(`${p} is not a folder`), { code: 'ENOTDIR' })
  }
}

function removeLink(p: string): void {
  try {
    unlinkSync(p)
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return
    rmdirSync(p) // a Windows junction refuses unlink; rmdir removes the link, never its contents
  }
}

/**
 * Reconcile one account's shared setup to `enabled`. Never throws. `gesture` is who is asking:
 * `'toggle'` (the Settings switch — may set aside and, when OFF, remove and restore) or `'sweep'`
 * (the launch pass replaying a stored `true` — links empty slots, and otherwise only makes the
 * identity guard's withdrawal; see the planner's rule 4).
 */
export function applySetupShare(
  t: SetupShareTarget & {
    enabled: boolean
    gesture: 'toggle' | 'sweep'
    /** Test seam for the failure paths (a Windows EPERM, a rename that fails). Production never
     *  passes it. */
    ops?: Partial<SetupShareOps>
  }
): ClaudeSetupShareResult {
  const symlink = t.ops?.symlink ?? ((target, p, type) => symlinkSync(target, p, type))
  const rename = t.ops?.rename ?? ((from, to) => renameAtomicSync(from, to))
  let s: ReadState
  try {
    s = readState(t)
  } catch (e) {
    console.warn('[setup-share] read failed', t.configDir, e)
    return { items: [], identityKeys: [], setAsideDir: '', error: codeOf(e) }
  }
  try {
    const plan = planSetupShare(s.facts, { enabled: t.enabled, gesture: t.gesture })
    if (plan.refused) return { ...report(s), refused: plan.refused }

    const extra: ItemNotes = {}
    for (const { name, reason } of plan.skipped) extra[name] = { skipped: reason }

    // RECORD FIRST: a link that exists without its record is a link the off-switch will never
    // remove (rule 1 needs both), so the names about to be linked are written down before any link
    // is made. The opposite crash — a name recorded but never linked — removes nothing either: with
    // no link of ours in the slot, the classifier reads the slot as the account's own copy (or as
    // `diverged` only when a set-aside copy proves we moved one), and the next read drops the name.
    const before = new Set<ClaudeSetupItemName>(sanitizeRecorded(s.facts.recorded))
    const union = new Set<ClaudeSetupItemName>([...before, ...plan.recordAfter])
    if (t.enabled) writeRecord(s.recordFile, t.accountId, s.facts.configDir, orderOf(union))

    for (const item of plan.items) {
      // plugins rides with settings.json: when settings.json failed in this run (a Windows file
      // link without Developer Mode, a rename that failed), linking plugins would leave the account
      // on the global plugins with its OWN enabledPlugins.
      if (item.requires && extra[item.requires]?.error) {
        extra[item.name] = { skipped: 'needs-settings' }
        continue
      }
      const p = path.join(s.configDir, item.name)
      const aside = path.join(s.setAsidePath, item.name)
      let setAsideDone = false
      for (const step of item.steps) {
        try {
          if (step === 'set-aside') {
            ensureSetAsideDir(s.setAsidePath)
            mustBeAbsent(aside)
            rename(p, aside)
            setAsideDone = true
          } else if (step === 'link') {
            symlink(item.target, p, item.kind === 'dir' ? 'junction' : 'file')
          } else if (step === 'unlink') {
            // Rule 1 again, on the live entry, at the last moment.
            if (!isOurSetupLink(item.name, readAccount(s.configDir, item.name), s.facts.systemDir, before, s.win)) {
              throw Object.assign(new Error('not a link nodeterm made'), { code: 'not-ours' })
            }
            removeLink(p)
          } else {
            mustBeAbsent(p)
            rename(aside, p)
          }
        } catch (e) {
          extra[item.name] = { ...extra[item.name], error: codeOf(e) }
          console.warn(`[setup-share] ${step} failed`, p, e)
          if (step === 'link' && setAsideDone) {
            // The one rollback: the account's own copy goes straight back where it was.
            try {
              mustBeAbsent(p)
              rename(aside, p)
            } catch (e2) {
              console.warn('[setup-share] could not put back', aside, e2)
            }
          }
          break
        }
      }
    }

    // READ AGAIN and keep exactly the names that are now ours — plus, while ON, a name that reads
    // `diverged` against the record as it stood BEFORE this run, so the row keeps saying so. Not
    // against `union`: a name written down for this run whose link then failed has the account's
    // own copy back in its slot, and keeping it would misreport that copy; nor "anything still in
    // the slot", which would keep a withdrawn settings.json recorded over the restored own copy.
    const after = readState(t)
    const asBefore = { ...after.facts, recorded: [...before] }
    const keep = setupItems().map((i) => i.name).filter(
      (n) =>
        isOurSetupLink(n, after.facts.account[n], after.facts.systemDir, union, after.win) ||
        (t.enabled && classifySetupItem(asBefore, n) === 'diverged')
    )
    writeRecord(s.recordFile, t.accountId, s.facts.configDir, keep)
    if (!t.enabled) {
      try {
        rmdirSync(s.setAsidePath) // only when empty: a leftover copy keeps the folder, by design
      } catch {
        /* not empty, or never existed */
      }
    }
    // The sweep's withdrawal is the one removal nobody asked for at that moment, so it is kept for
    // the renderer to announce (see `withdrawnAtLaunch`). A switch flip is its own announcement.
    if (t.gesture === 'sweep' && extra['settings.json']?.skipped === 'withdrawn-identity' && !extra['settings.json'].error) {
      withdrawnAtLaunch.add(t.accountId)
    } else if (t.gesture === 'toggle') {
      withdrawnAtLaunch.delete(t.accountId)
    }
    return report({ ...after, facts: { ...after.facts, recorded: keep } }, extra)
  } catch (e) {
    console.warn('[setup-share] apply failed', t.configDir, e)
    return { ...report(s), error: codeOf(e) }
  }
}

function orderOf(names: ReadonlySet<ClaudeSetupItemName>): ClaudeSetupItemName[] {
  return setupItems().map((i) => i.name).filter((n) => names.has(n))
}
