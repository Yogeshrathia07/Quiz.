import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadSpreadsheet, post } from '../../lib/api.js';
import { countdown, durationLabel, shortDateTime } from '../../lib/format.js';
import { useCountdown } from '../../lib/useCountdown.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { usePageTitle } from '../../brand.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import {
  BadgeCheck, CheckCheck, CircleCheck, CircleDashed, CircleHelp, CirclePlay, CircleStop, Clock, Eraser, FileCheck2, FileCog, FileSpreadsheet, LayoutDashboard,
  LocateOff, Lock, LockOpen, MapPin, MapPinOff, Pause, Pencil, PenLine, Play, RotateCcw, Search, Send, ShieldCheck, TimerOff, Undo2, UserCheck,
  UserCog, UserRound, UserX, Users
} from 'lucide-react';
import { StudentRow } from './StudentRow.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { RESULT_FILTERS, awaitingMarking, studentFilters } from './student-filters.js';
import { ResponseRow } from './ResponseRow.jsx';
import { QrModal } from './modals/QrModal.jsx';
import { SapIdModal } from './modals/SapIdModal.jsx';
import { StudentAnalysisModal } from './modals/StudentAnalysisModal.jsx';
import { TestSetupModal } from './modals/TestSetupModal.jsx';
import { RestartQuizModal } from './modals/RestartQuizModal.jsx';

/** Each filter option's icon, coloured by what it means (filters.css). */
const FILTER_ICONS = {
  pending: { icon: Clock, tone: 'warn' },
  approved: { icon: UserCheck, tone: 'ok' },
  rejected: { icon: UserX, tone: 'bad' },
  'paper:not_started': { icon: CircleDashed, tone: 'muted' },
  'paper:in_progress': { icon: CirclePlay, tone: 'info' },
  'paper:paused': { icon: Pause, tone: 'info' },
  'paper:locked': { icon: Lock, tone: 'bad' },
  'paper:submitted': { icon: CircleCheck, tone: 'ok' },
  verified: { icon: BadgeCheck, tone: 'info' },
  guest: { icon: UserRound, tone: 'muted' },
  'venue:in_range': { icon: MapPin, tone: 'ok' },
  'venue:out_of_range': { icon: MapPinOff, tone: 'bad' },
  'venue:exception': { icon: ShieldCheck, tone: 'warn' },
  'venue:not_checked': { icon: LocateOff, tone: 'muted' },
  'marking:awaiting': { icon: PenLine, tone: 'warn' },
  'marking:done': { icon: CheckCheck, tone: 'ok' },
  'finish:student': { icon: Send, tone: 'info' },
  'finish:time': { icon: TimerOff, tone: 'warn' },
  'finish:admin': { icon: CircleStop, tone: 'muted' },
  'finish:teacher': { icon: Send, tone: 'muted' },
  'finish:unknown': { icon: CircleHelp, tone: 'muted' }
};

function releaseLabel(test) {
  if (test.resultReleaseMode === 'instant') return 'Marks show on submission';
  if (test.resultReleaseMode === 'after_quiz') return 'Marks show after the test closes';
  return test.resultsReleasedAt ? 'Marks released' : 'Marks require admin release';
}

/** Grey before the start, green while live, blue once completed. */
function phaseDot(test) {
  if (test.isClosed) return { tone: 'done', label: 'Completed' };
  if (test.isStarted) return { tone: 'live', label: 'Live now' };
  return { tone: 'idle', label: test.startMode === 'scheduled' ? 'Scheduled' : 'Not started' };
}

/** A Close pressed by mistake can be undone - if there was still time left when it was pressed. */
const canResume = (test) => test.isClosed && !test.closedAutomatically
  && (test.untimed || !test.endsAt || Date.parse(test.endsAt) > Date.parse(test.closedAt));

