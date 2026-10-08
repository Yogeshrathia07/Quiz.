import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Circle, CircleCheck, Clock, Copy, Download, FileCheck2, Hourglass, IdCard, PenLine, Laptop, Lock, MapPin, MapPinOff, MonitorSmartphone, MoreVertical, Pause, Play, Repeat2, RotateCcw, Send, ShieldAlert, Smartphone, Tablet, Undo2, UserCheck, UserRound, UserX, WifiOff } from 'lucide-react';
import { prefetch, useCached } from '../../lib/cache.js';
import { recordPath as recordAddress } from '../../lib/dashboard-paths.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { PersonLink } from '../../components/PersonLink.jsx';
import { clockTime, copyText, dateTime, durationLabel, shortDateTime } from '../../lib/format.js';
import { downloadFile } from '../../lib/api.js';
import { ActivityLog } from './modals/StudentAnalysisModal.jsx';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { isGuest, venueStatus } from './student-filters.js';

const isFaculty = (registration) => registration.accountType === 'faculty';

const LEAVE_LABELS = {
  fullscreen: 'fullscreen', tab_switch: 'app/tab', focus_lost: 'other window or pop-up', reload: 'reload', not_fullscreen: 'no fullscreen', offline: 'offline', split_screen: 'split screen'
};

export const WINDOW_TEXT = {
  private: 'Incognito window',
  mobile: 'Phone browser (no extensions)',
  declared: 'Said Incognito; the check disagreed',
  unknown: 'Could not tell'
};

/** Offline periods noted rather than counted (older papers' offline leaves are left out). */
const offlineNoted = (record) => Math.max(0, (record?.offline?.count || 0) - (record?.leaves?.offline || 0));

