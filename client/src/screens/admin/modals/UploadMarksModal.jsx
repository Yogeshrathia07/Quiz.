import { useState } from 'react';
import { Upload } from 'lucide-react';
import { uploadFile } from '../../../lib/api.js';
import { Modal } from '../../../components/Modal.jsx';
import { InfoTip } from '../../../components/InfoTip.jsx';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What could not be used, listed under its reason - the first few of each. */
function Problems({ title, count, items }) {
  if (!count) return null;
  return (
    <div className="upload-marks-problem">
      <strong>{title} ({count})</strong>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}{count > items.length && <li>and {count - items.length} more</li>}</ul>
    </div>
  );
}

/**
 * Marks typed into the Marks sheet of this test's Excel export, sent back
 * (services/marks-import.js). Each row finds its student by the export's hidden
 * id, else the SAP ID, else the email; short answers take the marks typed for
 * them, and what could not be used is listed rather than guessed at.
 */
export function UploadMarksModal({ code, onClose, onSaved, showToast }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const upload = async (event) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const done = await uploadFile(`/api/admin/tests/${encodeURIComponent(code)}/marks.xlsx`, file);
      setResult(done);
      if (done.marks) onSaved();
    } catch (error) { showToast(error.message); }
    setBusy(false);
  };

  return (
    <Modal label="Upload marks" onClose={onClose} className="upload-marks-dialog">
      <div className="page-heading">
        <h1>Upload marks</h1>
        <InfoTip label="How marking in Excel works">
          Export Excel, change marks in its Marks sheet (yellow cells are short answers still to mark; any mark from 0 to what
          its question is worth), then upload that file here. Rows are matched to students by the file itself, else their SAP
          ID or email. Only cells you changed are read, so an older file never undoes newer marks; a choice question&apos;s mark
          you change becomes your own.
        </InfoTip>
      </div>

      {!result ? (
        <form onSubmit={upload}>
          <label className="upload-marks-file">
            <Upload size={18} aria-hidden="true"/>
            <span>{file ? file.name : 'Choose the Excel file (.xlsx)'}</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => setFile(event.target.files?.[0] || null)}/>
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={!file || busy}>{busy ? 'Reading…' : 'Upload'}</button>
          </div>
        </form>
      ) : (
        <>
          <p className={`notice${result.marks ? ' success' : ''}`}>
            {result.marks
              ? `${plural(result.marks, 'mark')} saved, for ${plural(result.students, 'student')}.`
              : 'No marks changed: every mark in the file is already saved, or none could be used.'}
          </p>
          <Problems title="Marks outside what the question is worth" count={result.invalid.count} items={result.invalid.cells}/>
          <Problems title="Rows that matched no student on this test" count={result.unmatched.count} items={result.unmatched.names}/>
          <Problems title="Students who have not handed in a paper" count={result.notSubmitted.count} items={result.notSubmitted.names}/>
          <div className="modal-actions">
            {/* Something could not be used: fix it in Excel and send the file again - what was saved is not sent twice. */}
            {(result.invalid.count + result.unmatched.count) > 0 && (
              <button className="button button-secondary" type="button" onClick={() => { setResult(null); setFile(null); }}>Upload corrected file</button>
            )}
            <button className="button button-primary" type="button" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
