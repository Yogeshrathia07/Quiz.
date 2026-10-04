import { useLayoutEffect, useRef } from 'react';
import { Bold, List, ListOrdered } from 'lucide-react';
import { RichText, hasFormatting } from '../../components/RichText.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { continueList, toggleBold, toggleList } from '../../lib/text-format.js';

/**
 * The question's text, with buttons for bold, bullet points and numbered
 * lists (Enter starts a new line, and the next item inside a list), and a
 * preview of how students will see it once it has any formatting.
 */
export function PromptField({ value, onChange, label = 'Question' }) {
  const box = useRef(null);
  // The selection to put back once the edited text has rendered.
  const restore = useRef(null);
  useLayoutEffect(() => {
    if (!restore.current || !box.current) return;
    box.current.setSelectionRange(restore.current[0], restore.current[1]);
    restore.current = null;
  });

  const apply = (edit) => {
    const field = box.current;
    const result = edit(field.value, field.selectionStart, field.selectionEnd);
    restore.current = [result.start, result.end];
    onChange(result.text);
    field.focus();
  };
  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      apply(toggleBold);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const field = event.currentTarget;
      if (field.selectionStart !== field.selectionEnd) return;
      const next = continueList(field.value, field.selectionStart);
      if (!next) return;
      event.preventDefault();
      restore.current = [next.caret, next.caret];
      onChange(next.text);
    }
  };
  // A toolbar button must not take the selection away from the text.
  const keepSelection = (event) => event.preventDefault();

  return (
    <div className="prompt-field">
      <div className="prompt-field-head">
        <span className="field-label-row">
          <span className="field-label">{label}</span>
          <InfoTip label="Formatting">
            Written as plain text: **bold**, a new line, &quot;- &quot; for bullet points, &quot;1. &quot; for numbered lists - or use
            the buttons. Enter in a list starts its next item.
          </InfoTip>
        </span>
        <div className="prompt-tools" role="toolbar" aria-label="Formatting">
          <button type="button" title="Bold (Ctrl+B)" aria-label="Bold" onMouseDown={keepSelection} onClick={() => apply(toggleBold)}><Bold size={16} aria-hidden="true"/></button>
          <button type="button" title="Bullet points" aria-label="Bullet points" onMouseDown={keepSelection} onClick={() => apply((text, start, end) => toggleList(text, start, end, 'bullet'))}><List size={16} aria-hidden="true"/></button>
          <button type="button" title="Numbered list" aria-label="Numbered list" onMouseDown={keepSelection} onClick={() => apply((text, start, end) => toggleList(text, start, end, 'numbered'))}><ListOrdered size={16} aria-hidden="true"/></button>
        </div>
      </div>
      <textarea ref={box} className="text-area" value={value} required aria-label={label} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown}/>
      {hasFormatting(value) && (
        <div className="prompt-preview">
          <span>How students see it</span>
          <RichText className="prompt-preview-text" text={value}/>
        </div>
      )}
    </div>
  );
}
