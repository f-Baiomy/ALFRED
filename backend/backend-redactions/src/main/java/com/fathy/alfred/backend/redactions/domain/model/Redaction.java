package com.fathy.alfred.backend.redactions.domain.model;

/**
 * One manual "mask this on export" mark a user placed on a captured call.
 *
 * <p><strong>Deliberately holds no secret value, and must never gain a field that does.</strong>
 * {@code name} is only the IDENTIFIER of the thing to mask - a header name ({@code authorization}),
 * a JSON key path ({@code data.accessToken}), or a query-parameter name ({@code api_key}) - never
 * the token, cookie or credential found there. Three reasons this is a hard rule:
 *
 * <ul>
 *   <li>The whole point of a redaction is to keep a secret OUT of an export. Exports already echo
 *       stored text verbatim elsewhere (the comments slice's {@code lineText} is reprinted as-is by
 *       the frontend's HTML and Markdown builders), so a value stored here would very plausibly end
 *       up reprinted in full right beside the masked version - the exact leak we are preventing.</li>
 *   <li>This store gets backed up, copied between environments and read by anyone debugging it.
 *       Names are boring; values are credentials. Keeping only names means a backup of redactions
 *       is never a backup of secrets.</li>
 *   <li>Masking at export time only ever needs the name to find the thing to blank out. A stored
 *       value would buy nothing and cost everything.</li>
 * </ul>
 *
 * <p>If you are here to add {@code value}, {@code originalValue}, {@code lineText} or similar so
 * something downstream can "show what was hidden": don't. Change the consumer instead.
 *
 * @param scope     CALL (this one call) or ALL (every call in any export)
 * @param callId    the call this applies to when scope is CALL; null for ALL
 * @param name      header name / JSON key path / query-param name. NEVER a value.
 */
public record Redaction(
        String id,
        RedactionScope scope,
        String callId,
        RedactionKind kind,
        String name,
        String createdAt
) {
}
