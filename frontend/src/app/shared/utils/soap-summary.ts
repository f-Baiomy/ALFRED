/**
 * What a SOAP envelope is, in the few words a reader needs before opening the body: which SOAP
 * version, which operation (the first element inside soap:Body), and - when the service failed -
 * the fault code. An HTTP 500 alone does not say WHY a SOAP call failed; the faultcode does.
 *
 * Null for anything that is not a SOAP envelope, including plain XML, so a caller can show the
 * SOAP chips only where they mean something.
 */

const SOAP_11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP_12 = 'http://www.w3.org/2003/05/soap-envelope';

export interface SoapSummary {
  readonly version: '1.1' | '1.2';
  /** Local name of the first element in the Body - `Add`, `AddResponse`. Null for an empty Body or a fault. */
  readonly operation: string | null;
  /** True when the Body holds a soap:Fault - the service failed, whatever the HTTP status says. */
  readonly isFault: boolean;
  /** The fault code (`soap:Client`, `soap:Receiver`) when the Body holds a Fault, else null. */
  readonly faultCode: string | null;
  /** The fault's human-readable reason, when it has one. */
  readonly faultReason: string | null;
}

export function soapSummary(xml: string | null | undefined): SoapSummary | null {
  if (!xml || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(xml.trim(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  if (!root || root.localName !== 'Envelope') return null;
  const ns = root.namespaceURI;
  if (ns !== SOAP_11 && ns !== SOAP_12) return null;
  const version = ns === SOAP_11 ? '1.1' : '1.2';

  const body = childElements(root).find((el) => el.localName === 'Body' && el.namespaceURI === ns);
  const first = body ? childElements(body)[0] : undefined;
  if (!first) return { version, operation: null, isFault: false, faultCode: null, faultReason: null };

  if (first.localName === 'Fault' && first.namespaceURI === ns) {
    return { version, operation: null, isFault: true, ...faultOf(first, version) };
  }
  return { version, operation: first.localName, isFault: false, faultCode: null, faultReason: null };
}

function faultOf(fault: Element, version: '1.1' | '1.2'): { faultCode: string | null; faultReason: string | null } {
  if (version === '1.1') {
    // SOAP 1.1 fault children are unqualified: <faultcode>, <faultstring>.
    return { faultCode: textOf(child(fault, 'faultcode')), faultReason: textOf(child(fault, 'faultstring')) };
  }
  // SOAP 1.2: <Code><Value>, <Reason><Text>.
  return {
    faultCode: textOf(child(child(fault, 'Code'), 'Value')),
    faultReason: textOf(child(child(fault, 'Reason'), 'Text')),
  };
}

function childElements(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
}

function child(el: Element | undefined, localName: string): Element | undefined {
  return el ? childElements(el).find((c) => c.localName === localName) : undefined;
}

function textOf(el: Element | undefined): string | null {
  const text = el?.textContent?.trim();
  return text ? text : null;
}
