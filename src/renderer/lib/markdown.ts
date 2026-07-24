/**
 * Sanitized Markdown rendering (FR-6, §20).
 *
 * Rules enforced here:
 *  - no script execution, no iframes, no embedded objects
 *  - no automatic loading of remote images or embeds — they are replaced with a visible
 *    placeholder so the user knows something was blocked rather than silently missing
 *  - `javascript:` and other active URI schemes are stripped
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element;

    if (element.tagName === 'IMG') {
      const src = element.getAttribute('src') ?? '';
      const isLocalData = src.startsWith('data:image/');
      if (!isLocalData) {
        // Remote (and even vault-relative) images are not fetched in the preview.
        const placeholder = element.ownerDocument.createElement('span');
        placeholder.className = 'rmd-blocked-embed';
        placeholder.textContent = `Image not loaded: ${element.getAttribute('alt') || src || 'embedded image'}`;
        element.replaceWith(placeholder);
        return;
      }
    }

    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|#)/i.test(href)) {
        element.removeAttribute('href');
      } else {
        element.setAttribute('rel', 'noreferrer noopener');
        element.setAttribute('target', '_blank');
      }
    }
  });
}

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'img', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'
];

/** Renders Markdown to sanitized HTML. Never returns unsanitized input. */
export function renderMarkdown(source: string): string {
  installHooks();
  const raw = marked.parse(source, { async: false });
  return DOMPurify.sanitize(typeof raw === 'string' ? raw : '', {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'type', 'checked', 'disabled'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
    ALLOW_DATA_ATTR: false
  });
}

/** Escapes text for safe insertion, used by the highlighter below. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wraps search terms in `<mark>` for result snippets (FR-9). */
export function highlightTerms(text: string, terms: readonly string[]): string {
  const escaped = escapeHtml(text);
  if (terms.length === 0) return escaped;
  const pattern = terms
    .filter((term) => term.length > 0)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!pattern) return escaped;
  return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}
