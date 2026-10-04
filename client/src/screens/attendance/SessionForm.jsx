import { useState } from 'react';
import { SwitchRow } from '../../components/FormControls.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { VenueFields } from '../../components/VenueFields.jsx';

const venueBody = (values) => ({
  locationRequired: values.locationRequired,
  locationRadiusMeters: Number(values.locationRadiusMeters),
  locationLatitude: values.locationLatitude === '' ? null : Number(values.locationLatitude),
  locationLongitude: values.locationLongitude === '' ? null : Number(values.locationLongitude)
});

/**
 * A session's settings. A new one checks distance from the start - the one
 * real stop for someone sent the QR from outside the room - at the classroom
 * last used, which the teacher can change.
 */
const formValues = (session, lastVenue) => (session ? {
  title: session.title,
  allowGuests: Boolean(session.allowGuests),
  oneMarkPerPhone: Boolean(session.oneMarkPerPhone),
  locationRequired: Boolean(session.locationRequired),
  locationRadiusMeters: session.locationRadiusMeters ?? 100,
  locationLatitude: session.locationLatitude ?? '',
  locationLongitude: session.locationLongitude ?? ''
} : {
  title: '',
  allowGuests: false,
  oneMarkPerPhone: false,
  locationRequired: true,
  locationRadiusMeters: lastVenue?.locationRadiusMeters ?? 100,
  locationLatitude: lastVenue?.locationLatitude ?? '',
  locationLongitude: lastVenue?.locationLongitude ?? ''
});

/** A new session, or - given `session` - changing one already made. */
export function SessionForm({ session = null, lastVenue = null, onSave, onCancel, showToast }) {
  const [values, setValues] = useState(() => formValues(session, lastVenue));
  const [busy, setBusy] = useState(false);
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const idPrefix = session ? 'att-edit' : 'att';

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave({ title: values.title, allowGuests: values.allowGuests, oneMarkPerPhone: values.oneMarkPerPhone, ...venueBody(values) });
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <form className="card min-card att-create" onSubmit={save}>
      <span className="field-label-row">
        <label className="field-label" htmlFor={`${idPrefix}-title`}>Class name</label>
        <InfoTip label="About the class name">Use the same name for every lecture: that is how the absent list and the register know the class.</InfoTip>
      </span>
      <input id={`${idPrefix}-title`} className="text-input" required minLength="2" maxLength="120" autoFocus value={values.title}
        onChange={(event) => set('title', event.target.value)} placeholder="e.g. DBMS · CSE-B"/>
      <div className="att-create-options">
        <SwitchRow checked={values.locationRequired} onChange={(value) => set('locationRequired', value)}
          title="Check distance" description="Only students near the classroom can mark."/>
        <SwitchRow checked={values.oneMarkPerPhone} onChange={(value) => set('oneMarkPerPhone', value)}
          title="One mark per phone" description="A second student on the same phone is sent to you."/>
        <SwitchRow checked={values.allowGuests} onChange={(value) => set('allowGuests', value)}
          title="Allow guests" description="Mark with a name and SAP ID, without a college account."/>
      </div>
      {values.locationRequired && <VenueFields values={values} onChange={set} idPrefix={idPrefix} showToast={showToast}/>}
      <div className="min-actions">
        {onCancel && <button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button>}
        <button className="button button-primary" type="submit" disabled={busy}>
          {session ? (busy ? 'Saving…' : 'Save changes') : (busy ? 'Opening…' : 'Start & show QR')}
        </button>
      </div>
    </form>
  );
}
