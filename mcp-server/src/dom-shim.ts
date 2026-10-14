import { JSDOM } from 'jsdom';

// The frontend's export builders pretty-print XML bodies through DOMParser (body-format.ts,
// xml-tokenizer.ts) and judge well-formedness by the `parsererror` element a browser returns.
// Node has no DOMParser; jsdom's returns that same element, so an invalid XML body formats here
// exactly as it does in the UI's exports. Must be imported before anything from the frontend.
const win = new JSDOM('').window as unknown as { DOMParser: unknown; Node: unknown; Element: unknown; HTMLElement: unknown };
const globals = globalThis as { DOMParser?: unknown };
globals.DOMParser ??= win.DOMParser;
// The board's rich text reader (rich-html.ts) walks the parsed tree by Node/Element, as a browser's - of the same
// window as the DOMParser, or `instanceof Element` is false for every node it parses.
const more = globalThis as { Node?: unknown; Element?: unknown; HTMLElement?: unknown };
more.Node ??= win.Node;
more.Element ??= win.Element;
more.HTMLElement ??= win.HTMLElement;
