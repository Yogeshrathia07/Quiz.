import { useState } from 'react';
import { AlertTriangle, ChevronDown, CircleCheck, ClipboardPaste, IdCard, Keyboard, Lock, MapPin, MapPinOff, MoreVertical, Pause, Play, Puzzle, Repeat2, RotateCcw, Send, ShieldAlert, UserCheck, UserRound, UserX, WifiOff } from 'lucide-react';
import { durationLabel, shortDateTime } from '../../lib/format.js';
import { StatusPill } from '../../components/StatusPill.jsx';
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

/** A concise lifetime integrity record for the live student view. */
export function integrityText(registration) {
  const record = registration.integrity;
  if (!record) return '';
  const extension = record.flags?.extension || 0;
  const bursts = record.flags?.text_burst || 0;
  const blocked = (record.flagCount || 0) - extension - bursts;
  const breakdown = Object.entries(record.leaves || {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${LEAVE_LABELS[reason] || reason}`)
    .join(', ');
  return [
    `Left ${record.leaveCount}× · ${Math.round(record.awayMs / 1000)}s away${breakdown ? ` (${breakdown})` : ''}`,
    registration.overLimit ? 'Over the limit' : '',
    record.lockCount ? `Locked ${record.lockCount}×` : '',
    blocked ? `${blocked} blocked action${blocked === 1 ? '' : 's'}` : '',
    extension ? 'browser extension seen' : '',
    bursts ? `text appeared all at once ${bursts}×` : ''
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
 * A small sign for something worth a look. Hovering it says what; clicking
 * the row opens every detail.
 */
export function Issue({ icon: Icon, tone = 'warn', label, children }) {
  return (
    <span className={`issue is-${tone}`} title={label} aria-label={label} role="img">
      <Icon size={14} aria-hidden="true"/>{children}
    </span>
  );
}

/** Name and SAP ID on one line; the email waits in the details. */
export function StudentIdentity({ registration }) {
  const guest = isGuest(registration);
  return (
    <div className="person">
      <span className={`person-avatar${guest ? ' is-guest' : ''}`} aria-hidden="true">{initials(registration.name)}</span>
      <div className="person-detail">
        <strong>{registration.name}</strong>
        <span className="table-subtext">{isFaculty(registration) ? 'Faculty' : registration.sapId}</span>
      </div>
      <ChevronDown className="row-caret" size={16} aria-hidden="true"/>
    </div>
  );
}

/**
 * One compact table row that opens on click into a full-width panel with
 * everything else. Its actions show on hover, on keyboard focus and while
 * open; on a touch screen, always.
 */
export function ExpandableRow({ columns, cells, details, actions, label, open: controlledOpen, onOpenChange }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  const toggle = (event) => {
    if (event.target.closest('button, a, input, select')) return;
    setOpen((value) => !value);
  };
  return (
    <>
      <tr
        className={`xrow${open ? ' is-open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={label}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); setOpen((value) => !value); }
        }}
      >
        {cells}
        <td className="xrow-actions" data-label="Actions"><div className="table-actions">{actions}</div></td>
      </tr>
      {open && (
        <tr className="xrow-details">
          <td colSpan={columns}><dl className="detail-grid">{details}</dl></td>
        </tr>
      )}
    </>
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

/** The admission decision: who is allowed to sit this test. */
export function StudentRow({ test, registration, act, openSapId, isBusy, columns, open, onOpenChange }) {
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
  const serious = registration.overLimit || registration.isLocked;

  const issues = [
    guest && <Issue key="guest" icon={UserRound} label="Guest account: identity not verified">Guest</Issue>,
    registration.deviceSwitches > 0 && (
      <Issue key="device" icon={Repeat2} label={`Moved their test to another browser or device ${registration.deviceSwitches}×`}>{registration.deviceSwitches}</Issue>
    ),
    test.locationRequired && (venue === 'out_of_range' || outsideNow) && (
      <Issue key="venue" icon={MapPin} tone="danger" label={outsideNow ? 'Away from the venue right now' : venueText(registration)}/>
    ),
    test.locationRequired && venue === 'exception' && <Issue key="exception" icon={MapPin} label={venueText(registration)}/>
  ].filter(Boolean);

  const integritySigns = [
    registration.isLocked && <Issue key="lock" icon={Lock} tone="danger" label="Attempt locked: waiting for you to revive it"/>,
    record?.isAway && !registration.isLocked && registration.attemptStatus === 'in_progress' && <Issue key="away" icon={WifiOff} label="Away from the test right now"/>,
    record && record.leaveCount > 0 && (
      <Issue key="left" icon={serious ? ShieldAlert : AlertTriangle} tone={serious ? 'danger' : 'warn'} label={integrity}>{record.leaveCount}×</Issue>
    ),
    registration.windowCheck === 'declared' && <Issue key="window" icon={AlertTriangle} tone="danger" label="Incognito not verified"/>,
    record?.flags?.extension > 0 && <Issue key="extension" icon={Puzzle} tone="danger" label="A browser extension changed the test page"/>,
    record?.flags?.text_burst > 0 && (
      <Issue key="burst" icon={ClipboardPaste} tone="danger" label={`Text appeared all at once ${record.flags.text_burst}× (pasted, or voice typing): see the answers`}>{record.flags.text_burst}</Issue>
    ),
    // Left while typing and back within moments - most likely the keyboard's own app. Not counted as leaving.
    record?.flags?.keyboard_app > 0 && (
      <Issue key="keyboard" icon={Keyboard} tone="warn" label={`Keyboard opened another app while typing ${record.flags.keyboard_app}× (back within 15 s; not counted as leaving)`}>{record.flags.keyboard_app}</Issue>
    ),
    record && !record.leaveCount && !registration.isLocked && registration.attemptStatus && <Issue key="clean" icon={CircleCheck} tone="ok" label="Never left the test"/>
  ].filter(Boolean);

  return (
    <ExpandableRow
      columns={columns}
      open={open}
      onOpenChange={onOpenChange}
      label={pending ? `${registration.name}, waiting for your decision` : registration.name}
      cells={<>
        <td data-label="Student"><StudentIdentity registration={registration}/></td>
        <td data-label="Status">
          <div className="cell-row student-status-cluster">
            <StatusPill status={registration.status}/>
            {registration.attemptStatus
              ? <span className={`pill status-pill ${registration.isPaused && !submitted ? 'paused' : registration.isLocked ? 'danger' : submitted ? 'success' : 'warn'}`}>
                  {registration.isPaused && !submitted ? 'Paused' : registration.isLocked ? 'Locked' : submitted ? 'Submitted' : 'In progress'}
                </span>
              : <span className="pill status-pill muted">Not started</span>}
            {issues}
            {integritySigns}
          </div>
        </td>
        <td data-label="Answered" className="cell-num col-answered">{registration.attemptStatus ? `${registration.answeredCount}/${registration.totalQuestions}` : '—'}</td>
      </>}
      details={<>
        {!guest && <Detail label="Email">{registration.email}</Detail>}
        <Detail label="SAP ID">{isFaculty(registration) ? 'Faculty' : registration.sapId}</Detail>
        <Detail label="Asked">{shortDateTime(registration.requestedAt)}</Detail>
        {registration.decidedAt && <Detail label={registration.status === 'rejected' ? 'Rejected' : 'Approved'}>{shortDateTime(registration.decidedAt)}</Detail>}
        {guest && registration.exitedAt && <Detail label="Left">{shortDateTime(registration.exitedAt)}</Detail>}
        {registration.deviceSwitches > 0 && <Detail label="Switched browser">{registration.deviceSwitches}×</Detail>}
        {registration.attemptStatus && <Detail label={submitted ? 'Finished' : 'Started'}>{shortDateTime(submitted ? registration.submittedAt : registration.startedAt)}</Detail>}
        {writing && registration.isPaused && <Detail label="Paused since">{shortDateTime(registration.pausedAt)} — their time is stopped</Detail>}
        {registration.extraMs > 0 && <Detail label="Time given back">{durationLabel(Math.round(registration.extraMs / 1000))} for pauses{registration.ownDeadlineAt && writing ? ` · their paper ends at ${shortDateTime(registration.ownDeadlineAt)}` : ''}</Detail>}
        {record && <Detail label="Leaving the test">{integrity}</Detail>}
        {registration.overLimit && (
          <Detail label="Over the limit">
            {[
              registration.overLimit.exits ? `left ${registration.overLimit.leaveCount}×, allowed ${registration.overLimit.exitLimit}` : '',
              registration.overLimit.away ? `away ${Math.round((registration.overLimit.awayMs ?? registration.overLimit.longestAwayMs) / 1000)}s in total, allowed ${registration.overLimit.awayLimitSeconds}s` : ''
            ].filter(Boolean).join(' · ')}
          </Detail>
        )}
        {registration.windowCheck && <Detail label="Browser window">{WINDOW_TEXT[registration.windowCheck] || registration.windowCheck}</Detail>}
        {test.locationRequired && (
          <Detail label="Venue">{venueText(registration)}{registration.locationVerifiedAt ? ` · checked ${shortDateTime(registration.locationVerifiedAt)}` : ''}</Detail>
        )}
        {test.locationRequired && (checks.inRange || checks.outOfRange || checks.inconclusive) ? (
          <Detail label="During the test">
            {checks.inRange || 0} in · {checks.outOfRange || 0} out · {checks.inconclusive || 0} uncertain{checks.outsideCount ? ` · left ${checks.outsideCount}×` : ''}
          </Detail>
        ) : null}
      </>}
      actions={<>
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
            registration.attemptStatus && { label: 'Restart attempt', icon: RotateCcw, danger: true, onSelect: () => act(`${path}/restart`, 'Restart this student’s attempt with a blank paper?') },
            registration.status === 'approved' && { label: 'Reject registration', icon: UserX, danger: true, onSelect: () => act(`${path}/reject`) }
          ]}
        />
      </>}
    />
  );
}
