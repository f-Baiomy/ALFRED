import { MENTION_ICONS, MentionRef, mentionTypeOf } from '../../core/models/board.models';
import { parseMentions, serializeMention } from './mention-syntax';

/**
 * The board's editable text with mentions as pills (MentionEditorComponent): the text is plain text nodes, each mention
 * one non-editable chip carrying its `@[type:ref|label]` in `data-mention`. Built with createElement and textContent
 * only - never innerHTML, since the text is untrusted (constitution I). The stored value is always the serialized text,
 * so everything else (the backend's index, exports, Claude) still reads `@[type:ref|label]`.
 */

/** A chip node for one mention: atomic in the editor (deleted as a whole), titled with its ref. */
export function mentionChipNode(doc: Document, ref: MentionRef): HTMLElement {
  const chip = doc.createElement('span');
  const type = mentionTypeOf(ref);
  chip.className = `board-mention board-mention-${type} board-mention-pill`;
  chip.contentEditable = 'false';
  chip.dataset['mention'] = serializeMention(ref);
  chip.title = `${ref.label}\n${type}: ${ref.ref}`;
  const icon = doc.createElement('span');
  icon.className = 'board-mention-icon';
  icon.textContent = MENTION_ICONS[type] ?? '@';
  chip.append(icon, doc.createTextNode(ref.label));
  return chip;
}

/** A <br> that only makes a trailing line break show (a contenteditable hides the last "\n") - not part of the text. */
export function fillerBreak(doc: Document): HTMLElement {
  const br = doc.createElement('br');
  br.dataset['filler'] = '1';
  return br;
}

/** Replaces the container's content with `text`: plain text nodes and one chip per mention. */
export function renderMentionText(container: HTMLElement, text: string): void {
  const doc = container.ownerDocument;
  const nodes: Node[] = parseMentions(text).map((s) => ('mention' in s ? mentionChipNode(doc, s.mention) : doc.createTextNode(s.text)));
  if (text.endsWith('\n')) nodes.push(fillerBreak(doc));
  container.replaceChildren(...nodes);
}

/** The container's content back as text: chips as their `@[...]`, line breaks as "\n" (also those a browser adds as divs). */
export function serializeMentionText(container: Node): string {
  let out = '';
  const walk = (node: Node, first: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const mention = node.dataset['mention'];
    if (mention) {
      out += mention;
      return;
    }
    if (node.tagName === 'BR') {
      if (!node.dataset['filler']) out += '\n';
      return;
    }
    const block = node.tagName === 'DIV' || node.tagName === 'P';
    if (block && !first && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach((child, i) => walk(child, i === 0));
  };
  container.childNodes.forEach((child, i) => walk(child, i === 0));
  return out;
}

/** Where `node`/`offset` falls in the serialized text - so a pick from anywhere can come back to the same place. */
export function serializedOffset(container: HTMLElement, node: Node, offset: number): number {
  const marker = '';
  const range = container.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const probe = container.ownerDocument.createTextNode(marker);
  range.insertNode(probe);
  const at = serializeMentionText(container).indexOf(marker);
  probe.remove();
  container.normalize();
  return at < 0 ? serializeMentionText(container).length : at;
}