/** A concise lifetime integrity record for the live student view. */
export function integrityText(registration) {
  const record = registration.integrity;
  if (!record) return '';
  const blocked = record.flagCount || 0;
  const breakdown = Object.entries(record.leaves || {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${LEAVE_LABELS[reason] || reason}`)
    .join(', ');
  // Offline periods are noted, never counted as leaving. Older papers counted
  // them as leaves, and show them in the breakdown above instead.
  const offlineCount = offlineNoted(record);
  const offline = offlineCount ? `offline ${offlineCount}× (${Math.round((record.offline.ms || 0) / 1000)}s, not counted)` : '';
  return [
    `Left ${record.leaveCount}× · ${Math.round(record.awayMs / 1000)}s away${breakdown ? ` (${breakdown})` : ''}`,
    offline,
    record.lateAnswers ? `${record.lateAnswers} answer${record.lateAnswers === 1 ? '' : 's'} arrived late` : '',
    registration.overLimit ? 'Over the limit' : '',
    record.lockCount ? `Locked ${record.lockCount}×` : '',
    blocked ? `${blocked} blocked action${blocked === 1 ? '' : 's'}` : ''
  ].filter(Boolean).join(' · ');
}

/**
 * "Guest: Ada Lovelace" -> "AL". Only words that start with a letter count,
 * so "Student Number 10" is "SN", not "S1" like every student after nine.
 */
function initials(name) {
  const all = String(name || '').replace(/^guest:\s*/i, '').trim().split(/\s+/).filter(Boolean);
  const words = all.filter((word) => /^\p{L}/u.test(word));
  if (!words.length) return (all[0] || '?').slice(0, 2).toUpperCase();
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * A small sign for something worth a look. Hovering it says what, at once
 * (components/HoverTips); clicking the row opens every detail.
 */
export function Issue({ icon: Icon, tone = 'warn', label, children }) {
  return (
    <span className={`issue is-${tone}`} data-tip={label} data-tip-tone={tone} aria-label={label} role="img">
      <Icon size={14} aria-hidden="true"/>{children}
    </span>
  );
}

/**
 * Name and SAP ID on one line; the email waits in the details. The name opens
 * them under Users - except where a click on it must choose them (`link` false).
 */
export function StudentIdentity({ registration, link = true }) {
  const guest = isGuest(registration);
  return (
    <div className="person">
      <span className={`person-avatar${guest ? ' is-guest' : ''}`} aria-hidden="true">{initials(registration.name)}</span>
      <div className="person-detail">
        <strong>{link ? <PersonLink email={registration.email} guest={guest}>{registration.name}</PersonLink> : registration.name}</strong>
        <span className="table-subtext">{isFaculty(registration) ? 'Faculty' : registration.sapId}</span>
      </div>
    </div>
  );
}

/**
 * Where a student stands, as a coloured icon rather than a word: their
 * request, then their paper. Each is named on hover and to a screen reader,
 * and the Status heading's (i) lists them all.
 */
const STATES = {
  pending: { icon: Hourglass, tone: 'warn', label: 'Waiting for approval' },
  rejected: { icon: UserX, tone: 'danger', label: 'Rejected' },
  approved: { icon: UserCheck, tone: 'ok', label: 'Approved' },
  not_started: { icon: Circle, tone: 'neutral', label: 'Not started' },
  writing: { icon: PenLine, tone: 'info', label: 'Writing' },
  paused: { icon: Pause, tone: 'warn', label: 'Paused' },
  locked: { icon: Lock, tone: 'danger', label: 'Locked' },
  submitted: { icon: FileCheck2, tone: 'ok', label: 'Submitted' }
};
export const STATE_LEGEND = Object.entries(STATES);

/**
 * The other signs a row can carry, for the Status heading's (i) - each one's
 * icon and colour as the row shows it, and what it means.
 */
export const SIGN_LEGEND = [
  { icon: AlertTriangle, tone: 'warn', text: '1×', label: 'Left the test - how many times (hover a row\'s sign for how long and why)' },
  { icon: ShieldAlert, tone: 'danger', text: '2×', label: 'Left the test past the limit, or their paper was locked' },
  { icon: CircleCheck, tone: 'ok', label: 'Never left the test' },
  { icon: Smartphone, tone: 'neutral', label: 'The device they used (phone, tablet or laptop); orange or red when it is not allowed or its signals disagree' },
  { icon: UserRound, tone: 'warn', text: 'Guest', label: 'Guest account: identity not verified' },
  { icon: Repeat2, tone: 'warn', text: '1', label: 'Moved their test to another browser or device' },
  { icon: MapPin, tone: 'danger', label: 'Away from the venue (blue: a location exception you gave)' },
  { icon: MapPinOff, tone: 'danger', label: 'Their location could not be checked' },
  { icon: WifiOff, tone: 'warn', text: '1', label: 'Went offline (noted, not counted as leaving), or away from the test right now' },
  { icon: Clock, tone: 'warn', text: '1', label: 'Answers that arrived late, held on their device by a lost connection' }
];
const paperState = (registration) => (!registration.attemptStatus ? 'not_started'
  : registration.attemptStatus === 'submitted' ? 'submitted'
    : registration.isPaused ? 'paused'
      : registration.isLocked ? 'locked' : 'writing');
/** The one or two states a student is in: their request, and once let in, their paper. */
export const statesOf = (registration) => (registration.status === 'approved' ? ['approved', paperState(registration)] : [registration.status]);

export function StateChip({ state }) {
  const look = STATES[state] || STATES.not_started;
  return (
    <span className={`issue state-chip is-${look.tone}`} data-tip={look.label} data-tip-tone={look.tone} aria-label={look.label} role="img">
      <look.icon size={14} aria-hidden="true"/>
    </span>
  );
}

/**
 * One compact table row. A click (or Enter) opens everything about the
 * student in a window over the list, so the list itself never moves. Its
 * buttons and menu work from the row without opening it. `onWarm`: what the
 * window will need, started when a mouse rests on the row, or it is pressed
 * or reached with Tab - a moment before the click lands.
 */
export function StudentListRow({ cells, actions, label, onOpen, onWarm }) {
  const resting = useRef(null);
  useEffect(() => () => window.clearTimeout(resting.current), []);
  const open = (event) => {
    if (event.target.closest('button, a, input, select, [role="menu"]')) return;
    onOpen();
  };
  const restOn = (event) => {
    if (!onWarm || event.pointerType !== 'mouse') return;
    window.clearTimeout(resting.current);
    resting.current = window.setTimeout(onWarm, 150);
  };
  return (
    <tr
      className="xrow"
      onClick={open}
      onPointerEnter={restOn}
      onPointerLeave={() => window.clearTimeout(resting.current)}
      onPointerDown={() => onWarm?.()}
      onFocus={() => onWarm?.()}
      aria-haspopup="dialog"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); onOpen(); }
      }}
    >
      {cells}
      <td className="xrow-actions" data-label="Actions"><div className="table-actions">{actions}</div></td>
    </tr>
  );
}

/** Where one student's record is kept, for the Log and Location tabs and its download. */
const recordPath = (code, registration) => recordAddress(code, registration.id);

/** Their whole record (answers, activity, integrity, venue, device, locations) as Excel, from a round green button. */
export function RecordDownload({ test, registration }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [asking, setAsking] = useState(false);
  if (!registration.attemptStatus) return null;
  const download = async () => {
    setAsking(false);
    setBusy(true);
    setProblem('');
    try {
      await downloadFile(`${recordPath(test.code, registration)}/record.xlsx`, `${test.code}-${registration.sapId || 'student'}-record.xlsx`);
    } catch (error) { setProblem(error.message); }
    setBusy(false);
  };
  const label = problem || `Download ${registration.name}'s full record (Excel)`;
  return (
    <>
      <button className="download-round is-small" type="button" disabled={busy} onClick={() => setAsking(true)} aria-label={label} title={label}>
        <Download size={16} aria-hidden="true"/>
      </button>
      {asking && (
        <ConfirmDialog title={`Download ${registration.name}'s record?`} onConfirm={download} onCancel={() => setAsking(false)}>
          An Excel file of everything on their test: answers and marks, activity, leaving the test, venue, device and location readings.
        </ConfirmDialog>
      )}
    </>
  );
}

/** A part's first line: how much is in it, and the download. */
function PartHead({ test, registration, text }) {
  return (
    <div className="student-log-head">
      <span>{text}</span>
      <RecordDownload test={test} registration={registration}/>
    </div>
  );
}

const READING = {
  inRange: { word: 'At the venue', tone: 'ok' },
  outOfRange: { word: 'Away', tone: 'bad' },
  inconclusive: { word: 'Unsure', tone: 'muted' }
};
const TAKEN_WHEN = { start: 'at Begin', timer: 'regular check', question: 'changed question', manual: 'checked again', blocked: 'while shut out', submit: 'at Submit' };
const readingClock = (value) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));

