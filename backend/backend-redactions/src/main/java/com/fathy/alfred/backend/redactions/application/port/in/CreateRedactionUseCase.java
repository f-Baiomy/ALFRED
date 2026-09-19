package com.fathy.alfred.backend.redactions.application.port.in;

import com.fathy.alfred.backend.redactions.domain.model.NewRedaction;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;

public interface CreateRedactionUseCase {

    Redaction create(NewRedaction newRedaction);
}
