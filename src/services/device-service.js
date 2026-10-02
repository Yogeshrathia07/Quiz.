import { dateMs, now } from '../lib/time.js';
import { MAX_EVENTS } from '../domain/integrity.js';
import {
  DEVICE_NOTES, classifyDevice, deviceFactLine, deviceFits, deviceVerdict, readSignals, requestSignals
} from '../domain/device.js';
import { adminEmail, registrationFor, requireTestForStudent, updateRegistration } from '../data/test-repository.js';

/** A report that says nothing new is written again only this often: the page reports on every load. */
const RECORD_AGAIN_MS = 10 * 60_000;
/** How many changes of device are kept per student. */
const DEVICE_LOG_MAX = 12;

/** The device this request came from (see domain/device.js). */
export const deviceFromRequest = (req, rawSignals) => classifyDevice(readSignals(rawSignals), requestSignals(req.headers));

/** The teacher's own test: they may preview it on anything. */
export const ownsTest = (req, test) => Boolean(test.ownerEmail) && test.ownerEmail === adminEmail(req);

/** What a student's own page is told: never the notes, which would say what to fake. */
const studentDevice = (device) => ({ kind: device.kind, label: device.label, facts: deviceFactLine(device.facts) });

/**
 * Keeps what this student's device reported: the latest report, a short log
 * of every change of device, and - on an open paper - a line in its activity
 * when the paper is opened on a different kind of device than the last one.
 * Nothing is written when nothing changed, so a page's reloads cost nothing.
 */
export async function recordDevice(test, registration, device, stage) {
  const at = now();
  const last = registration.device;
  const sameReport = last && last.kind === device.kind && last.label === device.label && last.stage === stage
    && String(last.notes || []) === String(device.notes);
  const fresh = last?.at && at.getTime() - dateMs(last.at) < RECORD_AGAIN_MS;
  const lastLogged = (registration.deviceLog || []).at(-1);
  const newDevice = !lastLogged || lastLogged.kind !== device.kind || lastLogged.label !== device.label;
  const attempt = registration.attempt;
  const switched = stage === 'paper' && attempt?.status === 'in_progress' && last?.kind && last.kind !== device.kind;
  if (sameReport && fresh && !newDevice) return;

  const update = {
    $set: {
      device: {
        kind: device.kind, label: device.label, notes: device.notes, suspicious: device.suspicious,
        facts: device.facts, userAgent: device.userAgent, stage, at
      }
    }
  };
  const push = {};
  if (newDevice) push.deviceLog = { $each: [{ kind: device.kind, label: device.label, stage, at }], $slice: -DEVICE_LOG_MAX };
  if (switched) {
    push['attempt.events'] = {
      $each: [{ type: 'device_kind_changed', createdAt: at, durationMs: null, detail: `${device.kind}:${attempt.device?.kind || last.kind}`, note: device.label }],
      $slice: -MAX_EVENTS
    };
  }
  if (Object.keys(push).length) update.$push = push;
  await updateRegistration(test.code, registration.id, update);
  registration.device = update.$set.device;
}

/**
 * A student's page asks whether this device may sit the test - before they
 * sign in, while they wait, and when the paper opens - and, once they are
 * registered, what it reported is kept for their teacher. The server decides
 * again at Begin (startAttempt), whatever the page did with this answer.
 */
export async function checkTestDevice(req, code, raw = {}) {
  const test = await requireTestForStudent(req, code);
  const device = deviceFromRequest(req, raw.device);
  const registration = registrationFor(req, test);
  if (registration) await recordDevice(test, registration, device, raw.stage === 'paper' ? 'paper' : 'join');
  return { ...deviceVerdict(test, registration, device, { exempt: ownsTest(req, test) }), device: studentDevice(device) };
}

/**
 * The check page (?page=window-check): what this device is taken for, with
 * every signal and disagreement, so a teacher can try phones and laptops
 * before a test. Nothing is kept.
 */
export function checkAnyDevice(req, raw = {}) {
  const device = deviceFromRequest(req, raw.device);
  return {
    device: {
      kind: device.kind,
      label: device.label,
      facts: deviceFactLine(device.facts),
      notes: device.notes.map((note) => DEVICE_NOTES[note]),
      suspicious: device.suspicious
    },
    fits: { phone: deviceFits('phone', device.kind), laptop: deviceFits('laptop', device.kind) }
  };
}