/**
 * Every location reading taken while their paper was open, newest first:
 * the coordinates (a tap copies them), and what the check made of it.
 */
function LocationReadings({ readings }) {
  const [copied, setCopied] = useState(null);
  const [problem, setProblem] = useState('');
  if (!readings.length) return <p className="help">No readings yet. One is kept at Begin, at each question change and about once a minute.</p>;
  const copy = async (text, key) => {
    try {
      await copyText(text);
      setProblem('');
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
    } catch (error) { setProblem(error.message); }
  };
  return (
    <>
      {problem && <p className="help" role="alert">{problem}</p>}
      <ol className="loc-list">
        {[...readings].reverse().map((reading) => {
          const key = `${reading.at}-${reading.trigger}`;
          const known = reading.latitude !== null && reading.longitude !== null;
          const text = known ? `${reading.latitude.toFixed(6)}, ${reading.longitude.toFixed(6)}` : '';
          const status = READING[reading.status] || READING.inconclusive;
          return (
            <li key={key} className={`loc-row is-${status.tone}`}>
              <time title={dateTime(reading.at)}>{readingClock(reading.at)}</time>
              {known ? (
                <button type="button" className="loc-coords" onClick={() => copy(text, key)} title="Copy latitude, longitude" aria-label={`Copy ${text}`}>
                  <span>{text}</span>
                  {copied === key ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}
                  {copied === key && <span className="loc-copied" role="status">Copied</span>}
                </button>
              ) : <span className="loc-none">No reading</span>}
              <span className="loc-meta">
                <span className="loc-status">{status.word}</span>
                {reading.distanceMeters !== null ? ` · ${reading.distanceMeters} m from venue` : ''}
                {reading.accuracyMeters !== null ? ` · ±${reading.accuracyMeters} m` : ''}
                {TAKEN_WHEN[reading.trigger] ? ` · ${TAKEN_WHEN[reading.trigger]}` : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * An opened row: one short line - their email and when they finished - and
 * a button for each part (details, log, location, device). Nothing more shows
 * until one is pressed, and pressing it again closes it. The buttons keep one
 * size whichever is pressed; on a phone they fold into one menu. Log and
 * Location show at once what was fetched before (fetched ahead when the
 * window opened - DashboardScreen) and are asked for again behind, so a
 * paper still being written shows its latest.
 */
function StudentPanel({ test, registration, brief, summary, venue, device, hasDevice, part, onPart: setPart }) {
  const fetched = part === 'log' || part === 'location';
  const base = recordPath(test.code, registration);
  const analysis = useCached(fetched ? `${base}/analysis` : null);
  const record = analysis.data || null;
  const problem = analysis.data ? '' : analysis.error?.message || '';
  const parts = [
    ['details', 'Details'],
    ['log', 'Log'],
    test.locationRequired && ['location', 'Location'],
    hasDevice && ['device', 'Device']
  ].filter(Boolean);
  const choose = (id) => setPart((current) => (current === id ? null : id));
  const open = parts.find(([id]) => id === part);
  const entries = record?.integrity?.activity || [];
  const readings = record?.locationTrail || [];
  const waiting = problem ? '' : 'Loading…';
  return (
    <div className="student-panel">
      <div className="student-panel-bar">
        {brief.length > 0 && <p className="student-brief">{brief.map((text) => <span key={text} title={text}>{text}</span>)}</p>}
        <div className="segmented student-panel-tabs" role="group" aria-label={`${registration.name}: show`}>
          {parts.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={part === id} className={part === id ? 'is-on' : ''} onClick={() => choose(id)}>{label}</button>
          ))}
        </div>
        <div className="student-panel-pick">
          <ActionMenu
            label={open ? open[1] : 'Show'}
            items={[...parts.map(([id, label]) => ({ label, tone: part === id ? 'info' : undefined, onSelect: () => setPart(id) })), part && { label: 'Hide', onSelect: () => setPart(null) }]}
          />
        </div>
      </div>
      {part && (
        // One box for the open part, the window's only scrolling area (the log and the readings scroll their own lists inside it).
        <div className={`student-part is-${part}`}>
          {part === 'details' && <dl className="detail-grid">{summary}</dl>}
          {part === 'device' && <dl className="detail-grid">{device}</dl>}
          {part === 'log' && (
            <div className="student-log">
              {problem && <p className="help" role="alert">{problem}</p>}
              {!record && !problem && <p className="help">{waiting}</p>}
              {record && <ActivityLog entries={entries} bare extra={<RecordDownload test={test} registration={registration}/>}/>}
            </div>
          )}
          {part === 'location' && (
            <div className="student-log">
              <dl className="detail-grid">{venue}</dl>
              <PartHead test={test} registration={registration}
                text={record ? `${readings.length} reading${readings.length === 1 ? '' : 's'}${readings.length > 1 ? ' · newest first' : ''}` : waiting}/>
              {problem && <p className="help" role="alert">{problem}</p>}
              {record && <LocationReadings readings={readings}/>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One fact in an opened row; nothing at all when there is nothing to say. */
export const Detail = ({ label, children }) => (children === null || children === undefined || children === false || children === '' ? null : (
  <div><dt>{label}</dt><dd>{children}</dd></div>
));

/**
 * Where a student stands on the venue check. A distance recorded without a
 * pass means they tried to start from too far away.
 */
function venueText(registration) {
  const known = registration.locationDistanceMeters !== null && registration.locationDistanceMeters !== undefined;
  const distance = known ? `${Math.round(Number(registration.locationDistanceMeters))} m` : null;
  return {
    exception: known ? `Exception granted · was ${distance} away` : 'Exception granted',
    in_range: distance ? `In range · ${distance}` : 'In range',
    out_of_range: `Out of range · ${distance}`,
    not_checked: 'Not checked'
  }[venueStatus(registration)];
}

/**
 * Why a student's page could not share a location at Begin, in a few words,
 * so you can tell a phone that never asked from one sitting outside - and
 * grant the exception that lets them in (the row's ⋮ menu).
 */
function locationProblemText(problem) {
  if (!problem) return '';
  return {
    denied: problem.asked === false ? 'Location is switched off for their browser — no question was shown' : 'They did not allow location',
    inapp: 'Opened inside another app (WhatsApp, Instagram…), which cannot share location',
    unavailable: 'Their device could not find its location (location services off?)',
    timeout: 'Finding their location took too long',
    insecure: 'Opened on a link that is not secure',
    unsupported: 'Their browser cannot share location',
    imprecise: `Shared only an approximate location${problem.accuracyMeters ? ` (±${problem.accuracyMeters} m)` : ''}`
  }[problem.reason] || 'Their location could not be checked';
}

const DEVICE_ICONS = { phone: Smartphone, tablet: Tablet, laptop: Laptop };
const DEVICE_NAMES = { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', unknown: 'Device not known' };
const STAGE_WORDS = { join: 'on joining', begin: 'at Begin', paper: 'on the paper' };
const deviceName = (entry) => `${DEVICE_NAMES[entry?.kind] || DEVICE_NAMES.unknown}${entry?.label ? ` · ${entry.label}` : ''}`;

/**
 * The device a student is on, as a small sign on their row: grey as a rule,
 * blue once you allowed their device, amber when its signals disagree or they
 * used more than one kind, red on a device the test does not allow.
 */
function deviceSign(test, registration) {
  const device = registration.device;
  if (!device) return null;
  const kinds = [...new Set((registration.deviceLog || []).map((entry) => entry.kind))];
  const wrong = !registration.deviceFits && !registration.deviceOverride;
  const tone = wrong ? 'danger' : device.suspicious || kinds.length > 1 ? 'warn' : registration.deviceOverride ? 'info' : 'neutral';
  const label = [
    deviceName(device),
    wrong ? `not allowed: this test is for ${test.devices === 'phone' ? 'phones' : 'laptops'} only` : '',
    registration.deviceOverride ? 'device allowed by you' : '',
    device.suspicious ? 'its signals disagree' : '',
    kinds.length > 1 ? `used a ${kinds.map((kind) => (DEVICE_NAMES[kind] || kind).toLowerCase()).join(' and a ')}` : ''
  ].filter(Boolean).join(' — ');
  return <Issue key="device-kind" icon={DEVICE_ICONS[device.kind] || MonitorSmartphone} tone={tone} label={label}/>;
}

/** The admission decision: who is allowed to sit this test. */
/**
 * What one student's row and window both show, worked out once: where they
 * stand (states and their signs), the buttons and menu for them, and the
 * facts behind Details, Location and Device.
 */
function studentParts({ test, registration, act, openSapId, openReopen, isBusy }) {
  const path = `registrations/${registration.id}`;
  const pending = registration.status === 'pending';
  const guest = isGuest(registration);
  const venue = venueStatus(registration);
  const checks = registration.locationChecks || {};
  const outsideNow = registration.venueClosed;
  const record = registration.integrity;
  const submitted = registration.attemptStatus === 'submitted';
  // A paper being written now (paused or not): the ones Pause and Submit paper apply to.
  const writing = registration.attemptStatus === 'in_progress';
  const integrity = integrityText(registration);
  // Each student's own time, still running: shown beside their status.
  const ownEnd = test.endMode === 'each' && writing && !registration.isPaused && Boolean(registration.ownDeadlineAt);
  const serious = registration.overLimit || registration.isLocked;
  const device = registration.device;
  const deviceWrong = device && !registration.deviceFits && !registration.deviceOverride;
  const began = registration.deviceBegan;
  const beganElsewhere = began && device && (began.kind !== device.kind || began.label !== device.label);
  const deviceRule = test.devices || 'any';

  const issues = [
    deviceSign(test, registration),
    guest && <Issue key="guest" icon={UserRound} label="Guest account: identity not verified">Guest</Issue>,
    registration.deviceSwitches > 0 && (
      <Issue key="device" icon={Repeat2} label={`Moved their test to another browser or device ${registration.deviceSwitches}×`}>{registration.deviceSwitches}</Issue>
    ),
    test.locationRequired && (venue === 'out_of_range' || outsideNow) && (
      <Issue key="venue" icon={MapPin} tone="danger" label={outsideNow ? 'Away from the venue right now' : venueText(registration)}/>
    ),
    test.locationRequired && venue === 'exception' && <Issue key="exception" icon={MapPin} label={venueText(registration)}/>,
    test.locationRequired && venue === 'not_checked' && registration.locationProblem && (
      <Issue key="location-problem" icon={MapPinOff} tone="danger" label={`${locationProblemText(registration.locationProblem)}. To let them in: ⋮ → Allow location exception.`}/>
    )
  ].filter(Boolean);

  const integritySigns = [
    record?.isAway && !registration.isLocked && registration.attemptStatus === 'in_progress' && <Issue key="away" icon={WifiOff} label="Away from the test right now"/>,
    record && record.leaveCount > 0 && (
      <Issue key="left" icon={serious ? ShieldAlert : AlertTriangle} tone={serious ? 'danger' : 'warn'} label={integrity}>{record.leaveCount}×</Issue>
    ),
    registration.windowCheck === 'declared' && <Issue key="window" icon={AlertTriangle} tone="danger" label="Incognito not verified"/>,
    // Noted to be checked, never counted as leaving: the times are in their activity log.
    offlineNoted(record) > 0 && (
      <Issue key="offline" icon={WifiOff} tone="warn" label={`Went offline ${offlineNoted(record)}× for ${Math.round((record.offline.ms || 0) / 1000)}s in total (not counted as leaving): see their activity log`}>{offlineNoted(record)}</Issue>
    ),
    record?.lateAnswers > 0 && (
      <Issue key="late" icon={Clock} tone="warn" label={`${record.lateAnswers} answer${record.lateAnswers === 1 ? '' : 's'} arrived late, held on their device by a lost connection: see their answers`}>{record.lateAnswers}</Issue>
    ),
    record && !record.leaveCount && !registration.isLocked && registration.attemptStatus && <Issue key="clean" icon={CircleCheck} tone="ok" label="Never left the test"/>
  ].filter(Boolean);

  // The same buttons and menu on the row and in the window.
  const actions = (<>
    {registration.isLocked && (
      <button className="button button-primary button-small" disabled={isBusy} onClick={() => act(`${path}/resume`, 'Revive this attempt? Their leaving and away-time allowances restart; the test end time does not move.')}>Revive</button>
    )}
    {writing && registration.isPaused && (
      <button className="button button-success button-small" disabled={isBusy} onClick={() => act(`${path}/continue`)}>Continue</button>
    )}
    {pending && (
      <>
        <button className="button button-primary button-small" disabled={isBusy} onClick={() => act(`${path}/approve`)}>Approve</button>
        <button className="button button-reject button-small" disabled={isBusy} onClick={() => act(`${path}/reject`)}>Reject</button>
      </>
    )}
    <ActionMenu
      disabled={isBusy}
      trigger="icon"
      label={<MoreVertical size={16} aria-label={`More for ${registration.name}`}/>}
      items={[
        !isFaculty(registration) && { label: 'Edit SAP ID', icon: IdCard, onSelect: () => openSapId(registration) },
        registration.status === 'rejected' && { label: 'Approve', icon: UserCheck, tone: 'ok', onSelect: () => act(`${path}/approve`) },
        test.locationRequired && {
          label: registration.locationOverride ? 'Remove location exception' : 'Allow location exception',
          icon: registration.locationOverride ? MapPinOff : MapPin,
          tone: registration.locationOverride ? 'warn' : 'info',
          onSelect: () => act(`${path}/location-override`, null, { enabled: !registration.locationOverride })
        },
        // Phones only or laptops only: this student may use whatever they have.
        (deviceRule !== 'any' || registration.deviceOverride) && {
          label: registration.deviceOverride ? 'Remove device exception' : 'Allow any device',
          icon: MonitorSmartphone,
          tone: registration.deviceOverride ? 'warn' : 'info',
          onSelect: () => act(`${path}/device-override`, null, { enabled: !registration.deviceOverride })
        },
        // Green keeps or approves, blue adjusts, amber stops for now, red ends or wipes.
        writing && !registration.isPaused && {
          label: 'Pause (stop their time)', icon: Pause, tone: 'warn',
          onSelect: () => act(`${path}/pause`, `Pause ${registration.name}? Their paper is hidden and their time stops until you continue it.`)
        },
        writing && registration.isPaused && { label: 'Continue', icon: Play, tone: 'ok', onSelect: () => act(`${path}/continue`) },
        writing && {
          label: 'Submit paper now', icon: Send, danger: true,
          onSelect: () => act(`${path}/submit`, `Hand in ${registration.name}'s paper now, with the answers saved so far? They cannot carry on after this.`)
        },
        // Handed in: back to where they left off (a timer on each question makes every question final, so not there).
        registration.attemptStatus === 'submitted' && !test.strictTiming && openReopen && {
          label: 'Reopen paper', icon: Undo2, tone: 'info', onSelect: () => openReopen(registration)
        },
        registration.attemptStatus && { label: 'Restart attempt', icon: RotateCcw, danger: true, onSelect: () => act(`${path}/restart`, 'Restart this student’s attempt with a blank paper?') },
        registration.status === 'approved' && { label: 'Reject registration', icon: UserX, danger: true, onSelect: () => act(`${path}/reject`) }
      ]}
    />
  </>);
  const states = statesOf(registration);
  const signs = (
    <div className="cell-row student-status-cluster">
      {states.map((state) => <StateChip key={state} state={state}/>)}
      {/* Each student's own time: when this student's runs out. */}
      {ownEnd && (
        <span className="pill status-pill muted own-end" data-tip={`Their own time ends at ${clockTime(registration.ownDeadlineAt)}`}>
          <Clock size={12} aria-hidden="true"/>ends {clockTime(registration.ownDeadlineAt)}
        </span>
      )}
      {issues}
      {integritySigns}
    </div>
  );
  return {
    states,
    signs,
    actions,
    label: `${registration.name}, ${states.map((state) => STATES[state].label.toLowerCase()).join(', ')}`,
    panel: {
      brief: [
        !guest && registration.email,
        registration.attemptStatus && `${submitted ? 'Finished' : 'Started'} ${shortDateTime(submitted ? registration.submittedAt : registration.startedAt)}`
      ].filter(Boolean),
      hasDevice: Boolean(device || registration.windowCheck || registration.deviceSwitches > 0),
      summary: <>
        {registration.decidedAt && <Detail label={registration.status === 'rejected' ? 'Rejected' : 'Approved'}>{shortDateTime(registration.decidedAt)}</Detail>}
        {guest && registration.exitedAt && <Detail label="Left">{shortDateTime(registration.exitedAt)}</Detail>}
        {submitted && registration.startedAt && <Detail label="Started">{shortDateTime(registration.startedAt)}</Detail>}
        {writing && registration.isPaused && <Detail label="Paused since">{shortDateTime(registration.pausedAt)} — their time is stopped</Detail>}
        {registration.extraMs > 0 && <Detail label="Extra time">{durationLabel(Math.round(registration.extraMs / 1000))} {test.endMode === 'each' ? 'added to their own time, for extensions, pauses or a reopened paper' : <>after the test&apos;s end, for pauses or a reopened paper</>}{registration.ownDeadlineAt && writing ? ` · their paper ends at ${shortDateTime(registration.ownDeadlineAt)}` : ''}</Detail>}
        {record && <Detail label="Leaving the test">{integrity}</Detail>}
        {registration.overLimit && (
          <Detail label="Over the limit">
            {[
              registration.overLimit.exits ? `left ${registration.overLimit.leaveCount}×, allowed ${registration.overLimit.exitLimit}` : '',
              registration.overLimit.away ? `away ${Math.round((registration.overLimit.awayMs ?? registration.overLimit.longestAwayMs) / 1000)}s in total, allowed ${registration.overLimit.awayLimitSeconds}s` : ''
            ].filter(Boolean).join(' · ')}
          </Detail>
        )}
      </>,
      venue: <>
        <Detail label="Venue">
          {venueText(registration)}{registration.locationVerifiedAt ? ` · checked ${shortDateTime(registration.locationVerifiedAt)}` : ''}
          {venue === 'not_checked' && registration.locationProblem ? ` · ${locationProblemText(registration.locationProblem)} (${shortDateTime(registration.locationProblem.at)})` : ''}
        </Detail>
        {checks.inRange || checks.outOfRange || checks.inconclusive ? (
          <Detail label="During the test">
            {checks.inRange || 0} in · {checks.outOfRange || 0} out · {checks.inconclusive || 0} uncertain{checks.outsideCount ? ` · left ${checks.outsideCount}×` : ''}
          </Detail>
        ) : null}
      </>,
      device: <>
        {device && (
          <Detail label="Device">
            {deviceName(device)}
            {registration.deviceOverride ? ' · allowed by you' : deviceWrong ? ' · not allowed on this test' : ''}
            {device.at ? ` · seen ${STAGE_WORDS[device.stage] || ''} ${shortDateTime(device.at)}` : ''}
          </Detail>
        )}
        {beganElsewhere && <Detail label="Began on">{deviceName(began)}</Detail>}
        {device?.facts && <Detail label="Device signals">{device.facts}</Detail>}
        {device?.notes?.length > 0 && <Detail label="Device notes">{device.notes.join(' ')}</Detail>}
        {registration.deviceLog?.length > 1 && (
          <Detail label="Devices seen">
            {registration.deviceLog.map((entry) => `${deviceName(entry)} ${STAGE_WORDS[entry.stage] || ''} ${shortDateTime(entry.at)}`).join(' → ')}
          </Detail>
        )}
        {registration.deviceSwitches > 0 && <Detail label="Switched browser">{registration.deviceSwitches}×</Detail>}
        {registration.windowCheck && <Detail label="Browser window">{WINDOW_TEXT[registration.windowCheck] || registration.windowCheck}</Detail>}
      </>
    }
  };
}

/** One student's row in the list; a click opens their window (StudentWindow). */
export function StudentRow({ onOpen, ...props }) {
  const { registration } = props;
  const { signs, actions, label } = studentParts(props);
  return (
    <StudentListRow
      onOpen={onOpen}
      onWarm={() => prefetch(`${recordPath(props.test.code, registration)}/analysis`, { maxAgeMs: 15_000 })}
      label={`${label}: open details`}
      cells={<>
        <td data-label="Student"><StudentIdentity registration={registration}/></td>
        <td data-label="Status">{signs}</td>
        <td data-label="Answered" className="cell-num col-answered">{registration.attemptStatus ? `${registration.answeredCount}/${registration.totalQuestions}` : '—'}</td>
      </>}
      actions={actions}
    />
  );
}

/**
 * One student in the window over the list: who, the same buttons as their
 * row, where they stand, then Details / Log / Location / Device - the part
 * open (`part`) kept by the window, so it stays open moving from one student
 * to the next.
 */
export function StudentWindow({ part, onPart, ...props }) {
  const { test, registration } = props;
  const { states, signs, actions, panel } = studentParts(props);
  return (
    <>
      <header className="student-modal-head">
        <StudentIdentity registration={registration}/>
        <div className="student-modal-actions">{actions}</div>
      </header>
      <div className="student-modal-states">
        {signs}
        <span className="student-modal-words">{states.map((state) => STATES[state].label).join(' · ')}</span>
      </div>
      <StudentPanel key={registration.id} test={test} registration={registration} part={part} onPart={onPart} {...panel}/>
    </>
  );
}
