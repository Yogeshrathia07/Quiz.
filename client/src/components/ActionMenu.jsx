import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useFloatingPanel } from '../lib/useFloatingPanel.js';

/**
 * A dropdown for the actions that would otherwise crowd a toolbar or a table
 * row. Closes on choosing an item, on Escape, and on a click outside, so it
 * never strands the page behind an open menu. The list floats on <body>
 * against the button (see useFloatingPanel), so no table clips it.
 *
 * `items` entries may be falsy - the caller can inline conditions without
 * building the array first. An item is coloured by what it does: `tone`
 * 'ok' (green: keeps or approves), 'info' (blue: adjusts), 'warn' (amber:
 * starts over), or `danger` (red: wipes or refuses). With an `icon`, a toolbar too narrow for words
 * can show the button as just that icon (theme.css); the label stays its
 * name and tooltip.
 */
export function ActionMenu({ label = 'Actions', items, disabled = false, align = 'right', trigger = 'button', icon: Icon = null }) {
  const [open, setOpen] = useState(false);
  const { holder, panel, style } = useFloatingPanel(open, setOpen, align);
  const visible = (items || []).filter(Boolean);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  if (!visible.length) return null;

  return (
    <div className="action-menu" ref={holder}>
      <button
        type="button"
        className={trigger === 'icon' ? 'button icon-button' : 'button button-secondary button-small'}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={Icon && typeof label === 'string' ? label : undefined}
        title={Icon && typeof label === 'string' ? label : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {Icon && <Icon size={16} aria-hidden="true"/>}
        {Icon ? <span className="toolbar-text">{label}</span> : label}
        {trigger !== 'icon' && <> <ChevronDown className="toolbar-chevron" size={15} strokeWidth={2.5} aria-hidden="true"/></>}
      </button>
      {open && createPortal(
        <div ref={panel} className="menu-items menu-floating" role="menu" style={style}>
          {visible.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'danger' : item.tone ? `is-${item.tone}` : undefined}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.icon && <item.icon size={16} aria-hidden="true"/>}
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
