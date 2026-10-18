import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ListFilter, X } from 'lucide-react';
import { useFloatingPanel } from '../lib/useFloatingPanel.js';
import { allOptionIds, applyFilters, optionCounts, packColumns } from '../lib/filters.js';
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar.js';

/**
 * Columns for the panel's groups at this window width: one on a phone (the
 * panel is a sheet there), three where there is room. Packed short
 * (packColumns), a panel with four groups is no taller than one with two, so
 * both open beside their button in the same windows.
 */
const columnCount = (width) => (width <= 560 ? 1 : width >= 1180 ? 4 : width >= 820 ? 3 : 2);

/**
 * The filter over a list: tick boxes in groups, each option with its icon and
 * how many rows it matches, and Select all / Reset. Options ticked in one
 * group are alternatives; groups narrow each other (see lib/filters.js).
 *
 *   icons: { [optionId]: { icon: LucideIcon, tone: 'ok' | 'bad' | 'warn' | 'info' | 'muted' } }
 *
 * With `sorts` the panel also sets the list's order, as a "Sort by" group of
 * its own: a field, and which way round - every order can be reversed.
 *
 *   sorts: [{ id, label, icon, directions: [{ id: 'asc' | 'desc', label }] }]
 *   sort:  'field-direction'. The first field's first direction is the usual
 *          order; choosing a field starts with its first direction.
 *
 * `extra` is a control of the list's own drawn above the groups (the
 * Analysis tab's marks range); `extraActive` says how many filters it holds,
 * `extraLabel` names it when it is the only one, and Reset calls `onReset`.
 * `sections`: custom { id, title, content, weight } blocks within the scrolling
 * columns (attendance's calendar). Weight estimates their height for packing.
 * `autoHideScrollbar`: opt in to the slim, activity-only blue scrollbar.
 */
