import { useEffect, useState } from 'react';
import { ArrowRight, ChartColumn, CircleCheck, ClipboardList, PenLine, Plus, QrCode, Radio, UserCheck, Users } from 'lucide-react';
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
    const list = tests.tests || [];
    const sessions = attendance.sessions || [];
    return {
      tests: { total: list.filter((test) => !test.archivedAt).length, live: list.filter((test) => test.isStarted && !test.isClosed).length, pending: sum(list, 'pendingCount') },
      results: { submitted: sum(list, 'submittedCount'), toMark: null },
      attendance: { sessions: sessions.length, open: sessions.filter((session) => session.isOpen).length },
      users: null
    };
  }
}

/**
 * The faculty home page: what needs you now, then the way into each part of
 * the portal - Tests, Attendance, Results and (for those allowed) Users -
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

  const firstName = String(user?.name || '').trim().split(/\s+/)[0];
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const loading = summary === undefined;
  const s = summary || null;
  const link = (url) => (event) => { event.preventDefault(); go(url); };

  // What is waiting on the teacher, most urgent first.
  const attention = s ? [
    s.tests.pending > 0 && { icon: UserCheck, tone: 'warn', text: `${plural(s.tests.pending, 'registration')} to approve`, url: '/?admin=tests' },
    s.results.toMark > 0 && { icon: PenLine, tone: 'warn', text: `${plural(s.results.toMark, 'paper')} to mark`, url: '/?page=results' },
    s.tests.live > 0 && { icon: Radio, tone: 'ok', text: `${plural(s.tests.live, 'test')} live now`, url: '/?admin=tests' },
    s.attendance.open > 0 && { icon: QrCode, tone: 'ok', text: `Attendance open (${s.attendance.open})`, url: '/?admin=attendance' }
  ].filter(Boolean) : [];

  const cards = [
    {
      id: 'tests', title: 'Tests', icon: ClipboardList, tone: 'info', url: '/?admin=tests',
      about: 'Create tests, run them live and follow every student.',
      figures: [[s?.tests.total, 'tests'], [s?.tests.live, 'live']],
      action: { label: 'New test', url: '/?admin=create' }
    },
    {
      id: 'attendance', title: 'Attendance', icon: QrCode, tone: 'ok', url: '/?admin=attendance',
      about: 'Show a QR in class; students scan it to mark themselves.',
      figures: [[s?.attendance.sessions, 'sessions'], [s?.attendance.open, 'open']],
      action: { label: 'Take attendance', url: '/?admin=attendance&new=1' }
    },
    {
      id: 'results', title: 'Results', icon: ChartColumn, tone: 'warn', url: '/?page=results',
      about: 'Scores and answers from every test, ready to download.',
      figures: [[s?.results.submitted, 'submitted'], [s?.results.toMark, 'to mark']]
    },
    // Shown from who is signed in - never hidden because a number did not load.
    user?.canManageUsers && {
      id: 'users', title: 'Users', icon: Users, tone: 'muted', url: '/?admin=users',
      about: 'Accounts, names and SAP IDs, blocking and access.',
      figures: [[s?.users?.accounts, 'accounts'], [s?.users?.students, 'students'], [s?.users?.faculty, 'faculty']]
    }
  ].filter(Boolean);

  return (
    <section className="faculty-home">
      <header className="faculty-home-head">
        <h1>{firstName ? `Welcome, ${firstName}` : 'Welcome'}</h1>
        <p>{today}</p>
      </header>

      {/* Waits quietly while loading, and is left out if the numbers cannot be had. */}
      {s && (
        <div className={`home-attention${attention.length ? '' : ' is-clear'}`} aria-live="polite">
          {attention.length ? attention.map((item) => (
            <a key={item.text} className={`home-chip is-${item.tone}`} href={item.url} onClick={link(item.url)}>
              <item.icon size={15} aria-hidden="true"/>{item.text}<ArrowRight size={14} aria-hidden="true"/>
            </a>
          )) : <span className="home-attention-note"><CircleCheck size={16} aria-hidden="true"/>Nothing needs you right now.</span>}
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
                <span className="home-card-text">
                  <strong>{card.title}</strong>
                  <span>{card.about}</span>
                </span>
                <ArrowRight className="home-card-go" size={18} aria-hidden="true"/>
              </a>
              <footer className="home-card-foot">
                {loading ? <span className="home-figures-loading" aria-hidden="true"><i/><i/></span> : known.length > 0 && (
                  <dl className="home-figures">
                    {known.map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
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
