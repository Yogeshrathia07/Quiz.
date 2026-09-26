/**
 * A placeholder in the shape of what is loading - a title, then rows - so
 * the page does not jump when the data arrives.
 */
export function Skeleton({ rows = 4, label = 'Loading' }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span className="skeleton-title"/>
      <span className="skeleton-line is-short"/>
      <div className="skeleton-card">
        {Array.from({ length: rows }, (_unused, index) => (
          <span key={index} className="skeleton-row"><span/><span/></span>
        ))}
      </div>
    </div>
  );
}
