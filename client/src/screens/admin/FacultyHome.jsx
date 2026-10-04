import { useEffect, useState } from 'react';
import { ArrowRight, CircleCheck, ClipboardList, PenLine, Plus, QrCode, Radio, UserCheck, Users } from 'lucide-react';
import { api } from '../../lib/api.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const sum = (list, field) => list.reduce((total, entry) => total + (Number(entry[field]) || 0), 0);
/** Refreshed while the page is open, so "live" and "to mark" stay true. */
const REFRESH_MS = 30_000;

/**
 * The numbers, from the one small request made for this page. A server not
 * yet restarted onto it answers "not found": the lists the Tests and
 * Attendance pages use still give most of them. What neither gives stays
 * unknown (null) and is simply not shown.
 */
async function loadSummary() {
  try {
    return await api('/api/admin/home');
  } catch {
    const [tests, attendance] = await Promise.all([api('/api/admin/tests'), api('/api/admin/attendance')]);
    // Archived tests count for nothing, as on the server.
    const list = (tests.tests || []).filter((test) => !test.archivedAt);
    const sessions = attendance.sessions || [];
    return {
      tests: { total: list.length, live: list.filter((test) => test.isStarted && !test.isClosed).length, pending: sum(list, 'pendingCount') },
      results: { submitted: sum(list, 'submittedCount'), toMark: null },
      attendance: { sessions: sessions.length, open: sessions.filter((session) => session.isOpen).length },
      users: null
    };
  }
}

/**
 * The faculty home page: what needs you now, then the way into each part of
 * the portal - Tests (results and marking included), Attendance and (for those allowed) Users -
 * each with its key numbers and its most common action. Nothing of any one
 * part lives here; each has its own page.
 */
export function FacultyHome({ user, go }) {
  // undefined while loading; false when the numbers cannot be had at all.
  const [summary, setSummary] = useState(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => loadSummary().then(
      (data) => { if (alive) setSummary(data); },
      () => { if (alive) setSummary((current) => current || false); }
    );
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  // "Welcome, Asha" - but a name that opens with a title keeps it whole: "Welcome, Dr. Asha Verma", never "Welcome, Dr.".
  const names = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = /^(dr|prof|professor|mr|mrs|ms|miss|er)\.?$/i.test(names[0] || '') && names.length > 1 ? names.join(' ') : names[0];
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const loading = summary === undefined;
  const s = summary || null;
  const link = (url) => (event) => { event.preventDefault(); go(url); };

  // What is waiting on the teacher, most urgent first - each opens the tests it is about.
  const attention = s ? [
    s.tests.pending > 0 && { icon: UserCheck, tone: 'warn', text: `${plural(s.tests.pending, 'registration')} to approve`, url: '/?admin=tests&filter=requests:waiting' },
    s.results.toMark > 0 && { icon: PenLine, tone: 'warn', text: `${plural(s.results.toMark, 'paper')} to mark`, url: '/?admin=tests&filter=marking:due' },
    s.tests.live > 0 && { icon: Radio, tone: 'ok', text: `${plural(s.tests.live, 'test')} live now`, url: '/?admin=tests&filter=status:live' },
    s.attendance.open > 0 && { icon: QrCode, tone: 'ok', text: `Attendance open (${s.attendance.open})`, url: '/?admin=attendance' }
  ].filter(Boolean) : [];

  // Each figure: [value, label, tone when above zero - a number that waits on you stands out].
  const cards = [
    // Everything a test needs - running it, marking, its results - is under Tests.
    {
      id: 'tests', title: 'Tests', icon: ClipboardList, tone: 'info', url: '/?admin=tests',
      figures: [[s?.tests.total, 'tests'], [s?.tests.live, 'live', 'ok'], [s?.results.toMark, 'to mark', 'warn']],
      action: { label: 'New test', url: '/?admin=create' }
    },
    {
      id: 'attendance', title: 'Attendance', icon: QrCode, tone: 'ok', url: '/?admin=attendance',
      figures: [[s?.attendance.sessions, 'sessions'], [s?.attendance.open, 'open', 'ok']],
      action: { label: 'Take attendance', url: '/?admin=attendance&new=1' }
    },
    // Shown from who is signed in - never hidden because a number did not load.
    user?.canManageUsers && {
      id: 'users', title: 'Users', icon: Users, tone: 'muted', url: '/?admin=users',
      figures: [[s?.users?.accounts, 'accounts'], [s?.users?.students, 'students'], [s?.users?.faculty, 'faculty']]
    }
  ].filter(Boolean);

  return (
    <section className="faculty-home">
      {/* The greeting, and beside it what needs you: a chip each, or a small tick when nothing does.
          Both wait quietly while loading, and are left out if the numbers cannot be had. */}
      <header className="faculty-home-head">
        <h1>{firstName ? `Welcome, ${firstName}` : 'Welcome'}</h1>
        <p className="faculty-home-date">
          {s && !attention.length && (
            <span className="home-all-clear" role="img" aria-label="Nothing needs you right now" title="Nothing needs you right now">
              <CircleCheck size={18} aria-hidden="true"/>
            </span>
          )}
          {today}
        </p>
      </header>
      {attention.length > 0 && (
        <div className="home-attention" aria-live="polite">
          {attention.map((item) => (
            <a key={item.text} className={`home-chip is-${item.tone}`} href={item.url} onClick={link(item.url)}>
              <item.icon size={15} aria-hidden="true"/>{item.text}<ArrowRight size={14} aria-hidden="true"/>
            </a>
          ))}
        </div>
      )}

      <div className={`home-cards has-${cards.length}`}>
        {cards.map((card) => {
          // Only numbers that are known: none is ever shown as a dash or dots.
          const known = card.figures.filter(([value]) => Number.isFinite(value));
          return (
            <article key={card.id} className={`home-card is-${card.tone}`}>
              {/* The whole card opens its section; the action below it is a second, separate way in. */}
              <a className="home-card-main" href={card.url} onClick={link(card.url)}>
                <span className="home-card-icon"><card.icon size={22} aria-hidden="true"/></span>
                <strong className="home-card-title">{card.title}</strong>
                <ArrowRight className="home-card-go" size={18} aria-hidden="true"/>
              </a>
              <footer className="home-card-foot">
                {loading ? <span className="home-figures-loading" aria-hidden="true"><i/><i/></span> : known.length > 0 && (
                  <dl className="home-figures">
                    {known.map(([value, label, tone]) => (
                      <div key={label} className={tone && value > 0 ? `is-${tone}` : undefined}><dt>{label}</dt><dd>{value}</dd></div>
                    ))}
                  </dl>
                )}
                {card.action && (
                  <a className="button button-secondary button-small home-card-action" href={card.action.url} onClick={link(card.action.url)}>
                    <Plus size={15} aria-hidden="true"/>{card.action.label}
                  </a>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
