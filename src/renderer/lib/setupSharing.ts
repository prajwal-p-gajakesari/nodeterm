// What to tell the user about "Share ~/.claude setup" for one account — after flipping the switch,
// and every time Settings opens. Pure, so every sentence is unit-tested rather than reasoned about.
//
// Two kinds of text, and the split matters: the SUMMARY (what is shared, what is set aside) sits
// under the switch inside the account's folded options, while a WARNING is something the person
// must not miss and is shown on the account row itself. A shared settings.json that a program
// replaced with a regular file (`diverged`) or a ~/.claude/settings.json that now replaces this
// account's login are both silent otherwise: the switch still says "on".
import type {
  ClaudeAccount,
  ClaudeSetupItemName,
  ClaudeSetupShareItem,
  ClaudeSetupShareResult
} from '@shared/types'

export interface SetupShareView {
  summary: string | null
  warnings: string[]
}

const FILE_ITEMS: ReadonlySet<ClaudeSetupItemName> = new Set(['settings.json', 'CLAUDE.md'])

/** "a", "a and b", "a, b and c". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
const isAre = (n: readonly unknown[]): string => (n.length === 1 ? 'is' : 'are')
const itThem = (n: readonly unknown[]): string => (n.length === 1 ? 'it' : 'them')

function errorSentence(item: ClaudeSetupShareItem, enabled: boolean): string {
  const code = item.error ?? 'failed'
  if (code === 'EPERM' && enabled && FILE_ITEMS.has(item.name)) {
    // A folder is a junction and needs no privilege; a FILE link on Windows does. Same wording as
    // the worktree shared-paths EPERM, which hits the identical Windows rule.
    return `${item.name} could not be linked: symlink not permitted (on Windows, enable Developer Mode). This account keeps its own copy.`
  }
  if (code === 'not-ours') {
    return `${item.name} changed while it was being unlinked, so it was left as it is.`
  }
  if (code === 'EEXIST') {
    return `${item.name} was left alone: something is already in the place it would move to.`
  }
  return `${item.name} could not be ${enabled ? 'linked' : 'unlinked'} (${code}).`
}

/** `<src>/settings.json` in the source's own dialect: a Windows `$CLAUDE_CONFIG_DIR` (`C:\…`)
 *  gets a backslash, everything else (including `~/.claude`) a slash. Display only. */
function settingsIn(src: string): string {
  return src.includes('\\') && !src.includes('/') ? `${src}\\settings.json` : `${src}/settings.json`
}

/** Why settings.json cannot be shared, as the tail of a sentence about `<src>/settings.json`. */
function blockedReason(res: ClaudeSetupShareResult, who = 'this account’s'): string {
  return res.identityKeys.length > 0
    ? `sets ${list(res.identityKeys)}, which would replace or redirect ${who} own login`
    : `could not be read as JSON, so it cannot be checked for keys that would replace ${who} login`
}

