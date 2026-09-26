import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ListFilter, X } from 'lucide-react';
import { useFloatingPanel } from '../lib/useFloatingPanel.js';
import { allOptionIds, applyFilters, optionCounts } from '../lib/filters.js';

/**
 * The filter over a list: tick boxes in groups, each option with its icon and
 * how many rows it matches, and Select all / Reset. Options ticked in one
 * group are alternatives; groups narrow each other (see lib/filters.js).
 *
 *   icons: { [optionId]: { icon: LucideIcon, tone: 'ok' | 'bad' | 'warn' | 'info' | 'muted' } }
 */
export function FilterMenu({ groups, rows, selected, onChange, icons = {}, title = 'Filter', allLabel = 'Everyone', counts: suppliedCounts = null, total = null, shown: suppliedShown = null }) {
  const [open, setOpen] = useState(false);
  const { holder, panel, style } = useFloatingPanel(open, setOpen, 'right');
  const counts = suppliedCounts || optionCounts(rows, groups);
  const ticked = new Set(selected);
  // A rare option (say, papers from before something was recorded) is left
  // out while nothing matches it - unless it is ticked, so it can be unticked.
  const listed = groups.map((group) => ({
    ...group,
    options: group.options.filter((option) => !option.rare || counts[option.id] > 0 || ticked.has(option.id))
  }));
  const every = allOptionIds(listed);
  const labels = Object.fromEntries(groups.flatMap((group) => group.options).map((option) => [option.id, option.label]));
  const shown = suppliedShown ?? applyFilters(rows, groups, selected).length;
  const overall = total ?? rows.length;
  const summary = selected.length === 0 ? allLabel : selected.length === 1 ? labels[selected[0]] : `${selected.length} filters`;
  const toggle = (id) => onChange(ticked.has(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

  return (
    <div className="filter-menu" ref={holder}>
      <button
        type="button"
        className={`button button-secondary filter-trigger${selected.length ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${title}: ${summary}`}
        title={`${title}: ${summary}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ListFilter size={16} aria-hidden="true"/>
        <span className="filter-trigger-label toolbar-text">{summary}</span>
        <ChevronDown className="toolbar-chevron" size={15} strokeWidth={2.5} aria-hidden="true"/>
        {/* Shown only when the button is down to its icon: filters are on. */}
        {selected.length > 0 && <span className="filter-trigger-badge" aria-hidden="true">{selected.length}</span>}
      </button>
      {open && createPortal(
        <div ref={panel} className="filter-panel" role="dialog" aria-label={title} style={style}>
          <div className="filter-panel-head">
            <strong>{title}</strong>
            <span>{shown} of {overall} shown</span>
            <button type="button" className="filter-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}>
              <X size={17} aria-hidden="true"/>
            </button>
          </div>
          <div className="filter-groups">
            {listed.map((group) => (
              <fieldset key={group.id} className="filter-group">
                <legend>{group.title}</legend>
                {group.options.map((option) => {
                  const on = ticked.has(option.id);
                  const look = icons[option.id];
                  return (
                    <label key={option.id} className={`filter-option${on ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(option.id)}/>
                      <span className="filter-box" aria-hidden="true">{on && <Check size={13} strokeWidth={3.2}/>}</span>
                      {look && <look.icon className={`filter-icon tone-${look.tone || 'muted'}`} size={16} aria-hidden="true"/>}
                      <span className="filter-label">{option.label}</span>
                      <span className="filter-count">{counts[option.id]}</span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
          <div className="filter-panel-foot">
            <button type="button" className="button button-quiet button-small" disabled={every.every((id) => ticked.has(id))} onClick={() => onChange(every)}>Select all</button>
            <button type="button" className="button button-quiet button-small" disabled={!selected.length} onClick={() => onChange([])}>Reset</button>
            <button type="button" className="button button-primary button-small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
