import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  value: string
  onChange: (v: string) => void
  /** Local branch names to pick from. */
  options: string[]
  /** Shown (muted) when `value` is empty. */
  placeholder: string
  /** Base allows any ref, not just a local branch: a free-text field at the foot of the menu lets
   *  the user type a tag / SHA / `origin/x`. The "existing branch" field leaves this off. */
  allowCustom?: boolean
  /** Placeholder for the free-text ref field (only shown when `allowCustom`). */
  customPlaceholder?: string
  /** How an option reads, when its value is an id rather than a name (the worktree dialog's agent
   *  picker: `custom:<uuid>` must show as the agent's label). Default: the value itself. */
  optionLabel?: (value: string) => string
}

/**
 * A dark-theme dropdown that matches the app's own menus (`.tab-menu`) rather than a browser-default
 * `<select>`. It reuses the Source Control branch switcher's approach: a field-styled trigger opens a
 * portaled, anchored list, closed by a full-screen `.tab-backdrop`. Portaling to `document.body`
 * escapes the dialog's overflow/stacking context, and z-index 78/80 clears the dialog overlay (70).
 */
export function BranchSelect({
  value,
  onChange,
  options,
  placeholder,
  allowCustom,
  customPlaceholder,
  optionLabel = (v) => v
}: Props) {
  const [menu, setMenu] = useState<{ top: number; left: number; width: number } | null>(null)
  const [custom, setCustom] = useState('')

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ top: r.bottom + 4, left: r.left, width: r.width })
    setCustom('')
  }
  const pick = (v: string) => {
    onChange(v)
    setMenu(null)
  }

  return (
    <>
      <button type="button" className="bind-select" onClick={open}>
        <span className={value ? 'bind-select__val' : 'bind-select__ph'}>
          {value ? optionLabel(value) : placeholder}
        </span>
        <span className="bind-select__chev">⌄</span>
      </button>
      {menu &&
        createPortal(
          <>
            {/* Full-screen click-catcher (the app's menu idiom — no document listener). It sits above
                the dialog overlay, so a click near the dialog closes the menu instead of the dialog. */}
            <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={() => setMenu(null)} />
            <div
              className="tab-menu bind-select__menu"
              style={{ top: menu.top, left: menu.left, minWidth: menu.width, zIndex: 80 }}
            >
              {options.map((b) => (
                <button type="button" key={b} onClick={() => pick(b)}>
                  <span className="tab-menu__check">{b === value ? '✓' : ''}</span>
                  {optionLabel(b)}
                </button>
              ))}
              {allowCustom && (
                <>
                  <div className="ctx-sep" />
                  <input
                    className="tab__edit"
                    placeholder={customPlaceholder ?? 'type a ref…'}
                    value={custom}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && custom.trim()) {
                        e.preventDefault()
                        pick(custom.trim())
                      }
                    }}
                  />
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
