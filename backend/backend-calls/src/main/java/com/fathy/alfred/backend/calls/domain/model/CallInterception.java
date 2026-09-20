package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * What an interception rule did to this call, as reported by the proxy on the existing completion
 * webhook.
 *
 * <p>This is the whole of the integration between interception and logging, and it is deliberately
 * a field on the call rather than a separate event stream: a rule's effect is a fact ABOUT one
 * call, and riding on the call record means it inherits that call's id, session id and operation id
 * for free. A parallel log would have to be joined back to the traffic it describes, which is the
 * work this avoids.
 *
 * <p>Copied from proxy/interception.py's Verdict.as_log rather than shared with backend-interception
 * - that slice never sees a call, and a dependency between them would be the first step towards
 * evaluating rules backend-side, which is exactly the design the feature avoids. The two meet in
 * this payload, not in code.
 *
 * <p>Null on every call no rule touched, which is almost all of them - so an ordinary call's stored
 * shape is unchanged by this feature existing.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CallInterception(
        List<Applied> applied,
        /**
         * The request as the CLIENT sent it, kept whenever a rule or a human changed it before it
         * went upstream.
         *
         * <p>Without this the log is not merely incomplete, it is wrong: the recorded request is
         * the modified one, presented as though the client sent it that way. A booking that failed
         * because of an injected query parameter or a rewritten body would then be untraceable to
         * the edit that caused it, which is the opposite of what a traffic logger is for.
         *
         * <p>Absent when the request was never modified - so "unchanged" stays distinguishable
         * from "not recorded", and a call that was only delayed does not double in size.
         */
        Http originalRequest,
        /**
         * The response as UPSTREAM actually sent it, kept whenever a rule or a human changed it
         * before the caller saw it. Same reasoning as {@link #originalRequest}, from the other end.
         */
        Http originalResponse,
        /**
         * The request as it ACTUALLY went upstream, once rules and any hand edit had finished.
         *
         * <p>Not redundant with the logged request, which is the trap: the request half is written
         * to the log at PREPARE time - before it is forwarded, and therefore before a request
         * breakpoint has let anyone edit it. Diffing against the log would show no change on a
         * hand-edited request while the record insisted one was made. Keeping both endpoints here
         * makes the record self-contained and independent of when the log was written.
         */
        Http finalRequest,
        /** The response as the caller ACTUALLY received it. Same reasoning, from the other end. */
        Http finalResponse) {

    public CallInterception {
        applied = applied == null ? List.of() : List.copyOf(applied);
    }

    /**
     * One action's effect. {@code detail} names WHAT was changed and never its value - a rule that
     * rewrote an {@code authorization} header records the header name only. The proxy enforces
     * this at the source (see SENSITIVE_HEADERS); it matters here because this text is echoed
     * verbatim into every .md/.html export.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Applied(String ruleId, String ruleName, String action, String detail) {
    }

    /**
     * One half of an exchange, frozen before anything touched it.
     *
     * <p>{@code status}/{@code reason} are set for a response only, {@code method}/{@code url} for
     * a request only. The url matters more than it looks: a rule that rewrites a query parameter
     * changes nothing else, so a snapshot without it would show two identical copies.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Http(Integer status, String reason, String method, String url,
                       Map<String, String> headers, String body) {
    }

    /** Jackson treats any isX() on a record as a property - without this every call gains an "empty": false. */
    @JsonIgnore
    public boolean isEmpty() {
        return applied.isEmpty() && originalRequest == null && originalResponse == null
                && finalRequest == null && finalResponse == null;
    }
}