export function setupShareView(res: ClaudeSetupShareResult, enabled: boolean): SetupShareView {
  const warnings: string[] = []
  // The shared source: `~/.claude`, or the dir `$CLAUDE_CONFIG_DIR` moved it to.
  const src = res.systemLabel ?? '~/.claude'
  if (res.error === 'record-unreadable') {
    return {
      summary: null,
      warnings: [
        'nodeterm could not read its record of shared links (claude-setup-share.json in its data folder), so nothing was changed.'
      ]
    }
  }
  if (res.error) {
    // An empty `items` here is "could not look", never "nothing to share".
    return { summary: null, warnings: [`Setup sharing could not be checked (${res.error}).`] }
  }
  if (res.refused === 'remote-account') {
    return { summary: 'Accounts on an SSH host keep their own setup — nothing was changed.', warnings }
  }
  if (res.refused === 'same-directory') {
    return {
      summary: `This account’s folder is ${src} itself (or inside it), so there is nothing to share.`,
      warnings
    }
  }
  if (res.refused === 'set-aside-unavailable') {
    return {
      summary: null,
      warnings: [`${res.setAsideDir} is not a folder, so nothing was changed. Remove or rename it first.`]
    }
  }

  const by = (pred: (i: ClaudeSetupShareItem) => boolean): ClaudeSetupItemName[] =>
    res.items.filter(pred).map((i) => i.name)
  const shared = by((i) => i.state === 'shared')
  const byYou = by((i) => i.state === 'shared-by-you')
  const diverged = by((i) => i.state === 'diverged')
  const dangling = by((i) => i.state === 'dangling')
  const settings = res.items.find((i) => i.name === 'settings.json')
  const plugins = res.items.find((i) => i.name === 'plugins')
  const identityBlocked = res.identityKeys.length > 0 || !!res.settingsUnreadable

  for (const item of res.items) if (item.error) warnings.push(errorSentence(item, enabled))

  if (enabled) {
    if (res.withdrawnAtLaunch || settings?.skipped === 'withdrawn-identity') {
      // The identity guard's one automatic removal (launch sweep, or an ON pass from the switch).
      warnings.push(
        `settings.json and plugins were unlinked${res.withdrawnAtLaunch ? ' at launch' : ''}: ${settingsIn(src)} ${blockedReason(res)}. This account’s own settings are back. Once that file is safe again, turn this off and on to share them.`
      )
    } else if (identityBlocked && settings?.state === 'shared') {
      // Between a hot-reloaded edit of the shared file and the next ON pass.
      warnings.push(
        `${settingsIn(src)} now ${blockedReason(res)} — Claude Code already reads it in this account. nodeterm unlinks settings.json and plugins at its next launch; turn this off and on to do it now.`
      )
    } else if (identityBlocked) {
      warnings.push(`settings.json and plugins are not shared: ${settingsIn(src)} ${blockedReason(res)}.`)
    }
    if (plugins?.skipped === 'needs-settings') {
      warnings.push(
        'plugins is not shared because settings.json is not — the enabledPlugins that make an installed plugin count are kept there.'
      )
    }
    if (diverged.length) {
      warnings.push(
        `${list(diverged)} ${isAre(diverged)} no longer shared — ${
          diverged.length === 1 ? 'it was' : 'they were'
        } replaced by a regular file in ${res.configDir ?? 'this account’s folder'}. Copy any change you want to keep into ${src}, delete ${itThem(diverged)} there, then turn this off and on again.`
      )
    }
    if (dangling.length) {
      warnings.push(
        `${list(dangling)} ${isAre(dangling)} linked, but ${src} no longer has ${itThem(dangling)}.`
      )
    }
    // Shareable, but the account still holds its own copy: the launch sweep never moves one aside
    // (an item that appeared in the source after the switch went on, a crash before the move).
    const ownButShareable = by(
      (i) =>
        i.state === 'own' &&
        !!i.available &&
        !i.error &&
        i.skipped !== 'set-aside-occupied' &&
        i.skipped !== 'withdrawn-identity'
    )
    if (ownButShareable.length) {
      warnings.push(
        `${list(ownButShareable)} ${isAre(ownButShareable)} not shared: this account has its own copy. Turn this off and on again to share ${itThem(ownButShareable)} (the copy is set aside, not deleted).`
      )
    }
    for (const item of res.items) {
      if (item.skipped === 'set-aside-occupied') {
        warnings.push(
          `${item.name} was not shared: ${res.setAsideDir} already holds a copy of it. Move that copy out first.`
        )
      }
    }

    const parts: string[] = []
    if (shared.length) parts.push(`Sharing ${list(shared)}.`)
    else if (!byYou.length) parts.push(`Nothing in ${src} to share yet.`)
    if (byYou.length) {
      parts.push(`${list(byYou)} already ${byYou.length === 1 ? 'points' : 'point'} at ${src} on ${byYou.length === 1 ? 'its' : 'their'} own.`)
    }
    const aside = by((i) => i.setAside && i.state === 'shared')
    if (aside.length) {
      parts.push(`This account’s own ${list(aside)} ${isAre(aside)} set aside and ${aside.length === 1 ? 'comes' : 'come'} back when you turn this off.`)
    }
    return { summary: parts.join(' '), warnings }
  }

  // OFF. Silence is the normal answer; what is left is something the switch could not finish.
  const stillLinked = [...shared, ...dangling]
  if (stillLinked.length) {
    warnings.push(
      `${list(stillLinked)} ${isAre(stillLinked)} still linked to ${src}. Turn this on and off again to remove ${itThem(stillLinked)}.`
    )
  }
  const notBack = by((i) => i.setAside && i.state !== 'shared' && i.state !== 'dangling')
  if (notBack.length) {
    warnings.push(
      `${list(notBack)} ${notBack.length === 1 ? 'was' : 'were'} not put back: something else is in ${
        notBack.length === 1 ? 'its' : 'their'
      } place now. This account’s earlier copy is in ${res.setAsideDir}.`
    )
  }
  return { summary: null, warnings }
}

/**
 * Once settings have loaded, raise the launch sweep's withdrawals as a toast. The sweep runs in
 * core at boot, before any window exists, so this is the first moment anyone can be told — and the
 * notice matters because the switch still reads "on" afterwards. Core hands each withdrawal out
 * once (the first status read takes it), so a later Settings open does not repeat it. A surface
 * without the method (a relay tab) or a failed read simply raises nothing.
 */
export async function announceSetupShareWithdrawals(
  accounts: readonly ClaudeAccount[],
  status: (id: string) => Promise<ClaudeSetupShareResult>,
  notify: (message: string) => void
): Promise<void> {
  for (const a of accounts) {
    if (a.host || !a.shareSystemSetup) continue
    let res: ClaudeSetupShareResult
    try {
      res = await status(a.id)
    } catch {
      continue
    }
    if (!res.withdrawnAtLaunch) continue
    notify(
      `Stopped sharing settings.json and plugins with “${a.label || a.email || a.id}”: ${
        settingsIn(res.systemLabel ?? '~/.claude')
      } ${blockedReason(res, 'that account’s')}. See Settings → Accounts.`
    )
  }
}
