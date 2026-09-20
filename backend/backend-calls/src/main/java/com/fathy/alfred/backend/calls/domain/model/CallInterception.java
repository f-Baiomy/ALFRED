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
         * What upstream ACTUALLY sent, kept when a human edited a paused response before releasing
         * it. Without this the log quietly becomes fiction: it would record only the edited reply
         * the caller received and claim the supplier sent it. Present only for a hand-edited call.
         */
        Upstream upstreamResponse) {

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

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Upstream(Integer status, Map<String, String> headers, String body) {
    }

    /** Jackson treats any isX() on a record as a property - without this every call gains an "empty": false. */
    @JsonIgnore
    public boolean isEmpty() {
        return applied.isEmpty() && upstreamResponse == null;
    }
}
