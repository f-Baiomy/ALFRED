package com.fathy.alfred.backend.filtering;

import com.fathy.alfred.backend.calls.application.port.out.CallFilterPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.settings.application.port.in.IsCallAllowedUseCase;
import org.springframework.stereotype.Component;

/**
 * Bridges backend-calls' CallFilterPort to backend-settings' IsCallAllowedUseCase. Lives here in
 * backend-app rather than in either slice because calls must not depend on settings and settings
 * must not depend on calls (see HexagonalArchitectureTest) - the composition root is the only
 * place allowed to know about both at once, same pattern as CommentCallIdMigration.
 */
@Component
public class CallFilterAdapter implements CallFilterPort {

    private final IsCallAllowedUseCase isCallAllowedUseCase;

    public CallFilterAdapter(IsCallAllowedUseCase isCallAllowedUseCase) {
        this.isCallAllowedUseCase = isCallAllowedUseCase;
    }

    @Override
    public boolean isAllowed(CallRecord call) {
        return isCallAllowedUseCase.isAllowed(call.url());
    }
}
