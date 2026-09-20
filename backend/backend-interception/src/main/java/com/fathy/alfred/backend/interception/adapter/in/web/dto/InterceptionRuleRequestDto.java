package com.fathy.alfred.backend.interception.adapter.in.web.dto;

import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * A DTO rather than the domain record directly (see docs/architecture.md's rule) for one reason:
 * the boundary needs Bean Validation annotations the domain type shouldn't carry, and it must
 * refuse to let a caller set {@code id}, {@code createdAt} or {@code updatedAt} - all three are
 * assigned server-side, and accepting them would let a client rewrite when a rule was created.
 *
 * <p>Everything conditional on action type is checked by RuleValidator instead; annotations cannot
 * express "durationMs is required, but only for DELAY_REQUEST".
 */
public record InterceptionRuleRequestDto(
        @NotBlank(message = "A rule needs a name.")
        @Size(max = 120, message = "Rule name must be 120 characters or fewer.")
        String name,
        @Size(max = 500, message = "Description must be 500 characters or fewer.")
        String description,
        Boolean enabled,
        Integer priority,
        Boolean stopProcessing,
        RuleMatch match,
        List<RuleAction> actions) {

    public InterceptionRule toDomain() {
        return new InterceptionRule(
                null,
                name,
                description,
                // A rule created with no explicit state arrives ON: the user pressed save on a
                // form they just filled in, and a rule that silently does nothing until a second
                // click is a worse default than one that works.
                enabled == null || enabled,
                priority == null ? 100 : priority,
                stopProcessing != null && stopProcessing,
                match,
                actions,
                null,
                null);
    }
}
