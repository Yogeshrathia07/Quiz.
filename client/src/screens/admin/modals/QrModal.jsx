import { Copy } from 'lucide-react';
import { copyText } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';

/** The join QR, big enough to scan from the back of the room, and its link. */
export function QrModal({ test, joinUrl, onClose, showToast }) {
  const copy = () => copyText(joinUrl).then(() => showToast('Link copied.')).catch((error) => showToast(error.message));
  return (
    <Modal label="Share test QR code" onClose={onClose} className="qr-modal">
      <header className="qr-modal-head">
        <h1>{test.title}</h1>
      </header>
      <div className="qr-modal-code">
        <img className="qr" src={`/api/tests/${encodeURIComponent(test.code)}/qr.svg`} alt={`QR code for ${test.code}`}/>
        <p>{test.code}</p>
      </div>
      <div className="qr-modal-link">
        <input className="text-input" readOnly value={joinUrl} onFocus={(event) => event.target.select()} aria-label="Test link"/>
        <button className="button button-secondary" type="button" onClick={copy}><Copy size={16} aria-hidden="true"/>Copy</button>
      </div>
    </Modal>
  );
}
