/**
 * Copies text to the clipboard, falling back to `document.execCommand('copy')` via a hidden
 * textarea when the Clipboard API is unavailable or rejects. `navigator.clipboard.writeText` only
 * works in a secure context (HTTPS, or `localhost`) - a plain-HTTP LAN deployment (e.g.
 * http://192.168.1.210:3000) is not one, so copy buttons there fail or behave inconsistently
 * across browsers (confirmed live). Mirrors the exact fallback `shared/utils/html-builder.ts`'s
 * exported standalone document already uses for the same reason (that one can't import this -
 * it's a plain embedded `<script>` string, not compiled TypeScript), just applied to every copy
 * button in the live app instead of only the exported HTML file's own.
 */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (err) {
      document.body.removeChild(textarea);
      reject(err);
    }
  });
}

/**
 * Copies formatted text: HTML for apps that paste formatting (mail, Word, Teams) with the plain text beside it. Falls back
 * to the plain text where the browser has no ClipboardItem (or it is refused, as on plain-HTTP LAN deployments).
 */
export function copyRichToClipboard(html: string, plain: string): Promise<void> {
  const Item = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && navigator.clipboard && navigator.clipboard.write) {
    const item = new Item({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) });
    return navigator.clipboard.write([item]).catch(() => copyToClipboard(plain));
  }
  return copyToClipboard(plain);
}
