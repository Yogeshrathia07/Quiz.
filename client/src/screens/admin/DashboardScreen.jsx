import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveUpdate } from '../../lib/live-updates.js';
import { downloadSpreadsheet, post } from '../../lib/api.js';
import { loadCached, peekCached, prefetch, updateCached, useCached } from '../../lib/cache.js';
import { dashboardPath, recordPath, wholeClassPath } from '../../lib/dashboard-paths.js';
import { paginateDashboard } from '../../../../src/domain/dashboard-view.js';
import { clockTime, countdown, durationLabel, shortDateTime } from '../../lib/format.js';
import { useCountdown } from '../../lib/useCountdown.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { usePageTitle } from '../../brand.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import {
  ArrowDownAZ, ArrowLeft, BadgeCheck, BarChart3, CheckCheck, ChevronLeft, ChevronRight, ClipboardCheck, Hash, ListChecks, Trophy, UserRoundPlus, CircleCheck, CircleDashed, CircleHelp, CirclePlay, CircleStop, Clock, Eraser, EyeOff, FileCheck2, FileCog, FileSpreadsheet, FileUp, LayoutDashboard,
  LocateOff, Lock, LockOpen, Mail, MapPin, MapPinOff, MoreVertical, Pause, Pencil, PenLine, Play, QrCode, RotateCcw, Search, Send, ShieldCheck, StepBack, StepForward, TimerOff, Undo2, UserCheck,
  UserCog, UserRound, UserX, Users
} from 'lucide-react';
import { SIGN_LEGEND, STATE_LEGEND, StateChip, StudentIdentity, StudentRow, StudentWindow, statesOf } from './StudentRow.jsx';
import { Modal } from '../../components/Modal.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { RESULT_FILTERS, awaitingMarking, studentFilters } from './student-filters.js';
import { ResponseRow } from './ResponseRow.jsx';
import { QrModal } from './modals/QrModal.jsx';
import { SapIdModal } from './modals/SapIdModal.jsx';
import { EmailResultsModal } from './modals/EmailResultsModal.jsx';
import { ReopenPaperModal } from './modals/ReopenPaperModal.jsx';
import { StudentAnalysisModal } from './modals/StudentAnalysisModal.jsx';
import { TestSetupModal } from './modals/TestSetupModal.jsx';
import { RestartQuizModal } from './modals/RestartQuizModal.jsx';
import { ReleaseMarksModal } from './modals/ReleaseMarksModal.jsx';
import { UploadMarksModal } from './modals/UploadMarksModal.jsx';
import { ResultReviewModal } from './modals/ResultReviewModal.jsx';
import { SheetSwitch } from './modals/SheetSwitch.jsx';
import { OverviewPanels, useOverview } from './TestOverview.jsx';
import { AnalysisSection } from './AnalysisSection.jsx';
import { decodeAnswerFilters, encodeAnswerFilters } from './answer-filters.js';
import { useFitToScreen } from '../../lib/fit-to-screen.js';

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

/** A busy class sends an event with every answer: the dashboard redraws at most this often. */
const LIVE_GAP_MS = 1_500;

/*
 * The open tab, the search and each list's filter are kept in the address as
 * well: ?tab=students&q=Asha&students=paper:locked. A phone reloads a page by
 * itself - pull-to-refresh while scrolling, or reopening a tab it put away
 * while another app was open - and the teacher comes back to the same list,
 * not to everyone again.
 */
/**
 * The Results list's orders: a field, either way round (the first direction
 * is where choosing the field starts). The first field's first direction is
 * the usual order. The server sorts (admin-service RESULT_SORTS).
 */
const RESULT_SORTS = [
  { id: 'order', label: 'Registration time', icon: UserRoundPlus, directions: [{ id: 'asc', label: 'Oldest first' }, { id: 'desc', label: 'Newest first' }] },
  { id: 'submitted', label: 'Submission time', icon: Clock, directions: [{ id: 'desc', label: 'Latest first' }, { id: 'asc', label: 'Earliest first' }] },
  { id: 'score', label: 'Score', icon: Trophy, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] }
];
/**
 * The Students list's orders. Registration time, oldest first, is the usual
 * one - and with it, whoever is waiting for a decision stays at the top.
 */