export function FilterMenu({
  groups, rows, selected, onChange, icons = {}, title = 'Filter', allLabel = 'Everyone',
  counts: suppliedCounts = null, total = null, shown: suppliedShown = null,
  sorts = null, sort = null, onSort = () => {}, sortHint = null,
  extra = null, extraActive = 0, extraLabel = null, onReset = null, sections = [], autoHideScrollbar = false
}) {
  const [open, setOpen] = useState(false);
  const scrollActivity = useAutoHideScrollbar();
  const { holder, panel, style, isDialog, reposition } = useFloatingPanel(open, setOpen, 'right', { dialog: true });
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    if (!open) return undefined;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

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
  const active = selected.length + extraActive;
  const summary = active === 0 ? allLabel
    : active === 1 ? (selected.length ? labels[selected[0]] : extraLabel || '1 filter')
      : `${active} filters`;
  const toggle = (id) => onChange(ticked.has(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  const usualSort = sorts ? `${sorts[0].id}-${sorts[0].directions[0].id}` : null;
  const [fieldId, wayId] = String(sort || usualSort || '').split('-');
  const field = sorts?.find((option) => option.id === fieldId) || sorts?.[0];
  const way = field?.directions.find((option) => option.id === wayId) || field?.directions[0];
  const sorted = Boolean(sorts && sort && sort !== usualSort);
  const described = `${title}: ${summary}${sorted ? `, ${field.label} ${way.label}` : ''}`;

  // Its fields, its heading and the direction switch under them.
  // Optional custom controls share the scrollable area, so even a short phone can reach Done.
  const blocks = [...(sorts ? [{ id: 'sort', title: 'Sort by', options: sorts, isSort: true, weight: sorts.length + (sortHint ? 4 : 2) }, ...listed] : listed), ...sections];
  const columns = packColumns(blocks, columnCount(width));
  const layoutKey = sections.map((section) => `${section.id}:${section.weight}`).join(',');
  // Columns or a custom control's height changing can move the panel.
  useLayoutEffect(() => { if (open) reposition(); }, [open, columns.length, layoutKey, reposition]);

  const block = (group) => (
    <fieldset key={group.id} className={`filter-group${group.isSort ? ' filter-sort' : ''}`}>
      <legend>{group.title}</legend>
      {group.content ? group.content : group.isSort ? <>
        {group.options.map((option) => {
          const on = field.id === option.id;
          return (
            <label key={option.id} className={`filter-option${on ? ' is-on' : ''}`}>
              <input type="radio" name={`${title}-sort`} checked={on} onChange={() => onSort(`${option.id}-${option.directions[0].id}`)}/>
              <span className="filter-radio" aria-hidden="true"/>
              {option.icon && <option.icon className="filter-icon tone-info" size={16} aria-hidden="true"/>}
              <span className="filter-label">{option.label}</span>
            </label>
          );
        })}
        {/* Which way round, for the field chosen above. */}
        <div className="filter-direction" role="radiogroup" aria-label={`${field.label}: order`}>
          {field.directions.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={option.id === way.id} className={option.id === way.id ? 'is-on' : undefined}
              onClick={() => onSort(`${field.id}-${option.id}`)}>
              {option.label}
            </button>
          ))}
        </div>
        {sortHint && <p className="filter-sort-hint">{sortHint}</p>}
      </> : group.options.map((option) => {
        const on = ticked.has(option.id);
        const look = icons[option.id];
        return (
          <label key={option.id} className={`filter-option${on ? ' is-on' : ''}`}>
            <input type="checkbox" checked={on} onChange={() => toggle(option.id)}/>
            <span className="filter-box" aria-hidden="true">{on && <Check size={13} strokeWidth={3.2}/>}</span>
            {look && <look.icon className={`filter-icon tone-${look.tone || 'muted'}`} size={16} aria-hidden="true"/>}
            {/* A label too long for a narrow column is cut with …; the whole of it on hover. */}
            <span className="filter-label" title={option.label}>{option.label}</span>
            <span className="filter-count">{counts[option.id]}</span>
          </label>
        );
      })}
    </fieldset>
  );

  return (
    <div className="filter-menu" ref={holder}>
      <button
        type="button"
        className={`button button-secondary filter-trigger${active || sorted ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={described}
        title={described}
        onClick={() => setOpen((value) => !value)}
      >
        <ListFilter size={16} aria-hidden="true"/>
        <span className="filter-trigger-label toolbar-text">{summary}</span>
        <ChevronDown className="toolbar-chevron" size={15} strokeWidth={2.5} aria-hidden="true"/>
        {/* Shown only when the button is down to its icon: filters are on. */}
        {active > 0 && <span className="filter-trigger-badge" aria-hidden="true">{active}</span>}
      </button>
      {open && createPortal(<>
        {/* Beside its button when it fits there. When it does not - and always on
            a phone - it opens over the blurred page instead: centred, or as a
            sheet from the bottom (filters.css). A tap on the page closes it. */}
        {isDialog && <div className="filter-backdrop" data-panel-backdrop="" aria-hidden="true" onClick={() => setOpen(false)}/>}
        <div ref={panel} className={`filter-panel cols-${columns.length}${isDialog ? ' is-dialog' : ''}`} role="dialog" aria-label={title} style={style}>
          <div className="filter-panel-head">
            <strong>{title}</strong>
            <span>{shown} of {overall} shown</span>
            <button type="button" className="filter-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}>
              <X size={17} aria-hidden="true"/>
            </button>
          </div>
          {extra && <div className="filter-extra">{extra}</div>}
          <div className={`filter-groups${autoHideScrollbar ? ' auto-hide-scrollbar' : ''}`} {...(autoHideScrollbar ? scrollActivity : {})}>
            {columns.map((column) => <div key={column[0].id} className="filter-col">{column.map(block)}</div>)}
          </div>
          <div className="filter-panel-foot">
            <button type="button" className="button button-quiet button-small" disabled={every.every((id) => ticked.has(id))} onClick={() => onChange(every)}>Select all</button>
            <button type="button" className="button button-quiet button-small" disabled={!active && !sorted}
              onClick={() => { onChange([]); onReset?.(); if (sorted) onSort(usualSort); }}>Reset</button>
            <button type="button" className="button button-primary button-small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}
