package com.fathy.alfred.backend.relive.domain.model;

/**
 * A call made during a step's execution that matched no configured child (FR-014f).
 * {@code handledByRuleId}/{@code handledByRuleName} are set only when {@code handledBy} is
 * {@code "RULE"}; otherwise {@code handledBy} is {@code "BLOCK"} or {@code "SEND_REAL"}.
 */
public record UnexpectedCallEntry(
        String callId,
        String method,
        String url,
        String handledBy,
        String handledByRuleId,
        String handledByRuleName,
        boolean reachedExternal
) {
}
