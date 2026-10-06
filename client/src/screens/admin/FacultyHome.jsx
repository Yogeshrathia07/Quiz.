import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarClock, ClipboardList, Lock, PenLine, Plus, QrCode, Send, UserCheck, Users } from 'lucide-react';
import { loadCached, useCached } from '../../lib/cache.js';
import { clockTime, shortDateTime } from '../../lib/format.js';
import { papersToMark } from './test-filters.js';
import { sessionUrl } from '../attendance/attendance-paths.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Refreshed while the page is open, so "live" and "to mark" stay true. */
const REFRESH_MS = 30_000;
const testUrl = (test, rest = '') => `/?admin=${encodeURIComponent(test.code)}${rest}`;

/**
 * Everything the page shows, from three small requests made together. One
 * that fails leaves only its own part out; the rest still shows.
 */
/** What the home page reads, asked for together. The quiz and attendance lists are the same ones their own pages show. */
const HOME_PATHS = ['/api/admin/home', '/api/admin/tests', '/api/admin/attendance'];
/** One reply: undefined while it is on its way the first time, null if it could not be had. */
const settled = (reply) => (reply.data !== undefined ? reply.data : reply.error ? null : undefined);

/** "Good morning, Asha" - a name that opens with a title keeps it whole: "Dr. Asha Verma", never "Dr.". */
function greeting(user, now = new Date()) {
  const names = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
  const name = /^(dr|prof|professor|mr|mrs|ms|miss|er)\.?$/i.test(names[0] || '') && names.length > 1 ? names.join(' ') : names[0];
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

/** When a live test ends, in a few words. */
function endsOf(test) {
  if (test.endMode === 'each') return `${test.durationMinutes} min each`;
  return test.endsAt && !test.untimed ? `ends ${clockTime(test.endsAt)}` : 'no end time';
}

/** Marks never released by hand on a test that has ended with papers in. */
const marksWaiting = (test) => test.isClosed && test.resultReleaseMode === 'admin' && !test.resultsReleasedAt && test.submittedCount > 0;

/**
 * Everything waiting on the teacher, a line each with its button: students to
 * let in, papers to mark, marks to release, attendance marks to confirm.
 */
function needsOf(tests, sessions) {
  const items = [];
  for (const test of tests || []) {
    if (test.pendingCount > 0) {
      items.push({ key: `${test.code}-pending`, icon: UserCheck, tone: 'warn', text: `${plural(test.pendingCount, 'student')} waiting for approval`, where: test.title, action: 'Approve', url: testUrl(test, '&tab=students&students=pending') });
    }
    if (papersToMark(test) > 0) {
      items.push({ key: `${test.code}-mark`, icon: PenLine, tone: 'warn', text: `${plural(papersToMark(test), 'paper')} to mark`, where: test.title, action: 'Mark', url: testUrl(test, '&tab=responses&results=marking:awaiting') });
    }
    if (marksWaiting(test)) {
      items.push({ key: `${test.code}-release`, icon: Send, tone: 'info', text: 'Marks not released yet', where: test.title, action: 'Release', url: testUrl(test) });
    }
  }
  for (const session of sessions || []) {
    if (session.pendingCount > 0) {
      items.push({ key: `${session.code}-attendance`, icon: QrCode, tone: 'warn', text: `${plural(session.pendingCount, 'attendance mark')} to confirm`, where: session.title, action: 'Review', url: sessionUrl(session.code) });
    }
  }
  return items;
}

/** The line under the greeting: what is happening, in one sentence. */
function statusLine(live, openSessions, needs) {
  if (live.length) {
    const test = live[0];
    const writing = Math.max(0, (test.startedCount || 0) - (test.submittedCount || 0));
    return `${test.title} is live — ${writing} writing, ${test.submittedCount || 0} submitted${live.length > 1 ? `, and ${plural(live.length - 1, 'more test')} live` : ''}.`;
  }
  if (openSessions.length) return `Attendance is open for ${openSessions[0].title}.`;
  if (needs.length) return `${plural(needs.length, 'thing')} ${needs.length === 1 ? 'needs' : 'need'} you — see below.`;
  return 'Nothing is live right now. Start a test or open an attendance session.';
}

/** A clipboard of ticks beside a QR code: the two things this portal does. Drawing only, in the theme's colours. */
function HomeArt() {
  return (
    <svg className="home-hero-art" viewBox="0 0 220 150" aria-hidden="true" focusable="false">
      <circle cx="140" cy="76" r="54" className="art-halo"/>
      <circle cx="58" cy="30" r="3.5" className="art-dot"/>
      <circle cx="204" cy="112" r="4" className="art-dot is-blue"/>
      <path d="M196 26v14M189 33h14" className="art-plus"/>
      <rect x="104" y="30" width="72" height="96" rx="10" className="art-board"/>
      <rect x="124" y="22" width="32" height="14" rx="5" className="art-clip"/>
      <path d="M118 58l6 6 10-12M118 82l6 6 10-12" className="art-tick"/>
      <path d="M142 58h22M142 82h22M142 106h22" className="art-line"/>
      <rect x="117" y="98" width="13" height="13" rx="3" className="art-box"/>
      <rect x="22" y="70" width="42" height="42" rx="9" className="art-qr-frame"/>
      <path d="M31 79h9v9h-9zM46 79h9v9h-9zM31 94h9v9h-9zM48 96h3v3h-3zM53 101h2v2h-2z" className="art-qr"/>
    </svg>
  );
}

/**
 * The faculty home page: a greeting with what is happening and the two
 * usual actions, then your numbers. Anything running now (a test,
 * attendance), anything waiting on you and anything coming up appear only
 * while there is some - a quiet day is just the greeting and the numbers.
 */
export function FacultyHome({ user, go }) {
  // Shown at once when seen before (lib/cache.js), asked again behind, and every half minute.
  const home = useCached(HOME_PATHS[0]);
  const list = useCached(HOME_PATHS[1]);
  const register = useCached(HOME_PATHS[2]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      HOME_PATHS.forEach((path) => { loadCached(path, { force: true }).catch(() => {}); });
      setNow(new Date());
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  // undefined while loading: all three answered (or failed) at least once.
  const replies = [settled(home), settled(list), settled(register)];
  const data = useMemo(() => (replies.includes(undefined) ? undefined : {
    summary: replies[0],
    tests: replies[1] ? (replies[1].tests || []).filter((test) => !test.archivedAt) : null,
    sessions: replies[2] ? replies[2].sessions || [] : null
  }), replies); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (url) => (event) => { event.preventDefault(); go(url); };
  const loading = data === undefined;
  const tests = data?.tests || null;
  const sessions = data?.sessions || null;
  const summary = data?.summary || null;
  const live = (tests || []).filter((test) => test.isStarted && !test.isClosed);
  const openSessions = (sessions || []).filter((session) => session.isOpen);
  const needs = needsOf(tests, sessions);
  const toMark = summary?.results?.toMark ?? (tests || []).reduce((sum, test) => sum + papersToMark(test), 0);
  const upcoming = (tests || [])
    .filter((test) => !test.isStarted && test.startMode === 'scheduled' && test.opensAt && Date.parse(test.opensAt) > now.getTime())
    .sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt))
    .slice(0, 3);
  const stats = [
    {
      id: 'tests', icon: ClipboardList, tone: 'info', url: '/?admin=tests',
      value: tests?.length ?? summary?.tests?.total, label: ['Test', 'Tests'],
      line: [[`${live.length} live`], [`${toMark} to mark`, toMark > 0 && 'warn']]
    },
    {
      id: 'attendance', icon: QrCode, tone: 'ok', url: '/?admin=attendance',
      value: sessions?.length ?? summary?.attendance?.sessions, label: ['Attendance session', 'Attendance sessions'],
      line: [[`${openSessions.length} open`]]
    },
    user?.canManageUsers && summary?.users && {
      id: 'users', icon: Users, tone: 'violet', url: '/?admin=users',
      value: summary.users.students, label: ['Student', 'Students'],
      line: [[`${summary.users.faculty} faculty`], [`${summary.users.accounts} accounts`]]
    }
  ].filter(Boolean);
  const today = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <section className="faculty-home">
      <header className="home-hero">
        <div className="home-hero-text">
          <p className="home-hero-date">{today}</p>
          <h1>{greeting(user, now)}</h1>
          <p className="home-hero-line">{loading ? ' ' : statusLine(live, openSessions, needs)}</p>
          <div className="home-hero-actions">
            <a className="button button-primary" href="/?admin=create" onClick={link('/?admin=create')}><Plus size={17} aria-hidden="true"/>New test</a>
            <a className="button button-secondary" href="/?admin=attendance&new=1" onClick={link('/?admin=attendance&new=1')}><QrCode size={17} aria-hidden="true"/><span className="home-action-long">Take attendance</span><span className="home-action-short">Attendance</span></a>
          </div>
        </div>
        <HomeArt/>
      </header>

      {/* Running right now: a test being written, or attendance being taken - one tap from following it. */}
      {(live.length > 0 || openSessions.length > 0) && (
        <section className="home-live" aria-label="Live now">
          {live.map((test) => {
            const writing = Math.max(0, (test.startedCount || 0) - (test.submittedCount || 0));
            const figures = [[writing, 'writing'], [test.submittedCount || 0, 'submitted'], [test.pendingCount || 0, 'waiting', 'warn'], [test.lockedCount || 0, 'locked', 'bad']]
              .filter(([value], index) => index < 2 || value > 0);
            return (
              <a key={test.code} className="home-live-item" href={testUrl(test, '&tab=students')} onClick={link(testUrl(test, '&tab=students'))}>
                <span className="home-live-dot" aria-hidden="true"/>
                <span className="home-live-text">
                  <small>Live now · {endsOf(test)}</small>
                  <strong>{test.title}</strong>
                </span>
                <span className="home-live-figures">
                  {figures.map(([value, label, tone]) => (
                    <span key={label} className={tone && value > 0 ? `is-${tone}` : undefined}>
                      {label === 'locked' && <Lock size={13} aria-hidden="true"/>}<strong>{value}</strong>{label}
                    </span>
                  ))}
                </span>
                <span className="home-live-go">Follow<ArrowRight size={15} aria-hidden="true"/></span>
              </a>
            );
          })}
          {openSessions.map((session) => (
            <a key={session.code} className="home-live-item" href={sessionUrl(session.code)} onClick={link(sessionUrl(session.code))}>
              <span className="home-live-dot" aria-hidden="true"/>
              <span className="home-live-text">
                <small>Attendance open{session.round > 1 ? ` · round ${session.round}` : ''}</small>
                <strong>{session.title}</strong>
              </span>
              <span className="home-live-figures">
                <span><strong>{session.presentCount || 0}</strong>present</span>
                {session.pendingCount > 0 && <span className="is-warn"><strong>{session.pendingCount}</strong>to confirm</span>}
              </span>
              <span className="home-live-go">Open<ArrowRight size={15} aria-hidden="true"/></span>
            </a>
          ))}
        </section>
      )}

      <div className={`home-stats has-${stats.length}`}>
        {stats.map((stat) => (
          <a key={stat.id} className={`home-stat is-${stat.tone}`} href={stat.url} onClick={link(stat.url)}>
            <span className="home-stat-top">
              <span className="home-stat-icon" aria-hidden="true"><stat.icon size={18}/></span>
              <ArrowRight className="home-stat-go" size={16} aria-hidden="true"/>
            </span>
            {loading ? <span className="home-loading-line" aria-hidden="true"/> : (
              <>
                <span className="home-stat-value"><strong>{Number.isFinite(stat.value) ? stat.value : '—'}</strong>{stat.label[stat.value === 1 ? 0 : 1]}</span>
                {/* Only what waits on you in colour: "1 live · 2 to mark". */}
                <small>{stat.line.map(([text, tone], index) => <span key={text} className={tone ? `is-${tone}` : undefined}>{index > 0 && ' · '}{text}</span>)}</small>
              </>
            )}
          </a>
        ))}
      </div>

      {/* What waits on you - only while something does. */}
      {needs.length > 0 && (
        <section className="home-section" aria-label="Needs you">
          <h2>Needs you <span className="home-count">{needs.length}</span></h2>
          <ul className="home-needs">
            {needs.map((item) => (
              <li key={item.key}>
                <span className={`home-need-icon is-${item.tone}`} aria-hidden="true"><item.icon size={16}/></span>
                <a className="home-need-text" href={item.url} onClick={link(item.url)}><strong>{item.text}</strong><small>{item.where}</small></a>
                <a className="button button-secondary button-small" href={item.url} onClick={link(item.url)}>{item.action}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Scheduled tests still to start - only while there are some. */}
      {upcoming.length > 0 && (
        <section className="home-section" aria-label="Coming up">
          <h2>Coming up</h2>
          <ul className="home-needs">
            {upcoming.map((test) => (
              <li key={test.code}>
                <span className="home-need-icon is-info" aria-hidden="true"><CalendarClock size={16}/></span>
                <a className="home-need-text" href={testUrl(test)} onClick={link(testUrl(test))}><strong>{test.title}</strong><small>Starts {shortDateTime(test.opensAt)}</small></a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