/** What Resume will do, said before it is done. */
function resumeQuestion(test, papers) {
  const leftMs = test.untimed || !test.endsAt ? null : Date.parse(test.endsAt) - Date.parse(test.closedAt);
  const endsAt = leftMs === null ? null : new Date(Date.now() + leftMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const marksSeen = test.resultReleaseMode === 'instant' || test.resultReleaseMode === 'after_quiz' || Boolean(test.resultsReleasedAt);
  return [
    'Resume the test?',
    `${papers} paper${papers === 1 ? '' : 's'} handed in by Close reopen${papers === 1 ? 's' : ''} exactly where ${papers === 1 ? 'it was' : 'they were'}. Papers students submitted themselves stay submitted.`,
    leftMs === null ? 'It runs until you close it.' : `Everyone gets back the ${durationLabel(Math.round(leftMs / 1000))} that was left: it now ends at ${endsAt}.`,
    marksSeen ? 'Note: students may have seen their marks while it was closed.' : ''
  ].filter(Boolean).join('\n\n');
}

const startsLabel = (test) => (test.startMode === 'scheduled' ? shortDateTime(test.opensAt) : 'When you press Start');

function endsLabel(test) {
  if (test.untimed) return 'When you close it';
  if (test.endsAt) return shortDateTime(test.endsAt);
  return `${durationLabel((test.durationMinutes || 0) * 60)} after start`;
}

/**
 * Where the test stands in time, with a live countdown to whatever happens
 * next by itself - the scheduled start, or the automatic submission - and the
 * buttons that change it.
 */
function ScheduleBanner({ test, serverTime, isBusy, act, actions, owed = 0 }) {
  const target = !test.isStarted ? (test.startMode === 'scheduled' ? test.opensAt : null) : test.isClosed ? null : test.endsAt;
  const { secondsLeft, known } = useCountdown(target, serverTime);
  const ticking = known && secondsLeft > 0;
  const extend = (minutes) => act('end-time', null, { addMinutes: minutes });

  let tone; let title; let detail; let extra = null;
  if (test.isClosed) {
    tone = 'is-done';
    title = `${test.closedAutomatically ? 'Ended automatically' : 'Closed'} · ${shortDateTime(test.closedAt)}`;
    detail = canResume(test)
      ? 'Every paper has been submitted. Closed by mistake? More → Resume test reopens them where they were, with the time they had left.'
      : 'Every paper has been submitted.';
  } else if (!test.isStarted) {
    tone = 'is-waiting';
    if (test.startMode === 'scheduled') {
      title = ticking ? `Starts automatically in ${countdown(secondsLeft)}` : 'Starting…';
      detail = `At ${shortDateTime(test.opensAt)}. Students see the same countdown. You can start early with Start early.`;
    } else {
      title = 'Starts when you press Start';
      detail = 'Approved students are waiting on a holding screen.';
    }
  } else {
    tone = `is-live${ticking && secondsLeft <= 300 ? ' is-ending' : ''}`;
    title = test.untimed ? 'Live · no end time'
      : ticking ? `Ends automatically in ${countdown(secondsLeft)}`
        : owed ? `Time is up — waiting for ${owed} paused student${owed === 1 ? '' : 's'}` : 'Time is up — submitting every paper…';
    detail = test.untimed
      ? 'Close the test when everyone is done; that submits every paper.'
      : owed && !ticking
        ? 'Their papers stay open for the time you paused them (or while still paused). Close test hands them in now.'
        : `At ${shortDateTime(test.endsAt)}, every paper still open is submitted automatically.${owed ? ` ${owed} paused student${owed === 1 ? ' gets' : 's get'} that time added.` : ''}`;
    if (!test.untimed) {
      extra = (
        <div className="quick-picks banner-extend">
          {[5, 10, 15].map((minutes) => (
            <button key={minutes} type="button" disabled={isBusy} onClick={() => extend(minutes)}>+{minutes} min</button>
          ))}
        </div>
      );
    }
  }

  // Where the test stands on the left, what you can do about it on the right.
  return (
    <div className={`schedule-banner ${tone}`}>
      <div className="banner-text">
        <strong>{title}</strong>
        <span>{detail}</span>
        {extra}
      </div>
      {actions && <div className="banner-actions" aria-busy={isBusy}>{actions}</div>}
    </div>
  );
}

function Tabs({ tab, onSelect, counts }) {
  const tabs = [
    { id: 'test', label: 'Test', icon: LayoutDashboard },
    { id: 'students', label: 'Students', icon: Users, count: counts.total, badge: counts.pending, badgeLabel: 'waiting for your decision' },
    { id: 'responses', label: 'Results', icon: FileCheck2, count: counts.submitted, badge: counts.awaitingMarking, badgeLabel: 'waiting to be marked' }
  ];
  // These are mutually exclusive dashboard views, so use native radio inputs
  // instead of button-like tabs. The visual radio makes the current view clear
  // without hiding the student/response totals.
  return (
    <nav className="dashboard-tabs" role="radiogroup" aria-label="Dashboard sections">
      {tabs.map((entry) => {
        const selected = tab === entry.id;
        return (
        <label key={entry.id} className={`dashboard-tab${selected ? ' is-selected' : ''}`} title={entry.label}>
          <input
            type="radio"
            name="dashboard-section"
            value={entry.id}
            checked={selected}
            onChange={() => onSelect(entry.id)}
          />
          <span className="tab-radio" aria-hidden="true"/>
          {/* On a very narrow screen the icon stands in for the word. */}
          <entry.icon className="tab-icon" size={17} aria-hidden="true"/>
          <span className="tab-label">{entry.label}</span>
          {entry.count !== undefined && (
            <span className={`tab-count${entry.badge > 0 ? " has-badge" : ""}`}>
              {entry.count}
              {entry.badge > 0 && (
                <span className="tab-badge" title={`${entry.badge} ${entry.badgeLabel}`} aria-label={`${entry.badge} ${entry.badgeLabel}`}>
                  {entry.badge > 9 ? '9+' : entry.badge}
                </span>
              )}
            </span>
          )}
        </label>
        );
      })}
    </nav>
  );
}

/**
 * A search box and the tick-box filter, shared by both tables. `pool` is the
 * searched rows before filtering: what the filter's counts are taken from.
 */
function TableToolbar({ title, summary, query, setQuery, filters, setFilters, groups, pool, filterCounts, pagination, filterTitle, allLabel, children }) {
  return (
    <header className="students-toolbar">
      <div>
        <h2>{title}</h2>
        <p>{summary}</p>
      </div>
      <div className="controls">
        <label className="search-field">
          <Search size={16} aria-hidden="true"/>
          <input id="dash-search" className="text-input" type="search" aria-label="Search" placeholder="Search name, SAP ID or email"
            value={query} onChange={(event) => setQuery(event.target.value)}/>
        </label>
        <FilterMenu
          groups={groups} rows={pool} selected={filters} onChange={setFilters} icons={FILTER_ICONS}
          title={filterTitle} allLabel={allLabel} counts={filterCounts}
          total={pagination?.unfilteredTotal} shown={pagination?.total}
        />
        {children}
      </div>
    </header>
  );
}

function TestSection({ test, serverTime, counts, isBusy, act, onOpenSetup, onOpenQr, onOpenRestart, onEdit }) {
  // Only the one action that matters right now stays a button; the rest live in
  // the menu, so this toolbar never grows past three controls.
  const primary = !test.isStarted && !test.isClosed
    ? {
      label: test.startMode === 'scheduled' ? 'Start early' : 'Start test',
      icon: Play,
      tone: 'success',
      onSelect: () => act('start', test.startMode === 'scheduled' ? 'Start the test now, before its scheduled time?' : undefined)
    }
    : test.isStarted && !test.isClosed
      ? { label: 'Close test', icon: CircleStop, tone: 'danger', onSelect: () => act('close', 'Close the test? Every paper still open is submitted now.') }
      : test.isClosed && test.resultReleaseMode === 'admin' && !test.resultsReleasedAt
        ? { label: 'Release marks', icon: Send, tone: 'primary', onSelect: () => act('results/release') }
        : null;

  return (
    <div className="overview-grid">
      <section className="card overview-panel">
        <ScheduleBanner test={test} serverTime={serverTime} isBusy={isBusy} act={act} owed={counts.owedTime} actions={<>
          {primary && (
            <button className={`button button-${primary.tone}`} disabled={isBusy} onClick={primary.onSelect}>
              <primary.icon size={16} aria-hidden="true"/>{primary.label}
            </button>
          )}
          <button className="button button-secondary" disabled={isBusy} onClick={onEdit}><Pencil size={16} aria-hidden="true"/>Edit</button>
          <ActionMenu
            label="More"
            align="right"
            disabled={isBusy}
            items={[
              // Green keeps or approves, blue adjusts, amber starts over, red wipes.
              canResume(test) && {
                label: 'Resume test', icon: Play, tone: 'ok',
                onSelect: () => act('reopen', resumeQuestion(test, counts.handedInByClose))
              },
              test.isStarted && !test.isClosed && { label: test.untimed ? 'Set an end time' : 'Extend time', icon: Clock, tone: 'info', onSelect: onOpenSetup },
              !test.isClosed && counts.pending > 0 && {
                label: `Approve all ${counts.pending} pending`,
                icon: CheckCheck,
                tone: 'ok',
                onSelect: () => act('registrations/bulk/approve', `Approve all ${counts.pending} pending registrations?`)
              },
              (test.isStarted || test.isClosed) && { label: 'Restart quiz', icon: RotateCcw, tone: 'warn', onSelect: onOpenRestart },
              !test.isClosed && counts.started > 0 && {
                label: `Blank papers for all ${counts.started} (timer unchanged)`,
                icon: Eraser,
                danger: true,
                onSelect: () => act('attempts/restart', `Give all ${counts.started} students a blank paper? Their answers are cleared; the end time does not change.`)
              },
              {
                label: 'Reset to not started',
                icon: Undo2,
                danger: true,
                onSelect: () => act('reset', 'Reset the test? Every paper and mark is cleared and it goes back to not started. Registrations and approvals are kept.')
              }
            ]}
          />
        </>}/>

        <div className="dash-stats">
          <div><strong>{counts.total}</strong><span>Registered</span></div>
          <div className={counts.pending ? 'is-attention' : undefined}><strong>{counts.pending}</strong><span>Waiting for you</span></div>
          <div><strong>{counts.started}</strong><span>Started</span></div>
          <div><strong>{counts.submitted}</strong><span>Submitted</span></div>
        </div>
      </section>

      <section className="card qr-panel">
        <h2>Registration QR</h2>
        <img className="qr" src={`/api/tests/${encodeURIComponent(test.code)}/qr.svg`} alt="Test QR code" onClick={onOpenQr}/>
        <p className="test-code-display">{test.code}</p>
        <button className="button button-secondary button-wide" type="button" disabled={isBusy} onClick={onOpenQr}>
          Enlarge &amp; copy link
        </button>
      </section>
    </div>
  );
}

/**
 * Approve or reject everyone the current filter and search show - pick
 * "Pending" and approve the lot, or pick a venue problem and reject them.
 */
function BulkDecisionMenu({ test, rows, isBusy, act }) {
  const toApprove = rows.filter((row) => row.status !== 'approved');
  const toReject = rows.filter((row) => row.status !== 'rejected');
  const ids = (list) => ({ registrationIds: list.map((row) => row.id) });
  const plural = (count) => `${count} student${count === 1 ? '' : 's'}`;
  if (test.isClosed) return null;
  return (
    <ActionMenu
      label="Registration actions"
      icon={UserCog}
      disabled={isBusy || rows.length === 0}
      items={[
        toApprove.length > 0 && { label: `Approve ${plural(toApprove.length)}`, icon: UserCheck, tone: 'ok', onSelect: () => act('registrations/bulk/approve', `Approve ${plural(toApprove.length)} shown?`, ids(toApprove)) },
        toReject.length > 0 && { label: `Reject ${plural(toReject.length)}`, icon: UserX, danger: true, onSelect: () => act('registrations/bulk/reject', `Reject ${plural(toReject.length)} shown?`, ids(toReject)) }
      ]}
    />
  );
}

function PageControls({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  return (
    <nav className="table-pagination" aria-label="Student list pages">
      <button className="button button-secondary button-small" type="button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>Previous</button>
      <span>Page {pagination.page} of {pagination.pages} · {pagination.total} shown</span>
      <button className="button button-secondary button-small" type="button" disabled={pagination.page >= pagination.pages} onClick={() => onPage(pagination.page + 1)}>Next</button>
    </nav>
  );
}

function StudentsSection({ test, rows, pool, counts, query, setQuery, filters, setFilters, filterCounts, pagination, onPage, isBusy, act, onOpenSapId }) {
  const [openRegistrationId, setOpenRegistrationId] = useState(null);
  return (
    <section className="card students-card is-compact">
      <TableToolbar
        title="Students"
        summary={`${counts.total} registered · ${counts.started} started · ${counts.pending} awaiting approval`}
        query={query} setQuery={setQuery} filters={filters} setFilters={setFilters}
        groups={studentFilters(test)} pool={pool} filterCounts={filterCounts} pagination={pagination} filterTitle="Filter students" allLabel="Everyone"
      >
        <BulkDecisionMenu test={test} rows={rows} isBusy={isBusy} act={act}/>
        <BulkAttemptMenu test={test} rows={rows} isBusy={isBusy} act={act}/>
      </TableToolbar>
      <div className="table-scroll">
        <table className="live-table student-accordion-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Status</th>
              <th className="cell-num col-answered">Answered</th>
              <th className="column-actions"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((registration) => (
              <StudentRow
                key={registration.id}
                test={test}
                registration={registration}
                act={act}
                isBusy={isBusy}
                openSapId={onOpenSapId}
                columns={4}
                open={openRegistrationId === registration.id}
                onOpenChange={(nextOpen) => setOpenRegistrationId(nextOpen ? registration.id : null)}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">{counts.total === 0 ? 'Nobody has registered yet. Share the QR from the Test tab.' : 'No students match this filter.'}</p>
        )}
      </div>
      <PageControls pagination={pagination} onPage={onPage}/>
    </section>
  );
}

/**
 * Revive or restart every student the current filter and search show, so a
 * room full of locked papers is one click instead of one per row.
 */
function BulkAttemptMenu({ test, rows, isBusy, act }) {
  const locked = rows.filter((row) => row.isLocked && row.attemptStatus !== 'submitted');
  const started = rows.filter((row) => row.attemptStatus);
  const ids = (list) => ({ registrationIds: list.map((row) => row.id) });
  const plural = (count) => `${count} student${count === 1 ? '' : 's'}`;
  return (
    <ActionMenu
      label="Attempt actions"
      icon={FileCog}
      disabled={isBusy || (locked.length === 0 && started.length === 0)}
      items={[
        !test.isClosed && locked.length > 0 && {
          label: `Revive ${locked.length} locked`,
          icon: LockOpen,
          tone: 'ok',
          onSelect: () => act('attempts/bulk/resume', `Revive ${plural(locked.length)} shown? Their end time does not move.`, ids(locked))
        },
        started.length > 0 && {
          label: `Restart ${started.length} attempt${started.length === 1 ? '' : 's'}`,
          icon: RotateCcw,
          danger: true,
          onSelect: () => act('attempts/bulk/restart', `Restart ${plural(started.length)} shown with a blank paper?`, ids(started))
        }
      ]}
    />
  );
}

function ResultsSection({ test, rows, pool, counts, query, setQuery, filters, setFilters, filterCounts, pagination, onPage, isBusy, showToast, onOpenAnalysis }) {
  return (
    <section className="card students-card is-compact">
      <TableToolbar
        title="Results"
        summary={`${counts.submitted} submitted · ${counts.awaitingMarking} awaiting marking`}
        query={query} setQuery={setQuery} filters={filters} setFilters={setFilters}
        groups={RESULT_FILTERS} pool={pool} filterCounts={filterCounts} pagination={pagination} filterTitle="Filter results" allLabel="All submitted"
      >
        <button className="button button-secondary" disabled={isBusy} aria-label="Export Excel" title="Export Excel"
          onClick={() => downloadSpreadsheet(test.code).catch((error) => showToast(error.message))}>
          <FileSpreadsheet size={16} aria-hidden="true"/><span className="toolbar-text">Export Excel</span>
        </button>
      </TableToolbar>
      <div className="table-scroll">
        <table className="live-table">
          <thead>
            <tr>
              <th>Student</th><th className="cell-num col-answered">Answered</th><th className="cell-num">Score</th><th>Finished</th>
              <th className="column-actions"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((registration) => (
              <ResponseRow
                key={registration.id}
                registration={registration}
                isBusy={isBusy}
                openAnalysis={onOpenAnalysis}
                columns={5}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">{counts.submitted === 0 ? 'No results yet. Submitted papers appear here.' : 'No results match this filter.'}</p>
        )}
      </div>
      <PageControls pagination={pagination} onPage={onPage}/>
    </section>
  );
}

export function DashboardScreen({ code, go, showToast }) {
  const [dashboard, setDashboard] = useState(null);
  // ?tab=responses opens straight on a tab - the quiz list's "View results" does.
  const [tab, setTab] = useState(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    return ['test', 'students', 'responses'].includes(asked) ? asked : 'test';
  });
  const [query, setQuery] = useState('');
  const [studentFilterIds, setStudentFilterIds] = useState([]);
  const [resultFilterIds, setResultFilterIds] = useState([]);
  const [page, setPage] = useState(1);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [modal, setModal] = useState(null);
  const [actionPath, setActionPath] = useState('');
  const headRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const selectedFilters = tab === 'responses' ? resultFilterIds : tab === 'students' ? studentFilterIds : [];
  const filterKey = selectedFilters.join(',');
  useEffect(() => { setPage(1); }, [tab, debouncedQuery, filterKey]);

  const load = useCallback(async (silent = false) => {
    const params = new URLSearchParams({ section: tab, page: String(page), pageSize: '100' });
    if (debouncedQuery) params.set('search', debouncedQuery);
    if (filterKey) params.set('filters', filterKey);
    try {
      const next = await api(`/api/admin/tests/${encodeURIComponent(code)}?${params}`);
      setDashboard(next);
      return next;
    }
    catch (error) { if (!silent) showToast(error.message); }
    return null;
  }, [code, tab, page, debouncedQuery, filterKey, showToast]);

  useEffect(() => { load(); }, [load]);

  // Live: new registrations, answers and exits appear without reloading. The
  // refresh is silent, and it waits while a dialog is open or an action runs
  // so nothing changes under the admin's hand. A hidden tab does not poll.
  const busyRef = useRef(false);
  busyRef.current = Boolean(modal || actionPath);
  useEffect(() => {
    let timer;
    const refresh = async () => {
      let next = dashboard;
      if (!document.hidden && !busyRef.current) next = await load(true) || next;
      const live = next?.test?.isStarted && !next?.test?.isClosed;
      const attention = live || (next?.counts?.pending || 0) > 0;
      const base = next?.test?.isClosed ? 30_000 : attention ? 5_000 : 12_000;
      timer = window.setTimeout(refresh, base + Math.round(Math.random() * base * 0.4));
    };
    timer = window.setTimeout(refresh, 5_000 + Math.round(Math.random() * 2_000));
    const onVisible = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (path, confirmText, body) => {
    if (actionPath) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setActionPath(path);
    try {
      const next = await post(`/api/admin/tests/${encodeURIComponent(code)}/${path}`, body);
      await load();
      showToast(typeof next?.affectedCount === 'number'
        ? `${next.affectedCount} student${next.affectedCount === 1 ? '' : 's'} updated.`
        : 'Dashboard updated.');
    } catch (error) { showToast(error.message); }
    finally { setActionPath(''); }
  };

  usePageTitle({ students: 'Students', responses: 'Results' }[tab], dashboard?.test.title);

  // The pinned title bar's height, so table headers stick just below it.
  const hasDashboard = dashboard !== null;
  useEffect(() => {
    const head = headRef.current;
    if (!head || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--dash-head', `${head.offsetHeight}px`));
    observer.observe(head);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--dash-head');
    };
  }, [hasDashboard]);

  const all = dashboard?.registrations || [];

  const localCounts = useMemo(() => ({
    total: all.length,
    pending: all.filter((row) => row.status === 'pending').length,
    started: all.filter((row) => row.attemptStatus).length,
    submitted: all.filter((row) => row.attemptStatus === 'submitted').length,
    awaitingMarking: all.filter((row) => row.attemptStatus === 'submitted' && awaitingMarking(row)).length,
    // Still writing on time a pause gave back (or still paused): the automatic end waits for them.
    owedTime: all.filter((row) => row.attemptStatus === 'in_progress' && (row.isPaused || row.extraMs > 0)).length,
    // Papers the teacher's Close handed in: what Resume would reopen.
    handedInByClose: all.filter((row) => row.attemptStatus === 'submitted' && row.submittedBy === 'admin').length
  }), [all]);
  const counts = dashboard?.counts || localCounts;

  if (!dashboard) return <Skeleton rows={5} label="Loading the test"/>;

  const { test } = dashboard;
  const joinUrl = `${window.location.origin}/?test=${encodeURIComponent(test.code)}`;
  const isBusy = Boolean(actionPath);
  const closeModal = () => setModal(null);

  return (
    <>
      <header className="dashboard-head" ref={headRef}>
        <div className="dashboard-head-copy">
          <h1>
            <span className={`status-dot is-${phaseDot(test).tone}`} title={phaseDot(test).label} aria-label={phaseDot(test).label} role="img"/>
            {test.title}
          </h1>
          <span className="dash-code" title="Test code">{test.code}</span>
        </div>
        <Tabs tab={tab} onSelect={setTab} counts={counts}/>
      </header>

      {tab === 'test' && (
        <TestSection
          test={test}
          serverTime={dashboard.serverTime}
          counts={counts}
          isBusy={isBusy}
          act={act}
          onOpenSetup={() => setModal('setup')}
          onOpenRestart={() => setModal('restart')}
          onEdit={() => go(`/?admin=edit&code=${encodeURIComponent(code)}`)}
          onOpenQr={() => setModal('qr')}
        />
      )}

      {tab === 'students' && (
        <StudentsSection
          test={test}
          rows={all}
          pool={all}
          counts={counts}
          query={query} setQuery={setQuery} filters={studentFilterIds} setFilters={setStudentFilterIds}
          filterCounts={dashboard.filterCounts} pagination={dashboard.pagination} onPage={setPage}
          isBusy={isBusy}
          act={act}
          onOpenSapId={(row) => { if (!isBusy) setModal({ type: 'sap', registration: row }); }}
        />
      )}

      {tab === 'responses' && (
        <ResultsSection
          test={test}
          rows={all}
          pool={all}
          counts={counts}
          query={query} setQuery={setQuery} filters={resultFilterIds} setFilters={setResultFilterIds}
          filterCounts={dashboard.filterCounts} pagination={dashboard.pagination} onPage={setPage}
          isBusy={isBusy}
          showToast={showToast}
          onOpenAnalysis={(row) => { if (!isBusy) setModal({ type: 'analysis', registration: row }); }}
        />
      )}

      {modal === 'qr' && <QrModal test={test} joinUrl={joinUrl} onClose={closeModal} showToast={showToast}/>}
      {modal === 'setup' && <TestSetupModal code={code} test={test} onClose={closeModal} onSaved={load} showToast={showToast}/>}
      {modal === 'restart' && <RestartQuizModal code={code} test={test} counts={counts} onClose={closeModal} onSaved={load} showToast={showToast}/>}
      {modal?.type === 'sap' && <SapIdModal code={code} registration={modal.registration} onClose={closeModal} onSaved={load} showToast={showToast}/>}
      {modal?.type === 'analysis' && <StudentAnalysisModal code={code} registration={modal.registration} onClose={closeModal} onSaved={load} showToast={showToast} showIntegrity={false}/>}
    </>
  );
}
