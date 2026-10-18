import { useEffect, useRef } from 'react';
import { CalendarClock, ChevronRight, House, ListChecks, ShieldCheck, SlidersHorizontal } from 'lucide-react';

/**
 * The settings sections also supply the overview's summary tiles. Overview
 * belongs to navigation separately, so it does not summarize itself.
 */
export const CREATOR_PARTS = [
  { id: 'questions', title: 'Questions', short: 'Questions', icon: ListChecks },
  { id: 'schedule', title: 'Schedule', short: 'Schedule', icon: CalendarClock },
  { id: 'settings', title: 'Question settings', short: 'Settings', icon: SlidersHorizontal },
  { id: 'rules', title: 'Rules', short: 'Rules', icon: ShieldCheck }
];
const CREATOR_SECTIONS = [{ id: 'overview', title: 'Overview', short: 'Home', icon: House }, ...CREATOR_PARTS];

/** A sidebar on larger screens; compact, labelled navigation on phones. */
export function CreatorToggles({ open, onToggle }) {
  const track = useRef(null);
  useEffect(() => {
    const nav = track.current;
    const selected = nav?.querySelector('.is-open');
    if (!nav || !selected) return undefined;
    // Tiny screens can swipe the full labels; a short landscape window has
    // a vertically scrolling rail. Reveal the selected item inside this nav
    // only, without moving the page or the independently scrolling form.
    const reveal = () => {
      const left = selected.offsetLeft;
      const right = left + selected.offsetWidth;
      const top = selected.offsetTop;
      const bottom = top + selected.offsetHeight;
      const nextLeft = left < nav.scrollLeft ? left : right > nav.scrollLeft + nav.clientWidth ? right - nav.clientWidth : nav.scrollLeft;
      const nextTop = top < nav.scrollTop ? top : bottom > nav.scrollTop + nav.clientHeight ? bottom - nav.clientHeight : nav.scrollTop;
      if (nextLeft !== nav.scrollLeft || nextTop !== nav.scrollTop) nav.scrollTo({ left: nextLeft, top: nextTop, behavior: 'auto' });
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [open]);
  return (
    <nav className="creator-toggles" ref={track} aria-label="Parts of the test">
      {CREATOR_SECTIONS.map((part) => (
        <button key={part.id} type="button" id={`${part.id}-toggle`} className={`creator-toggle${open === part.id ? ' is-open' : ''}`}
          aria-label={part.title} title={part.title} aria-expanded={open === part.id} aria-controls={`${part.id}-body`} onClick={() => onToggle(part.id)}>
          <part.icon className="creator-toggle-icon" size={16} aria-hidden="true"/>
          <span className="creator-toggle-long">{part.title}</span>
          <span className="creator-toggle-short">{part.short}</span>
        </button>
      ))}
    </nav>
  );
}

/** A part's icon in its own small square. */
const PartIcon = ({ part }) => (
  <span className="creator-part-icon" aria-hidden="true"><part.icon size={17}/></span>
);

/** The overview: each part's summary, a tap away from opening it. */
export function CreatorGlance({ summaries, onOpen }) {
  return (
    <section className="creator-glance" aria-labelledby="creator-glance-title">
      <h3 id="creator-glance-title">Your test so far</h3>
      <ul>
        {CREATOR_PARTS.map((part) => (
          <li key={part.id}>
            <button type="button" className="creator-glance-row" title={`${part.title}: ${summaries[part.id]}`} onClick={() => onOpen(part.id)}>
              <span className="creator-glance-label">
                <PartIcon part={part}/>
                <strong>{part.title}</strong>
                <ChevronRight size={16} className="creator-glance-caret" aria-hidden="true"/>
              </span>
              <span className="creator-glance-summary">{summaries[part.id]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One section's settings. Closed, they stay in the page,
 * so nothing set is lost and the form still checks them on Create
 * (CreatorScreen opens the part that needs finishing): `data-panel` names it.
 */
export function CreatorPanel({ id, summary, open, children }) {
  const part = CREATOR_SECTIONS.find((item) => item.id === id);
  return (
    <section id={`${id}-body`} className="card creator-panel-body" aria-labelledby={`${id}-title`} hidden={!open} data-panel={id}>
      <header className="creator-panel-top">
        <PartIcon part={part}/>
        <div className="creator-panel-text">
          <h2 id={`${id}-title`}>{part.title}</h2>
          <p>{summary}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/** A group inside a part: its name and one line on what it is for. */
export function CreatorSection({ title, hint }) {
  return (
    <div className="form-wide creator-section">
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}
