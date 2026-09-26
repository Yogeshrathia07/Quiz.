/**
 * Question text with its formatting (see src/domain/rich-text.js):
 * **bold**, line breaks, "- " bullet points and "1. " numbered lists.
 *
 * Built from the text as React elements - never as HTML - so nothing typed
 * into a question can inject markup into the student's page.
 */
import { blocksOf } from '../lib/text-format.js';

/** "**bold** rest" -> ["", <strong>bold</strong>, " rest"] */
export function inline(text, keyPrefix = '') {
  return String(text).split(/\*\*(.+?)\*\*/g).map((part, index) => (index % 2 ? <strong key={`${keyPrefix}${index}`}>{part}</strong> : part));
}

export function RichText({ text, className = '' }) {
  return (
    <div className={`rich-text ${className}`.trim()}>
      {blocksOf(text).map((block, index) => {
        if (block.kind === 'ul') return <ul key={index}>{block.items.map((item, at) => <li key={at}>{inline(item, `${index}-${at}-`)}</li>)}</ul>;
        if (block.kind === 'ol') return <ol key={index} start={block.start}>{block.items.map((item, at) => <li key={at}>{inline(item, `${index}-${at}-`)}</li>)}</ol>;
        return (
          <p key={index}>
            {block.lines.map((line, at) => (
              <span key={at}>{at > 0 && <br/>}{inline(line, `${index}-${at}-`)}</span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Whether the text uses any formatting at all - the editor shows a preview only then. */
export const hasFormatting = (text) => /\*\*.+?\*\*|\n/.test(String(text || ''));
