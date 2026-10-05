import { JSDOM } from 'jsdom';

// The frontend's export builders pretty-print XML bodies through DOMParser (body-format.ts,
// xml-tokenizer.ts) and judge well-formedness by the `parsererror` element a browser returns.
// Node has no DOMParser; jsdom's returns that same element, so an invalid XML body formats here
// exactly as it does in the UI's exports. Must be imported before anything from the frontend.
const globals = globalThis as { DOMParser?: unknown };
globals.DOMParser ??= new JSDOM('').window.DOMParser;
