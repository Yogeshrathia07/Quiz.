import { useState } from 'react';
import { LocateFixed } from 'lucide-react';
import { getBrowserLocation } from '../lib/geo.js';

/** A radius smaller than the fix's own error margin can never be satisfied. */
const suggestedRadius = (accuracyMeters) => Math.max(50, Math.ceil((accuracyMeters * 1.5) / 25) * 25);

/**
 * The venue check, and an honest account of how well the browser knows where
 * you are.
 *
 * A laptop has no GPS: it positions itself from nearby Wi-Fi networks and can
 * be a hundred metres or more out. Set the venue from one and give it a tight
 * radius, and students standing in the room read as outside it. The browser
 * reports how far out it might be, so that number is kept and checked against
 * the radius rather than shown once in a toast and forgotten.
 */
export function VenueFields({ values, onChange, idPrefix, showToast }) {
  const [accuracy, setAccuracy] = useState(null);

  const useMyLocation = async () => {
    try {
      const point = await getBrowserLocation();
      onChange('locationLatitude', point.latitude);
      onChange('locationLongitude', point.longitude);
      setAccuracy(point.accuracyMeters);
      showToast(`Venue set from this device (±${Math.round(point.accuracyMeters)} m).`);
    } catch (error) { showToast(error.message); }
  };

  const radius = Number(values.locationRadiusMeters) || 0;
  const tooTight = accuracy !== null && radius < accuracy;

  return (
    <div className="location-settings venue-settings">
      <div className="venue-row">
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-radius`}>Allowed radius</label>
          <div className="input-with-unit">
            <input
              id={`${idPrefix}-radius`}
              className="text-input"
              type="number"
              min="10"
              max="100000"
              value={values.locationRadiusMeters}
              onChange={(event) => onChange('locationRadiusMeters', event.target.value)}
            />
            <span aria-hidden="true">m</span>
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-lat`}>Latitude</label>
          <input
            id={`${idPrefix}-lat`}
            className="text-input"
            type="number"
            step="any"
            value={values.locationLatitude}
            onChange={(event) => onChange('locationLatitude', event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-lng`}>Longitude</label>
          <input
            id={`${idPrefix}-lng`}
            className="text-input"
            type="number"
            step="any"
            value={values.locationLongitude}
            onChange={(event) => onChange('locationLongitude', event.target.value)}
          />
        </div>
      </div>
      <button type="button" className="button button-secondary button-small venue-locate" onClick={useMyLocation}>
        <LocateFixed size={15} aria-hidden="true"/>Use my current location
      </button>

      {accuracy !== null && (
        <div>
          <div className={`notice${tooTight ? ' danger' : ''}`}>
            <strong>
              {tooTight
                ? `This position is only accurate to ±${Math.round(accuracy)} m, but the radius is ${radius} m.`
                : `Position taken to ±${Math.round(accuracy)} m.`}
            </strong>
            <p className="help">
              {tooTight
                ? 'A student standing next to you would be refused. Laptops have no GPS — they guess from nearby Wi-Fi — so either widen the radius or set the coordinates from a phone standing at the venue.'
                : 'The radius comfortably covers that margin.'}
            </p>
            {tooTight && (
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => onChange('locationRadiusMeters', suggestedRadius(accuracy))}
              >
                Use {suggestedRadius(accuracy)} m instead
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