const STUDENT_SORTS = [
  { id: 'order', label: 'Registration time', icon: UserRoundPlus, directions: [{ id: 'asc', label: 'Oldest first' }, { id: 'desc', label: 'Newest first' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'sap', label: 'SAP ID', icon: Hash, directions: [{ id: 'asc', label: 'Ascending' }, { id: 'desc', label: 'Descending' }] },
  { id: 'answered', label: 'Questions answered', icon: ListChecks, directions: [{ id: 'desc', label: 'Most first' }, { id: 'asc', label: 'Fewest first' }] }
];
const USUAL_SORT = 'order-asc';
const USUAL_RESULT_SORT = USUAL_SORT;
const sortIds = (sorts) => sorts.flatMap((field) => field.directions.map((way) => `${field.id}-${way.id}`));
const RESULT_SORT_IDS = sortIds(RESULT_SORTS);
const STUDENT_SORT_IDS = sortIds(STUDENT_SORTS);
/** Links saved before an order could be reversed. */
const LEGACY_RESULT_SORTS = { order: 'order-asc', latest: 'submitted-desc', 'score-high': 'score-desc', 'score-low': 'score-asc', name: 'name-asc' };
/** " · Name: Z–A" for a list's summary line - nothing for the usual order. */
function sortNote(sorts, sort) {
  if (!sort || sort === USUAL_SORT) return '';
  const [fieldId, wayId] = sort.split('-');
  const field = sorts.find((option) => option.id === fieldId);
  const way = field?.directions.find((option) => option.id === wayId);
  return field && way ? ` · ${field.label}: ${way.label}` : '';
}
const STUDENT_FILTER_IDS = new Set(studentFilters({ locationRequired: true }).flatMap((group) => group.options.map((option) => option.id)));
const RESULT_FILTER_IDS = new Set(RESULT_FILTERS.flatMap((group) => group.options.map((option) => option.id)));
const fromAddress = (key) => new URLSearchParams(window.location.search).get(key) || '';
const filtersFromAddress = (key, known) => [...new Set(fromAddress(key).split(',').filter((id) => known.has(id)))];

/** The status bar's colours: blue before the start, green while live, red once over. */
function phaseDot(test) {
  if (test.isClosed) return { tone: 'done', label: 'Completed' };
  if (test.isStarted) return { tone: 'live', label: 'Live now' };
  return { tone: 'idle', label: test.startMode === 'scheduled' ? 'Scheduled' : 'Not started' };
}

/** What Close will do, said before it is done: on each student's own time, who still has time left. */
function closeQuestion(test, counts) {
  const writing = counts.writing || 0;
  if (test.endMode !== 'each' || !writing) return 'Close the test? Every paper still open is submitted now.';
  const until = counts.lastOwnEndAt ? ` - the last of them has until ${clockTime(counts.lastOwnEndAt)}` : '';
  return `Close the test? ${writing} student${writing === 1 ? ' is' : 's are'} still writing on their own time${until}. Every paper still open is submitted now.`;
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
    test.endMode === 'each' ? 'Each reopened paper gets back the time the test was closed, on top of its own time. It stays open until you close it.'
      : leftMs === null ? 'It runs until you close it.' : `Everyone gets back the ${durationLabel(Math.round(leftMs / 1000))} that was left: it now ends at ${endsAt}.`,
    marksSeen ? 'Note: students may have seen their marks while it was closed.' : ''
  ].filter(Boolean).join('\n\n');
}

/**
 * Where the test stands in time, with a live countdown to whatever happens
 * next by itself - the scheduled start, or the automatic submission - and the
 * buttons that change it.
 */
function ScheduleBanner({ test, serverTime, isBusy, act, actions, owed = 0, writing = 0, lastOwnEndAt = null, detail: finished = null }) {
  const ownTime = test.endMode === 'each';
  const target = !test.isStarted ? (test.startMode === 'scheduled' ? test.opensAt : null) : test.isClosed || ownTime ? null : test.endsAt;
  const { secondsLeft, known } = useCountdown(target, serverTime);
  const ticking = known && secondsLeft > 0;
  const extend = (minutes) => act('end-time', null, { addMinutes: minutes });

  let tone; let title; let detail; let extra = null;
  if (test.isClosed) {
    tone = 'is-done';
    title = `${test.closedAutomatically ? 'Ended automatically' : 'Closed'} · ${shortDateTime(test.closedAt)}`;
    detail = finished || 'Every paper has been submitted.';
  } else if (!test.isStarted) {
    tone = 'is-waiting';
    if (test.startMode === 'scheduled') {
      title = ticking ? `Starts automatically in ${countdown(secondsLeft)}` : 'Starting…';
      detail = `At ${shortDateTime(test.opensAt)}. Students see the same countdown. You can start early with Start early.`;
    } else {
      title = 'Starts when you press Start';
      detail = 'Approved students are waiting on a holding screen.';
    }
  } else if (ownTime) {
    // Each student's own time: no end for the test - who is writing, and when the last of them runs out.
    tone = 'is-live';
    title = `Live · ${durationLabel((test.durationMinutes || 0) * 60)} each, from their own Begin`;
    detail = writing
      ? `${writing} writing now${lastOwnEndAt ? ` - the last one's time ends at ${clockTime(lastOwnEndAt)}` : ''}. Open until you close it: anyone approved can still begin.`
      : 'Nobody is writing right now. Open until you close it: anyone approved can still begin.';
    if (writing) {
      extra = (
        <div className="quick-picks banner-extend" title="More time for everyone still writing">
          {[5, 10, 15].map((minutes) => (
            <button key={minutes} type="button" disabled={isBusy} onClick={() => extend(minutes)}>+{minutes} min</button>
          ))}
        </div>
      );
    }
  } else {
    tone = `is-live${ticking && secondsLeft <= 300 ? ' is-ending' : ''}`;
    title = test.untimed ? 'Live · no end time'
      : ticking ? `Ends automatically in ${countdown(secondsLeft)}`
        : owed ? `Time is up — waiting for ${owed} student${owed === 1 ? '' : 's'} with extra time` : 'Time is up — submitting every paper…';
    detail = test.untimed
      ? 'Close the test when everyone is done; that submits every paper.'
      : owed && !ticking
        ? 'Close test hands their papers in now.'
        : `At ${shortDateTime(test.endsAt)}, every paper still open is submitted automatically.`;
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
      {actions && <div className="ov-actions" aria-busy={isBusy}>{actions}</div>}
    </div>
  );
}

function Tabs({ tab, onSelect, counts, area }) {
  const tabs = [
    { id: 'test', label: 'Overview', icon: LayoutDashboard },
    { id: 'students', label: 'Students', icon: Users, count: counts.total, badge: counts.pending, badgeLabel: 'waiting for your decision' },
    { id: 'responses', label: 'Results', icon: FileCheck2, count: counts.submitted, badge: counts.awaitingMarking, badgeLabel: 'waiting to be marked' },
    // How the class did and why - from the submitted papers (AnalysisSection).
    { id: 'analysis', label: 'Analysis', icon: BarChart3 }
  ];
  // Results opens on Analysis, left of the list of papers; a quiz on its Overview.
  const shown = (area === 'results' ? ['analysis', 'responses'] : ['test', 'students']).map((id) => tabs.find((entry) => entry.id === id));
  // These are mutually exclusive dashboard views, so use native radio inputs
  // instead of button-like tabs. The visual radio makes the current view clear
  // without hiding the student/response totals.
  return (
    <div className="dashboard-tabs" role="radiogroup" aria-label="Dashboard sections">
      {shown.map((entry) => {
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
    </div>
  );
}

/**
 * A search box and the tick-box filter, shared by both tables. `pool` is the
 * searched rows before filtering: what the filter's counts are taken from.
 */
function TableToolbar({ title, summary, query, setQuery, filters, setFilters, groups, pool, filterCounts, pagination, filterTitle, allLabel, sorts, sort, onSort, sortHint, children }) {
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
          sorts={sorts} sort={sort} onSort={onSort} sortHint={sortHint}
        />
        {children}
      </div>
    </header>
  );
}

/**
 * One number tile; with `onOpen`, the whole tile opens the list it counts.
 * `attention`: it waits on the teacher (orange).
 */
function StatTile({ value, label, onOpen, attention = false, title }) {
  const inner = <><strong>{value}</strong><span>{label}</span></>;
  return (
    <div className={[onOpen && 'is-link', attention && 'is-attention'].filter(Boolean).join(' ') || undefined}>
      {onOpen ? <button className="dash-stat-link" type="button" onClick={onOpen} title={title}>{inner}</button> : inner}
    </div>
  );
}

const shownCount = (value) => (value === undefined || value === null ? '—' : value);

/** The tiles that matter in each part of the test's life: before it, during it, after it. */
function StatTiles({ test, counts, overview, marks, frozen, onOpenList, onOpenMarking }) {
  const people = overview?.people;
  const list = (tab, filters = []) => () => onOpenList(tab, filters);
  if (!test.isStarted && !test.isClosed) {
    return (
      <div className="dash-stats ov-tiles">
        <StatTile value={counts.total} label="Registered" onOpen={list('students')}/>
        <StatTile value={counts.pending} label="Requests waiting" attention={counts.pending > 0} onOpen={list('students', ['pending'])}/>
        <StatTile value={shownCount(people?.approved)} label="Let in" onOpen={list('students', ['approved'])}/>
        <StatTile value={shownCount(people?.rejected)} label="Turned away" onOpen={list('students', ['rejected'])}/>
      </div>
    );
  }
  if (!test.isClosed) {
    const held = test.locksOnExit ? people?.locked : people?.paused;
    return (
      <div className="dash-stats ov-tiles">
        <StatTile value={counts.writing} label="Writing now" onOpen={list('students', ['paper:in_progress'])}/>
        <StatTile value={counts.submitted} label="Submitted" onOpen={list('responses')}/>
        <StatTile value={shownCount(people?.notBegun)} label="Not begun yet" onOpen={list('students', ['paper:not_started'])}/>
        <StatTile value={shownCount(held)} label={test.locksOnExit ? 'Locked' : 'Paused'} attention={held > 0}
          onOpen={list('students', [test.locksOnExit ? 'paper:locked' : 'paper:paused'])}/>
        <StatTile value={counts.pending} label="Requests waiting" attention={counts.pending > 0} onOpen={list('students', ['pending'])}/>
      </div>
    );
  }
  const average = overview?.marks?.papers
    ? overview.marks.fullMarks !== null ? `${Math.round(overview.marks.average * 10) / 10}/${overview.marks.fullMarks}` : `${Math.round(overview.marks.averagePercent)}%`
    : '—';
  return (
    <div className="dash-stats ov-tiles">
      <StatTile value={counts.total} label="Registered" onOpen={list('students')}/>
      <StatTile value={counts.submitted} label="Submitted" onOpen={list('responses')}/>
      <StatTile value={shownCount(people?.notBegun)} label="Never began" onOpen={list('students', ['paper:not_started'])}/>
      <StatTile value={average} label="Average mark" onOpen={list('analysis')} title="Open the analysis"/>
      {/* Papers with short answers still unmarked: one tap to marking. Released
          anyway or frozen, they no longer wait on you - still counted, no longer orange. */}
      {marks && (
        <StatTile value={counts.awaitingMarking} label={frozen ? 'Unmarked, frozen' : test.releaseUnmarked ? 'Unmarked, released' : 'To mark'}
          attention={counts.awaitingMarking > 0 && !test.releaseUnmarked && !frozen}
          onOpen={counts.awaitingMarking > 0 ? onOpenMarking : null} title="Open the papers with short answers not marked yet"/>
      )}
    </div>
  );
}

/** "Started 6:30 PM · ran 32 min · 1 paper in, 5 never began": a finished test in one line. */
function finishedLine(test, counts, people) {
  const ranSeconds = test.startedAt && test.closedAt ? (Date.parse(test.closedAt) - Date.parse(test.startedAt)) / 1000 : null;
  return [
    test.startedAt && `Started ${clockTime(test.startedAt)}`,
    ranSeconds >= 60 && `ran ${durationLabel(ranSeconds)}`,
    `${counts.submitted} paper${counts.submitted === 1 ? '' : 's'} in${people?.notBegun ? `, ${people.notBegun} never began` : ''}`
  ].filter(Boolean).join(' · ');
}

function TestSection({ test, serverTime, counts, isBusy, act, showToast, onOpenSetup, onOpenQr, onOpenRestart, onEdit, onOpenMarking, onOpenRelease, onOpenList, onOpenEmail }) {
  // Results frozen: marks final until unfrozen (domain/freeze.js).
  const frozen = Boolean(test.resultsFrozenAt);
  const live = test.isStarted && !test.isClosed;
  // Asked again as the class's numbers move; while live, every refresh may
  // bring someone locked or away, so that is a change too (at most every 10 s).
  const overview = useOverview(test.code, {
    enabled: true,
    live,
    signature: [counts.total, counts.pending, counts.started, counts.submitted, counts.awaitingMarking, counts.writing,
      test.isStarted, test.isClosed, test.resultsReleasedAt, test.resultsFrozenAt, test.releaseUnmarked, live ? serverTime : ''].join('|')
  });
  // Only a test with short answers can have papers to mark.
  const marks = (test.questionMix?.short || 0) > 0 || counts.awaitingMarking > 0;
  const waiting = !test.isStarted && !test.isClosed;
  const fitRef = useFitToScreen(true);
  // Marks still to come out: waiting for Release marks, or held on papers with
  // short answers to mark. With papers waiting, Release shows who first.
  const heldForMarking = counts.awaitingMarking > 0 && !test.releaseUnmarked;
  const unreleased = test.resultReleaseMode === 'admin' && !test.resultsReleasedAt;
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
      ? { label: 'Close test', icon: CircleStop, tone: 'danger', onSelect: () => act('close', closeQuestion(test, counts)) }
      : test.isClosed && (unreleased || heldForMarking)
        ? { label: 'Release marks', icon: Send, tone: 'primary', onSelect: heldForMarking ? onOpenRelease : () => act('results/release') }
        // Marks out: what is left is telling the students - each their own, by email.
        : test.isClosed && counts.submitted > 0
          ? { label: 'Email results', icon: Mail, tone: 'primary', onSelect: onOpenEmail }
          : null;

  return (
    <div ref={fitRef} className={`ov is-fit${waiting ? ' is-waiting' : ''}`}>
      <div className="ov-top">
        <section className="card overview-panel">
          <ScheduleBanner test={test} serverTime={serverTime} isBusy={isBusy} act={act} owed={counts.owedTime}
            writing={counts.writing} lastOwnEndAt={counts.lastOwnEndAt}
            detail={test.isClosed ? finishedLine(test, counts, overview?.people) : null}
            actions={<>
              {/* The one action that matters now is the solid button; Edit is outlined, More is ⋮. */}
              {primary && (
                <button className={`button button-${primary.tone} ov-primary`} disabled={isBusy} onClick={primary.onSelect} title={primary.label}>
                  <primary.icon size={16} aria-hidden="true"/><span className="toolbar-text">{primary.label}</span>
                </button>
              )}
              {/* Frozen results: the paper cannot be edited until they are unfrozen. */}
              <button className="button button-view ov-edit" disabled={isBusy || frozen} onClick={onEdit} aria-label="Edit"
                title={frozen ? 'The results are frozen: unfreeze them (More) to edit the test' : 'Edit the test'}>
                <Pencil size={16} aria-hidden="true"/><span className="toolbar-text">Edit</span>
              </button>
              <ActionMenu
                label={<MoreVertical size={18} aria-label="More actions"/>}
                trigger="icon"
                align="right"
                disabled={isBusy}
                items={[
                  // Once the test is over the QR card goes; the link stays here.
                  test.isClosed && { label: 'Test link & QR', icon: QrCode, onSelect: onOpenQr },
                  // Green keeps or approves, blue adjusts, amber starts over, red wipes.
                  canResume(test) && !frozen && {
                    label: 'Resume test', icon: Play, tone: 'ok',
                    onSelect: () => act('reopen', resumeQuestion(test, counts.handedInByClose))
                  },
                  test.isStarted && !test.isClosed && {
                    label: test.endMode === 'each' ? 'Give more time' : test.untimed ? 'Set an end time' : 'Extend time', icon: Clock, tone: 'info', onSelect: onOpenSetup
                  },
                  // One question at a time on the clock: Next on and off, and going back on, while it runs (setNavigation).
                  test.isStarted && !test.isClosed && test.strictTiming && test.strictTimed && {
                    label: test.strictNext ? 'Turn off Next' : 'Allow Next', icon: StepForward, tone: 'info',
                    onSelect: () => (test.strictNext
                      ? act('navigation', 'Turn off Next? Students then stay on each new question until its time runs out. You can turn it back on.', { next: false }, 'Next is off for every student.')
                      : act('navigation', 'Allow Next? Students may then move on before a question\'s time runs out. You can turn it off again.', { next: true }, 'Students can now move on with Next.'))
                  },
                  // Going back: only on a paper with no question timers - a timed one goes forward only.
                  test.isStarted && !test.isClosed && test.strictTiming && !test.strictTimed && !test.strictPrevious && {
                    label: 'Allow going back', icon: StepBack, tone: 'info',
                    onSelect: () => act('navigation', 'Let students go back to questions they have seen? This cannot be turned off again.',
                      { previous: true }, 'Students can now go back with Previous.')
                  },
                  !test.isClosed && counts.pending > 0 && {
                    label: `Approve all ${counts.pending} pending`,
                    icon: CheckCheck,
                    tone: 'ok',
                    onSelect: () => act('registrations/bulk/approve', `Approve all ${counts.pending} pending registrations?`)
                  },
                  // Released before marking was done (Release marks → Release anyway): undone here.
                  test.releaseUnmarked && {
                    label: 'Hold marks until marking is done',
                    icon: EyeOff,
                    tone: 'info',
                    onSelect: () => act('results/unmarked', 'Hide the marks again from students who still have short answers to mark? They see them once every answer is marked.', { show: false })
                  },
                  // Final marks: nothing changes them until they are unfrozen (domain/freeze.js).
                  test.isClosed && !frozen && {
                    label: 'Freeze results', icon: Lock, tone: 'info',
                    onSelect: () => act('results/freeze', freezeQuestion(counts), { frozen: true })
                  },
                  frozen && {
                    label: 'Unfreeze results', icon: LockOpen, tone: 'warn',
                    onSelect: () => act('results/freeze', 'Unfreeze the results? Marks can be changed again.', { frozen: false })
                  },
                  (test.isStarted || test.isClosed) && !frozen && { label: 'Restart quiz', icon: RotateCcw, tone: 'warn', onSelect: onOpenRestart },
                  !test.isClosed && counts.started > 0 && {
                    label: `Blank papers for all ${counts.started} (timer unchanged)`,
                    icon: Eraser,
                    danger: true,
                    onSelect: () => act('attempts/restart', `Give all ${counts.started} students a blank paper? Their answers are cleared; the end time does not change.`)
                  },
                  // Only once there is something to undo: a test not started yet is already there.
                  (test.isStarted || test.isClosed) && !frozen && {
                    label: 'Reset to not started',
                    icon: Undo2,
                    danger: true,
                    onSelect: () => act('reset', 'Reset the test? Every paper and mark is cleared and it goes back to not started. Registrations and approvals are kept.')
                  }
                ]}
              />
            </>}/>
          <StatTiles test={test} counts={counts} overview={overview} marks={marks} frozen={frozen} onOpenList={onOpenList} onOpenMarking={onOpenMarking}/>
        </section>
      </div>

      <OverviewPanels test={test} counts={counts} overview={overview} isBusy={isBusy}
        onOpenQr={onOpenQr} onOpenList={onOpenList} onOpenMarking={onOpenMarking} onOpenEmail={onOpenEmail}
        onRelease={heldForMarking ? onOpenRelease : () => act('results/release')}
        onExport={() => downloadSpreadsheet(test.code).then(() => showToast('Excel download started.', 'success'), (error) => showToast(error.message))}
        />
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

/**
 * The search at the top of a student's window: it is the list's own search,
 * and as it narrows the list it drops down the students it matches, to pick
 * one. Arrow keys move through them, Enter opens one, Escape folds it away.
 */
function StudentPicker({ rows, current, query, setQuery, onPick }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const holder = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!holder.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  const pick = (row) => { onPick(row.id); setOpen(false); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((value) => Math.min(rows.length - 1, value + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    else if (event.key === 'Enter' && open && rows[active]) { event.preventDefault(); pick(rows[active]); }
    else if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); }
  };
  return (
    <div className="student-picker" ref={holder}>
      <Search size={15} aria-hidden="true"/>
      <input className="text-input" type="search" name="student-search" role="combobox" aria-expanded={open} aria-controls="student-picker-list" aria-autocomplete="list"
        aria-label="Search students" placeholder="Search name or SAP ID" value={query}
        onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={onKeyDown}/>
      {open && (
        <ul id="student-picker-list" className="student-picker-list" role="listbox" aria-label="Students">
          {rows.length === 0 && <li className="student-picker-empty">No students match</li>}
          {rows.map((row, index) => (
            <li key={row.id} role="option" aria-selected={row.id === current?.id}
              className={`${index === active ? 'is-active' : ''}${row.id === current?.id ? ' is-current' : ''}`}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(row)}>
              {/* A click here picks them: their name is not a link in this list. */}
              <StudentIdentity registration={row} link={false}/>
              <span className="student-picker-states">{statesOf(row).map((state) => <StateChip key={state} state={state}/>)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The top of a student's window: the one before and the one after - in the
 * list's own order, search and filter - the search to pick any of them, and
 * the list's Filter & sort. Changed here, the list behind changes with it.
 * `switchTo`: the button on to their answers and marks, beside the × as in
 * the review and the activity log (SheetSwitch).
 */
function StudentNavigator({ rows, current, onPick, query, setQuery, filterMenu, switchTo = null }) {
  const index = current ? rows.findIndex((row) => row.id === current.id) : -1;
  const previous = index > 0 ? rows[index - 1] : null;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null;
  const step = (row, word) => (
    <button className={`button icon-button student-nav-step is-${word === 'Previous' ? 'prev' : 'next'}`} type="button" disabled={!row} onClick={() => onPick(row.id)}
      aria-label={row ? `${word}: ${row.name}` : `No ${word.toLowerCase()} student`} title={row ? `${word}: ${row.name}` : `No ${word.toLowerCase()} student`}>
      {word === 'Previous' ? <ChevronLeft size={18} aria-hidden="true"/> : <ChevronRight size={18} aria-hidden="true"/>}
    </button>
  );
  return (
    <nav className={`student-nav${switchTo ? ' has-switch' : ''}`} aria-label="Students">
      {step(previous, 'Previous')}
      <StudentPicker rows={rows} current={current} query={query} setQuery={setQuery} onPick={onPick}/>
      {step(next, 'Next')}
      {filterMenu}
      <span className="student-nav-count">{index >= 0 ? `${index + 1} of ${rows.length}` : `${rows.length} student${rows.length === 1 ? '' : 's'}`}</span>
      {switchTo}
    </nav>
  );
}

/**
 * A student's window: the students either side and a search to pick any of
 * them, who this one is with the same buttons as their row, then Details /
 * Log / Location / Device - and, once their paper is handed in, the way on to
 * its answers and marks beside the ×. One window wherever it opens from: a row
 * of the Students tab, or their activity log from another tab (StudentLookup),
 * so it looks and works the same everywhere.
 */
function StudentModal({ test, rows, pool, openId, setOpenId, part, setPart, query, setQuery, filters, setFilters, sort, setSort, filterCounts, pagination, loading = false, isBusy, act, onOpenSapId, onOpenReopen, onReview, onClose }) {
  const current = rows.find((row) => row.id === openId) || null;
  const index = current ? rows.indexOf(current) : -1;
  // The open student left the list - filtered out, or approved off a list of
  // those waiting: the window moves on to the first one still in it.
  useEffect(() => {
    if (!current && rows.length) setOpenId(rows[0].id);
  }, [current, rows, setOpenId]);
  // The open student's log and readings - and the students either side of
  // them - fetched ahead, so Log, Location and ‹ › open at once.
  const previousId = rows[index - 1]?.id;
  const nextId = rows[index + 1]?.id;
  useEffect(() => {
    for (const id of [openId, previousId, nextId]) {
      if (id) prefetch(`${recordPath(test.code, id)}/analysis`, { maxAgeMs: 15_000 });
    }
  }, [openId, previousId, nextId, test.code]);
  // ← and → step through the students, unless a box or menu has the keys.
  useEffect(() => {
    const onKey = (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"], .filter-panel, .menu-floating')) return;
      const target = rows[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (target) { event.preventDefault(); setOpenId(target.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, index, setOpenId]);
  const filterMenu = (
    <FilterMenu
      groups={studentFilters(test)} rows={pool} selected={filters} onChange={setFilters} icons={FILTER_ICONS}
      title="Sort & filter students" allLabel="Everyone" counts={filterCounts}
      total={pagination?.unfilteredTotal} shown={pagination?.total}
      sorts={STUDENT_SORTS} sort={sort} onSort={setSort}
    />
  );
  return createPortal(
    <Modal label={current ? `${current.name}: details` : 'Students'} onClose={onClose} className="student-modal">
      <StudentNavigator rows={rows} current={current} onPick={setOpenId} query={query} setQuery={setQuery} filterMenu={filterMenu}
        switchTo={current?.attemptStatus === 'submitted' && onReview ? (
          // A handed-in paper: on to its answers and marks, this window closing behind.
          <SheetSwitch icon={FileCheck2} label="Answers & marks" short="Marks" tip={`${current.name}'s answers and marks`} who={current.name}
            onClick={() => onReview(current.id)}/>
        ) : null}/>
      {current ? (
        <StudentWindow test={test} registration={current} act={act} isBusy={isBusy} openSapId={onOpenSapId} openReopen={onOpenReopen} part={part} onPart={setPart}/>
      ) : loading ? (
        <p className="help student-modal-empty">Loading…</p>
      ) : (
        <div className="student-modal-empty">
          <strong>No students match</strong>
          <p>Nobody is left in the list with this search and filter.</p>
          <button className="button button-secondary" type="button" onClick={() => { setQuery(''); setFilters([]); }}>Show everyone</button>
        </div>
      )}
    </Modal>,
    document.body
  );
}

/**
 * The student's window opened from another tab - their Flags in the Analysis
 * rank list, Activity log in the review - on their Log: the Students tab's own
 * window, over the whole class with a search, filter and order of its own
 * (from everyone, so they are in it). A class too big to come whole is
 * searched on the server for them, by SAP ID or name.
 */
function StudentLookup({ code, test, whole, start, isBusy, act, onOpenSapId, onOpenReopen, onReview, onClose, answerFilter = '' }) {
  const [openId, setOpenId] = useState(start.registrationId);
  const [part, setPart] = useState(start.part || 'log');
  const [query, setQuery] = useState(whole ? '' : start.sapId || start.name || '');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState(USUAL_SORT);
  const sortKey = sort !== USUAL_SORT ? sort : '';
  const local = useMemo(() => (whole
    ? paginateDashboard(whole, { section: 'students', page: 1, pageSize: 200, search: query.trim(), filters: filters.join(','), sort: sortKey })
    : null), [whole, query, filters, sortKey]);
  const remote = useCached(whole ? null : dashboardPath(code, { section: 'students', page: 1, pageSize: 100, search: query.trim(), filters: filters.join(','), sort: sortKey, af: answerFilter }));
  const view = local || remote.data || null;
  const rows = view?.registrations || [];
  return (
    <StudentModal test={test} rows={rows} pool={rows} openId={openId} setOpenId={setOpenId} part={part} setPart={setPart}
      query={query} setQuery={setQuery} filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
      filterCounts={view?.filterCounts} pagination={view?.pagination} loading={!view}
      isBusy={isBusy} act={act} onOpenSapId={onOpenSapId} onOpenReopen={onOpenReopen} onReview={onReview} onClose={onClose}/>
  );
}

function StudentsSection({ test, rows, pool, counts, query, setQuery, filters, setFilters, sort, setSort, filterCounts, pagination, onPage, isBusy, act, onOpenSapId, onOpenReopen, onReview, answerFiltered = false }) {
  // The student open in the window, and the part of them open (kept moving from one student to the next).
  const [openId, setOpenId] = useState(null);
  const [part, setPart] = useState('details');
  const openStudent = (id) => { setPart('details'); setOpenId(id); };
  return (
    <section className="card students-card is-compact">
      <TableToolbar
        title="Students"
        summary={`${counts.total} registered · ${counts.started} started · ${counts.pending} awaiting approval${sortNote(STUDENT_SORTS, sort)}`}
        query={query} setQuery={setQuery} filters={filters} setFilters={setFilters}
        groups={studentFilters(test)} pool={pool} filterCounts={filterCounts} pagination={pagination} filterTitle="Sort & filter students" allLabel="Everyone"
        sorts={STUDENT_SORTS} sort={sort} onSort={setSort}
      >
        {!answerFiltered && <>
          <BulkDecisionMenu test={test} rows={rows} isBusy={isBusy} act={act}/>
          <BulkAttemptMenu test={test} rows={rows} query={query} filters={filters} pagination={pagination} isBusy={isBusy} act={act}/>
        </>}
      </TableToolbar>
      <div className="table-scroll">
        <table className="live-table student-accordion-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>
                <span className="th-with-tip">
                  Status
                  {/* What each status icon means; each also says so on hover. */}
                  <InfoTip label="What the status icons mean">
                    <p className="state-legend-title">Where they stand</p>
                    <ul className="state-legend">
                      {STATE_LEGEND.map(([id, look]) => <li key={id}><StateChip state={id}/>{look.label}</li>)}
                    </ul>
                    <p className="state-legend-title">Signs beside it</p>
                    <ul className="state-legend">
                      {SIGN_LEGEND.map((sign) => (
                        <li key={sign.label}>
                          <span className={`issue is-${sign.tone}`} aria-hidden="true"><sign.icon size={14}/>{sign.text}</span>
                          {sign.label}
                        </li>
                      ))}
                    </ul>
                    <p className="state-legend-note">Hover any icon in a row for what it means for that student.</p>
                  </InfoTip>
                </span>
              </th>
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
                openReopen={onOpenReopen}
                onOpen={() => openStudent(registration.id)}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">{answerFiltered ? 'No students match this filter.' : counts.total === 0 ? 'Nobody has registered yet. Share the QR from Overview.' : 'No students match this filter.'}</p>
        )}
      </div>
      <PageControls pagination={pagination} onPage={onPage}/>
      {openId && (
        <StudentModal test={test} rows={rows} pool={pool} openId={openId} setOpenId={setOpenId} part={part} setPart={setPart}
          query={query} setQuery={setQuery} filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
          filterCounts={filterCounts} pagination={pagination} isBusy={isBusy} act={act} onOpenSapId={onOpenSapId} onOpenReopen={onOpenReopen}
          onReview={onReview ? (id) => { setOpenId(null); onReview(id); } : null} onClose={() => setOpenId(null)}/>
      )}
    </section>
  );
}

/**
 * Continue paused papers across every matching page. Revive and Restart keep
 * their existing, explicitly shown-row scope.
 */
function BulkAttemptMenu({ test, rows, query, filters, pagination, isBusy, act }) {
  const locked = rows.filter((row) => row.isLocked && row.attemptStatus !== 'submitted');
  const paused = rows.filter((row) => row.attemptStatus === 'in_progress' && row.isPaused);
  const canContinue = !test.isClosed && (paused.length > 0 || (filters.includes('paper:paused') && pagination?.total > 0));
  const started = rows.filter((row) => row.attemptStatus);
  const ids = (list) => ({ registrationIds: list.map((row) => row.id) });
  const plural = (count) => `${count} student${count === 1 ? '' : 's'}`;
  return (
    <ActionMenu
      label="Attempt actions"
      icon={FileCog}
      disabled={isBusy || (locked.length === 0 && started.length === 0)}
      items={[
        canContinue && {
          label: 'Resume all paused',
          icon: Play,
          tone: 'ok',
          onSelect: () => act('attempts/bulk/continue',
            'Resume every paused student matching the current search and filter, including other pages? Their paused time is given back. A separately locked paper stays locked.',
            { scope: 'matching', search: query.trim(), filters })
        },
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

/** What freezing the results does, said before it is done (domain/freeze.js). */
function freezeQuestion(counts) {
  return [
    'Freeze the results? Their marks become final: no marking, no Excel upload, no editing the questions, and no restart, reset, resume or reopening a paper - until you unfreeze them. Releasing marks and exporting still work.',
    counts.awaitingMarking > 0 ? `${counts.awaitingMarking} paper${counts.awaitingMarking === 1 ? ' still has' : 's still have'} short answers to mark: they stay unmarked.` : ''
  ].filter(Boolean).join('\n\n');
}

/**
 * The Results tab: every handed-in paper, and what to do with them - review
 * them one by one (modals/ResultReviewModal.jsx), take them to Excel and back,
 * and freeze them once the marks are final (or unfreeze them to change again).
 */
function ResultsSection({ test, rows, pool, counts, query, setQuery, filters, setFilters, sort, setSort, filterCounts, pagination, onPage, isBusy, showToast, onReview, onUploadMarks, onFreeze, onEmail, onRelease, onHold, answerFiltered = false }) {
  const frozen = Boolean(test.resultsFrozenAt);
  return (
    <section className="card students-card is-compact results-section">
      <TableToolbar
        title="Results"
        summary={`${counts.submitted} submitted · ${frozen ? 'results frozen' : `${counts.awaitingMarking} awaiting marking`}${sortNote(RESULT_SORTS, sort)}`}
        query={query} setQuery={setQuery} filters={filters} setFilters={setFilters}
        groups={RESULT_FILTERS} pool={pool} filterCounts={filterCounts} pagination={pagination} filterTitle="Sort & filter results" allLabel="All submitted"
        sorts={RESULT_SORTS} sort={sort} onSort={setSort}
        sortHint={sort.startsWith('score-') && counts.awaitingMarking > 0
          ? `${counts.awaitingMarking} of ${counts.submitted} papers still have answers to mark. Until they are marked, a score counts only what has been marked${rows.length > 1 && rows.every((row) => row.score === rows[0].score) ? ' - so for now every score is the same, and the order is by hand-in time' : ''}.`
          : null}
      >
        {!answerFiltered && <>
        <button className="button button-primary" type="button" disabled={isBusy || !counts.submitted} aria-label="Review results" title="Go through the papers one by one: by student or by question"
          onClick={() => onReview(null)}>
          <ClipboardCheck size={16} aria-hidden="true"/><span className="toolbar-text">Review</span>
        </button>
        <ActionMenu
          label="Excel"
          icon={FileSpreadsheet}
          align="right"
          disabled={isBusy}
          items={[
            { label: 'Export Excel', icon: FileSpreadsheet, onSelect: () => downloadSpreadsheet(test.code).catch((error) => showToast(error.message)) },
            // Marks typed into the export's Marks sheet, sent back.
            !frozen && { label: 'Upload marks', icon: FileUp, onSelect: onUploadMarks }
          ]}
        />
        <ActionMenu label="Result actions" icon={MoreVertical} disabled={isBusy} items={[
          test.isClosed && counts.submitted > 0 && { label: 'Email results', icon: Mail, onSelect: onEmail },
          test.isClosed && ((test.resultReleaseMode === 'admin' && !test.resultsReleasedAt) || (counts.awaitingMarking > 0 && !test.releaseUnmarked)) && { label: 'Release marks', icon: Send, onSelect: onRelease },
          test.releaseUnmarked && { label: 'Hold unmarked results', icon: EyeOff, onSelect: onHold }
        ]}/>
        {/* Final marks: frozen once the test is closed, unfrozen to change them again. */}
        <button className={`button button-secondary freeze-toggle${frozen ? ' is-frozen' : ''}`} type="button"
          disabled={isBusy || (!frozen && !test.isClosed)} onClick={() => onFreeze(!frozen)}
          aria-label={frozen ? 'Unfreeze results' : 'Freeze results'}
          title={frozen ? 'The marks are final. Unfreeze them to change marks again'
            : test.isClosed ? 'Make the marks final: nothing can change them until you unfreeze' : 'Close the test before freezing its results'}>
          {frozen ? <LockOpen size={16} aria-hidden="true"/> : <Lock size={16} aria-hidden="true"/>}
          <span className="toolbar-text">{frozen ? 'Unfreeze' : 'Freeze'}</span>
        </button>
        </>}
      </TableToolbar>
      {answerFiltered && <p className="results-frozen-note">Open a student's paper below. Clear the answer analysis choices for class-wide actions.</p>}
      {frozen && (
        <p className="results-frozen-note"><Lock size={14} aria-hidden="true"/>Results frozen: the marks are final. Unfreeze them to change any.</p>
      )}
      <div className="table-scroll">
        <table className="live-table review-table">
          <thead>
            <tr>
              <th>Student</th><th className="cell-num col-answered">Answered</th><th className="cell-num">Marks</th><th>Finished</th>
              <th className="column-actions"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((registration) => (
              <ResponseRow key={registration.id} registration={registration} isBusy={isBusy} frozen={frozen} onReview={(row) => onReview(row.id)}/>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">{answerFiltered ? 'No results match this filter.' : counts.submitted === 0 ? 'No results yet. Submitted papers appear here.' : 'No results match this filter.'}</p>
        )}
      </div>
      <PageControls pagination={pagination} onPage={onPage}/>
    </section>
  );
}

/**
 * An action's reply - only the changed test or student, not the class - laid
 * onto a dashboard: that row replaced, the test's fields brought up to date.
 */
function withActionResult(current, response) {
  if (!current) return current;
  const registrations = response.registration
    ? current.registrations.map((entry) => (entry.id === response.registration.id ? response.registration : entry))
    : current.registrations;
  return {
    ...current,
    ...(response.serverTime ? { serverTime: response.serverTime } : {}),
    ...(response.test ? { test: { ...current.test, ...response.test } } : {}),
    registrations
  };
}

/**
 * Actions shown on the list the moment they are pressed - a decision, an
 * exception - and put back if the server refuses. Each gives the students it
 * changes and what changes; the server's reply then replaces those rows.
 * Anything that touches a paper (pause, hand in, restart…) waits for the server.
 */
const QUICK_ACTIONS = [
  [/^registrations\/([^/]+)\/approve$/, ([, id]) => ({ ids: [id], patch: { status: 'approved' } })],
  [/^registrations\/([^/]+)\/reject$/, ([, id]) => ({ ids: [id], patch: { status: 'rejected' } })],
  [/^registrations\/bulk\/approve$/, (_match, body, rows) => ({
    ids: body?.registrationIds || rows.filter((row) => row.status === 'pending').map((row) => row.id), patch: { status: 'approved' }
  })],
  [/^registrations\/bulk\/reject$/, (_match, body) => ({ ids: body?.registrationIds || [], patch: { status: 'rejected' } })],
  [/^registrations\/([^/]+)\/location-override$/, ([, id], body) => ({ ids: [id], patch: { locationOverride: Boolean(body?.enabled) } })],
  [/^registrations\/([^/]+)\/device-override$/, ([, id], body) => ({ ids: [id], patch: { deviceOverride: Boolean(body?.enabled) } })]
];
function quickAction(path, body, rows) {
  for (const [pattern, change] of QUICK_ACTIONS) {
    const match = pattern.exec(path);
    if (match) {
      const quick = change(match, body, rows);
      return quick.ids.length ? quick : null;
    }
  }
  return null;
}
/** `rows` with the students in `ids` changed by `change(row)`. */
const changeRows = (ids, change) => (current) => (current ? {
  ...current,
  registrations: current.registrations.map((row) => (ids.has(row.id) ? { ...row, ...change(row) } : row))
} : current);

export function DashboardScreen({ code, area = 'quizzes', answerFilter = '', navigation, go, showToast }) {
  const [answerFilterParam, setAnswerFilterParam] = useState(() => {
    // A valid all-ignored link is no filter. Invalid links are left intact so
    // the server/editor can explain them, never silently show an unfiltered list.
    try { return encodeAnswerFilters(decodeAnswerFilters(answerFilter)); }
    catch { return answerFilter; }
  });
  // ?tab=responses opens straight on a tab - the quiz list's "View results" does.
  // A link from when the analysis was a view of Results (?rview=analysis) opens the Analysis tab.
  const [tab, setTab] = useState(() => {
    const asked = fromAddress('rview') === 'analysis' ? 'analysis' : fromAddress('tab');
    const allowed = area === 'results' ? ['analysis', 'responses'] : ['test', 'students'];
    return allowed.includes(asked) ? asked : allowed[0];
  });
  const listAnswerFilter = ['students', 'responses'].includes(tab) ? answerFilterParam : '';
  // A class that fits in one reply (most do) is fetched whole, once, and kept
  // (lib/cache.js): every tab, search, filter, order and page is then worked
  // out here with the server's own rules (domain/dashboard-view.js) - no
  // request, no wait. A bigger class is paged by the server as before.
  const wholePath = wholeClassPath(code, listAnswerFilter);
  const whole = useCached(wholePath);
  // null until the first reply says; then whether the whole class came.
  const fits = whole.data ? (Number(whole.data.pagination?.pages) || 1) <= 1 : null;
  const fitsRef = useRef(fits);
  fitsRef.current = fits;
  const [serverPage, setServerPage] = useState(null);
  const [serverPagePath, setServerPagePath] = useState('');
  // Decisions and exceptions shown before the server has answered (QUICK_ACTIONS).
  const [quickActions, setQuickActions] = useState(0);
  const [query, setQuery] = useState(() => fromAddress('q'));
  const [studentFilterIds, setStudentFilterIds] = useState(() => filtersFromAddress('students', STUDENT_FILTER_IDS));
  const [resultFilterIds, setResultFilterIds] = useState(() => filtersFromAddress('results', RESULT_FILTER_IDS));
  const [resultSort, setResultSort] = useState(() => {
    const asked = fromAddress('sort');
    return RESULT_SORT_IDS.includes(asked) ? asked : LEGACY_RESULT_SORTS[asked] || USUAL_RESULT_SORT;
  });
  const [studentSort, setStudentSort] = useState(() => (STUDENT_SORT_IDS.includes(fromAddress('ssort')) ? fromAddress('ssort') : USUAL_SORT));
  const [page, setPage] = useState(1);
  const [debouncedQuery, setDebouncedQuery] = useState(() => fromAddress('q').trim());
  const [modal, setModal] = useState(() => !answerFilter && fromAddress('review') === 'question' ? { type: 'review', mode: 'question' } : null);
  // A student's window opened from another tab, on their Log (StudentLookup).
  const [lookup, setLookup] = useState(null);
  // Beside the code in the header: the Analysis tab's line about the test (AnalysisSection).
  const [headerLine, setHeaderLine] = useState(null);
  // A mark given or changed in the review: once it closes, the Analysis tab asks
  // for its figures again - one answer of several still to mark leaves the
  // counts as they were, so they alone would not tell it.
  const marked = useRef(false);
  const [marksVersion, setMarksVersion] = useState(0);
  const leaveReview = () => {
    void load();
    if (marked.current) { marked.current = false; setMarksVersion((version) => version + 1); }
  };
  const [actionPath, setActionPath] = useState('');
  const headRef = useRef(null);
  const previousNavigation = useRef(navigation);

  // Explicit navigation can target another tab of this same dashboard. Local
  // tab clicks only replace the address; a new navigation object means go/Back.
  useEffect(() => {
    if (!navigation || previousNavigation.current === navigation) return;
    previousNavigation.current = navigation;
    const asked = navigation.rview === 'analysis' ? 'analysis' : navigation.tab;
    const allowed = area === 'results' ? ['analysis', 'responses'] : ['test', 'students'];
    setTab(allowed.includes(asked) ? asked : allowed[0]);
    setModal(null); setLookup(null);
  }, [navigation, area]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Written back as they change - replaced, not added, so Back still leaves the page.
  useEffect(() => {
    const url = new URL(window.location.href);
    const keep = (key, value) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    keep('tab', tab === 'test' ? '' : tab);
    keep('q', debouncedQuery);
    keep('students', studentFilterIds.join(','));
    keep('results', resultFilterIds.join(','));
    keep('sort', resultSort === USUAL_RESULT_SORT ? '' : resultSort);
    keep('ssort', studentSort === USUAL_SORT ? '' : studentSort);
    keep('af', answerFilterParam);
    keep('rview', '');
    keep('review', '');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [tab, debouncedQuery, studentFilterIds, resultFilterIds, resultSort, studentSort, answerFilterParam]);

  const selectedFilters = tab === 'responses' ? resultFilterIds : tab === 'students' ? studentFilterIds : [];
  const filterKey = selectedFilters.join(',');
  const tabSort = tab === 'responses' ? resultSort : tab === 'students' ? studentSort : USUAL_SORT;
  const sortKey = tabSort !== USUAL_SORT ? tabSort : '';
  useEffect(() => { setPage(1); }, [tab, debouncedQuery, filterKey, sortKey]);

  // The whole class: as it stands now, asked for again.
  const loadWhole = useCallback(async (silent = false) => {
    try { return await loadCached(wholePath, { force: true }); }
    catch (error) { if (!silent) showToast(error.message); return null; }
  }, [wholePath, showToast]);
  const wholeFailed = !whole.data && whole.error;
  useEffect(() => { if (wholeFailed) showToast(wholeFailed.message); }, [wholeFailed, showToast]);

  // A bigger class: the page on screen, from the server. Only the newest
  // request may paint the screen. A search typed while a live refresh for the
  // old one was still on its way used to be overwritten by that refresh
  // landing late: the old list flashed back - the flicker.
  // The Test and Analysis tabs show no list: the server sends no rows for them.
  const listSection = tab === 'analysis' ? 'test' : tab;
  const pagePath = dashboardPath(code, { section: listSection, page, search: debouncedQuery, filters: filterKey, sort: sortKey, af: listAnswerFilter });
  const latestRequest = useRef(0);
  const inFlightLoad = useRef(null);
  const loadPage = useCallback(async (silent = false) => {
    const path = pagePath;
    // Events, the fallback timer and a button can all ask for the same page
    // at once. Share that one request instead of making MongoDB build the
    // same dashboard three times.
    if (inFlightLoad.current?.path === path) return inFlightLoad.current.promise;
    latestRequest.current += 1;
    const request = latestRequest.current;
    const promise = (async () => {
      try {
        const next = await loadCached(path, { force: true });
        if (request !== latestRequest.current) return null;
        setServerPage(next);
        setServerPagePath(path);
        return next;
      }
      catch (error) { if (!silent && request === latestRequest.current) showToast(error.message); }
      finally {
        if (inFlightLoad.current?.promise === promise) inFlightLoad.current = null;
      }
      return null;
    })();
    inFlightLoad.current = { path, promise };
    return promise;
  }, [pagePath, showToast]);
  const load = useCallback((silent = false) => (fitsRef.current === false ? loadPage(silent) : loadWhole(silent)), [loadPage, loadWhole]);
  const loadRef = useRef(load);
  loadRef.current = load;

  // What is on screen: worked out here for a class that came whole (as fast
  // as the teacher types or ticks), else the server's page.
  const searchNow = query.trim();
  const view = useMemo(() => (whole.data && fits
    ? paginateDashboard(whole.data, { section: listSection, page, pageSize: 100, search: searchNow, filters: filterKey, sort: sortKey })
    : null), [whole.data, fits, listSection, page, searchNow, filterKey, sortKey]);
  const dashboard = fits ? view : fits === false && serverPagePath === pagePath ? serverPage : null;

  // Admin mutation endpoints return only the changed test/row, not a full
  // class table. Paint that immediately, then reconcile counts and rows that
  // are not on this page in the background.
  const applyActionResult = useCallback((response) => {
    if (!response?.test && !response?.registration) return;
    updateCached(wholePath, (current) => withActionResult(current, response));
    setServerPage((current) => withActionResult(current, response));
  }, [wholePath]);
  const reconcileTimer = useRef(null);
  const scheduleReconcile = useCallback((delay = 900) => {
    window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      reconcileTimer.current = null;
      if (!document.hidden && !busyRef.current && !typingRef.current) void loadRef.current(true);
    }, delay);
  }, []);
  useEffect(() => () => window.clearTimeout(reconcileTimer.current), []);

  // A bigger class: its page as soon as the search, filter, order or page
  // changes - the one held from before at once, if there is one. A class that
  // came whole needs nothing here.
  useEffect(() => {
    if (fits !== false) return;
    const held = peekCached(pagePath);
    if (held) { setServerPage(held); setServerPagePath(pagePath); }
    void loadPage();
  }, [fits, pagePath, loadPage]);

  // Live: new registrations, answers and exits appear without reloading. The
  // refresh is silent, and it waits while a dialog is open or an action runs
  // so nothing changes under the admin's hand. A hidden tab does not poll.
  const busyRef = useRef(false);
  busyRef.current = Boolean(modal || actionPath || quickActions);
  // Mid-typing, a refresh would show a list the next keystroke replaces.
  const typingRef = useRef(false);
  typingRef.current = query.trim() !== debouncedQuery;
  // During a test every answer is an event. Refresh at most once per
  // LIVE_GAP_MS and never two at once: whatever arrives meanwhile is one more
  // refresh afterwards - always for the search as it now stands (loadRef).
  const liveBusy = useRef(false);
  const liveDirty = useRef(false);
  const refreshLive = useCallback(async () => {
    if (liveBusy.current) { liveDirty.current = true; return; }
    if (document.hidden || busyRef.current || typingRef.current) { liveDirty.current = true; return; }
    liveBusy.current = true;
    try {
      do {
        liveDirty.current = false;
        if (document.hidden || busyRef.current || typingRef.current) { liveDirty.current = true; break; }
        await loadRef.current(true);
        await new Promise((resolve) => { window.setTimeout(resolve, LIVE_GAP_MS); });
      } while (liveDirty.current);
    } finally { liveBusy.current = false; }
  }, []);
  useLiveUpdate(`/api/admin/tests/${encodeURIComponent(code)}/events`, refreshLive, Boolean(code));
  useEffect(() => {
    if (!modal && !actionPath && liveDirty.current && !document.hidden) {
      liveDirty.current = false;
      void refreshLive();
    }
  }, [modal, actionPath, refreshLive]);
  useEffect(() => {
    let timer;
    const refresh = async () => {
      let next = dashboard;
      if (!document.hidden && !busyRef.current && !typingRef.current) next = await load(true) || next;
      const live = next?.test?.isStarted && !next?.test?.isClosed;
      const attention = live || (next?.counts?.pending || 0) > 0;
      // EventSource is the normal fast path. This is deliberately only a
      // safety net for captive portals and old proxies, not a class-wide
      // five-second MongoDB poll during an exam.
      const base = next?.test?.isClosed ? 60_000 : attention ? 20_000 : 45_000;
      timer = window.setTimeout(refresh, base + Math.round(Math.random() * base * 0.4));
    };
    timer = window.setTimeout(refresh, 15_000 + Math.round(Math.random() * 4_000));
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

  // Shown on the list at once, put back if the server refuses (QUICK_ACTIONS).
  const actQuickly = async (path, body, { ids, patch }) => {
    const wanted = new Set(ids);
    const fields = Object.keys(patch);
    const rows = (fitsRef.current ? whole.data?.registrations : serverPage?.registrations) || [];
    const before = new Map(rows.filter((row) => wanted.has(row.id)).map((row) => [row.id, Object.fromEntries(fields.map((field) => [field, row[field]]))]));
    const show = changeRows(wanted, () => patch);
    updateCached(wholePath, show);
    setServerPage(show);
    setQuickActions((count) => count + 1);
    try {
      const next = await post(`/api/admin/tests/${encodeURIComponent(code)}/${path}`, body);
      applyActionResult(next);
      scheduleReconcile();
      showToast(typeof next?.affectedCount === 'number'
        ? `${next.affectedCount} student${next.affectedCount === 1 ? '' : 's'} updated.`
        : 'Dashboard updated.');
    } catch (error) {
      const undo = changeRows(wanted, (row) => before.get(row.id) || {});
      updateCached(wholePath, undo);
      setServerPage(undo);
      showToast(error.message);
    } finally {
      setQuickActions((count) => count - 1);
    }
  };

  // `done`: what to say once it worked, where "Dashboard updated" says too little.
  const act = async (path, confirmText, body, done = null) => {
    if (actionPath) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const quick = quickAction(path, body, (fitsRef.current ? whole.data?.registrations : serverPage?.registrations) || []);
    if (quick) return actQuickly(path, body, quick);
    setActionPath(path);
    try {
      const next = await post(`/api/admin/tests/${encodeURIComponent(code)}/${path}`, body);
      applyActionResult(next);
      // Do not hold a button response behind a complete dashboard build.
      // This one quiet reconciliation also covers totals or rows outside the
      // visible page, after the immediate response has already painted.
      scheduleReconcile();
      showToast(done || (typeof next?.affectedCount === 'number'
        ? `${next.affectedCount} student${next.affectedCount === 1 ? '' : 's'} updated.`
        : 'Dashboard updated.'), done ? 'success' : undefined);
    } catch (error) { showToast(error.message); }
    finally { setActionPath(''); }
  };

  usePageTitle({ students: 'Students', responses: 'Results', analysis: 'Analysis' }[tab], dashboard?.test.title);

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
    writing: all.filter((row) => row.attemptStatus === 'in_progress').length,
    lastOwnEndAt: null,
    // Papers the teacher's Close handed in: what Resume would reopen.
    handedInByClose: all.filter((row) => row.attemptStatus === 'submitted' && row.submittedBy === 'admin').length
  }), [all]);
  const counts = dashboard?.counts || localCounts;
  const classCounts = dashboard?.classCounts || counts;
  // The To mark tile, and Release's "Mark them first": the review, question by
  // question, on the first question with answers still to mark.
  const openMarking = () => {
    if (area !== 'results') { go(`/?admin=${encodeURIComponent(code)}&tab=responses&review=question`); return; }
    setTab('responses'); setModal({ type: 'review', mode: 'question' });
  };
  // A tile on the Test tab: the list it counts, filtered to just those.
  const openList = (nextTab, filters = []) => {
    const nextArea = ['responses', 'analysis'].includes(nextTab) ? 'results' : 'quizzes';
    if (nextArea !== area) {
      const params = new URLSearchParams({ admin: code, tab: nextTab });
      if (answerFilterParam) params.set('af', answerFilterParam);
      if (filters.length) params.set(nextTab === 'responses' ? 'results' : 'students', filters.join(','));
      go(`/?${params}`); return;
    }
    setQuery('');
    if (nextTab === 'students') setStudentFilterIds(filters);
    if (nextTab === 'responses') setResultFilterIds(filters);
    setTab(nextTab);
    window.scrollTo({ top: 0 });
  };

  if (!dashboard) return wholeFailed ? <section className="card empty" role="alert">
    <h1>Could not load this list</h1><p>{wholeFailed.message}</p>
    {listAnswerFilter && <button type="button" className="button button-secondary" onClick={() => setAnswerFilterParam('')}>Clear answer analysis</button>}
    <button type="button" className="button button-primary" onClick={() => { void loadWhole(); }}>Try again</button>
  </section> : <Skeleton rows={5} label="Loading the test"/>;

  const { test } = dashboard;
  const joinUrl = `${window.location.origin}/?test=${encodeURIComponent(test.code)}`;
  const isBusy = Boolean(actionPath);
  const closeModal = () => setModal(null);
  // A student's paper in the review, and their window on its Log: each has a button to the other.
  const openReview = (registrationId, questionId = null) => { if (!isBusy) setModal({ type: 'review', registrationId, questionId }); };
  const openLog = (registrationId, hint = {}) => { setModal(null); setLookup({ registrationId, part: 'log', ...hint }); };
  const matching = (section, af = answerFilterParam, { search: matchSearch = '' } = {}) => {
    const params = new URLSearchParams({ admin: code, tab: section });
    if (section === 'analysis') params.set('view', 'answers');
    if (af) params.set('af', af);
    if (matchSearch.trim()) params.set('q', matchSearch.trim());
    go(`/?${params}`);
  };

  return (
    <>
      <header className="dashboard-head" ref={headRef}>
        <div className="dashboard-heading">
          <button className="dashboard-back" type="button" onClick={() => go(`/?admin=${area}`)}
            aria-label={`Back to ${area === 'results' ? 'Results' : 'Quizzes'}`} title={`Back to ${area === 'results' ? 'Results' : 'Quizzes'}`}>
            <ArrowLeft size={18} aria-hidden="true"/>
          </button>
          <div className="dashboard-head-copy">
            <h1>
              <span className={`status-dot is-${phaseDot(test).tone}`} title={phaseDot(test).label} aria-label={phaseDot(test).label} role="img"/>
              {test.title}
            </h1>
            <span className="dash-code" title="Test code">{test.code}</span>
            {test.resultsFrozenAt && (
              <span className="pill frozen-pill" title="Marks are final until you unfreeze them (More → Unfreeze results)">
                <Lock size={12} aria-hidden="true"/>Results frozen
              </span>
            )}
            {tab === 'analysis' && <span className="dash-meta" ref={setHeaderLine}/>}
          </div>
        </div>
        {/* Released anyway, or frozen: the Results tab no longer flags papers to mark. */}
        <div className="dashboard-section-nav">
          <Tabs area={area} tab={tab} onSelect={setTab} counts={test.releaseUnmarked || test.resultsFrozenAt ? { ...classCounts, awaitingMarking: 0 } : classCounts}/>
          <button className="button button-secondary dashboard-area-link" type="button"
            onClick={() => (area === 'results' ? matching(answerFilterParam ? 'students' : 'test')
              // Results opens on its Analysis; a matching group carries on to the matching papers.
              : answerFilterParam ? matching('responses') : go(`/?admin=${encodeURIComponent(code)}&tab=analysis`))}>
            {area === 'results' ? <FileCog size={16} aria-hidden="true"/> : <BarChart3 size={16} aria-hidden="true"/>}
            {area === 'results' ? 'Manage quiz' : 'View results'}
          </button>
        </div>
      </header>

      {listAnswerFilter && dashboard.answerFilter && <div className="dashboard-answer-filter" role="status">
        <span>Answer analysis · {dashboard.answerFilter.matched} of {dashboard.answerFilter.totalSubmitted} submitted students</span>
        <div className="answer-cohort-actions" role="group" aria-label="Answer analysis actions">
          <button type="button" className="button button-secondary button-small" onClick={() => matching('analysis')}>Answer analysis</button>
          <button type="button" className="button button-secondary button-small" onClick={() => setAnswerFilterParam('')}>Clear</button>
        </div>
      </div>}

      {tab === 'test' && (
        <TestSection
          test={test}
          serverTime={dashboard.serverTime}
          counts={classCounts}
          isBusy={isBusy}
          act={act}
          onOpenSetup={() => setModal('setup')}
          onOpenRestart={() => setModal('restart')}
          onEdit={() => go(`/?admin=edit&code=${encodeURIComponent(code)}`)}
          onOpenQr={() => setModal('qr')}
          onOpenMarking={openMarking}
          onOpenRelease={() => setModal('release')}
          onOpenList={openList}
          onOpenEmail={() => setModal('email')}
          showToast={showToast}
        />
      )}

      {tab === 'students' && (
        <StudentsSection
          test={test}
          rows={all}
          pool={all}
          counts={counts}
          query={query} setQuery={setQuery} filters={studentFilterIds} setFilters={setStudentFilterIds}
          sort={studentSort} setSort={setStudentSort}
          filterCounts={dashboard.filterCounts} pagination={dashboard.pagination} onPage={setPage}
          isBusy={isBusy}
          act={act}
          onOpenSapId={(row) => { if (!isBusy) setModal({ type: 'sap', registration: row }); }}
          onOpenReopen={(row) => { if (!isBusy) setModal({ type: 'reopen', registration: row }); }}
          onReview={openReview}
          answerFiltered={Boolean(listAnswerFilter)}
        />
      )}

      {tab === 'responses' && (
        <ResultsSection
          test={test}
          rows={all}
          pool={all}
          counts={counts}
          query={query} setQuery={setQuery} filters={resultFilterIds} setFilters={setResultFilterIds}
          sort={resultSort} setSort={setResultSort}
          filterCounts={dashboard.filterCounts} pagination={dashboard.pagination} onPage={setPage}
          isBusy={isBusy}
          showToast={showToast}
          onReview={openReview}
          onUploadMarks={() => { if (!isBusy) setModal('upload-marks'); }}
          onFreeze={(freeze) => act('results/freeze', freeze ? freezeQuestion(counts) : 'Unfreeze the results? Marks can be changed again.', { frozen: freeze })}
          onEmail={() => setModal('email')}
          onRelease={counts.awaitingMarking > 0 && !test.releaseUnmarked ? () => setModal('release') : () => act('results/release')}
          onHold={() => act('results/unmarked', 'Hide marks from students whose short answers are not marked yet?', { show: false })}
          answerFiltered={Boolean(listAnswerFilter)}
        />
      )}

      {tab === 'analysis' && (
        <AnalysisSection test={test} counts={classCounts} serverTime={dashboard.serverTime} refresh={marksVersion} onReview={openReview} onLog={openLog}
          answerFilter={answerFilterParam} onAnswerFilterChange={setAnswerFilterParam} onMatching={matching} headerLine={headerLine}/>
      )}

      {modal === 'email' && <EmailResultsModal code={code} onClose={closeModal} showToast={showToast}/>}
      {modal === 'qr' && <QrModal test={test} joinUrl={joinUrl} onClose={closeModal} showToast={showToast}/>}
      {modal === 'setup' && <TestSetupModal code={code} test={test} onClose={closeModal} onSaved={(response) => { applyActionResult(response); scheduleReconcile(); }} showToast={showToast}/>}
      {modal?.type === 'review' && <ResultReviewModal code={code} startAt={modal.registrationId} startQuestion={modal.questionId ?? null} startMode={modal.mode || 'student'} onClose={() => { closeModal(); leaveReview(); }}
        onlyRegistrationId={answerFilterParam ? modal.registrationId : null}
        onChanged={() => { marked.current = true; scheduleReconcile(); }} showToast={showToast} onOpenLog={(registrationId, hint) => { openLog(registrationId, hint); leaveReview(); }}/>}
      {lookup && (
        <StudentLookup key={lookup.registrationId} code={code} test={test} whole={fits && (!answerFilterParam || listAnswerFilter) ? whole.data : null} start={lookup} isBusy={isBusy} act={act} answerFilter={answerFilterParam}
          onOpenSapId={(row) => { if (!isBusy) setModal({ type: 'sap', registration: row }); }}
          onOpenReopen={(row) => { if (!isBusy) setModal({ type: 'reopen', registration: row }); }}
          onReview={(registrationId) => { setLookup(null); openReview(registrationId); }} onClose={() => setLookup(null)}/>
      )}
      {modal === 'upload-marks' && <UploadMarksModal code={code} onClose={closeModal} onSaved={() => { void load(); }} showToast={showToast}/>}
      {modal === 'release' && <ReleaseMarksModal code={code} waiting={counts.awaitingMarking} onClose={closeModal} onMarkFirst={openMarking}
        onReleaseMarked={test.resultReleaseMode === 'admin' && !test.resultsReleasedAt ? () => act('results/release') : null}
        onSaved={(response) => { applyActionResult(response); scheduleReconcile(); }} showToast={showToast}/>}
      {modal === 'restart' && <RestartQuizModal code={code} test={test} counts={counts} onClose={closeModal} onSaved={(response) => { applyActionResult(response); scheduleReconcile(); }} showToast={showToast}/>}
      {modal?.type === 'sap' && <SapIdModal code={code} registration={modal.registration} onClose={closeModal} onSaved={(response) => { applyActionResult(response); scheduleReconcile(); }} showToast={showToast}/>}
      {modal?.type === 'reopen' && <ReopenPaperModal code={code} test={test} registration={modal.registration} onClose={closeModal} onSaved={(response) => { applyActionResult(response); scheduleReconcile(); }} showToast={showToast}/>}
      {/* Frozen results: the paper is shown, not marked. */}
      {modal?.type === 'analysis' && <StudentAnalysisModal code={code} registration={modal.registration} onClose={closeModal} onSaved={load} showToast={showToast} showIntegrity={false} readOnly={Boolean(test.resultsFrozenAt)}/>}
    </>
  );
}
