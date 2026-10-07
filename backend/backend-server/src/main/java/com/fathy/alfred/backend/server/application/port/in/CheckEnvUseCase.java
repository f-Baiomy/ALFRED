package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.EnvProblem;

import java.util.List;

/** Lines of .env Alfred does not use, reported at start and in the Server section (FR-016). */
public interface CheckEnvUseCase {

    List<EnvProblem> problems();
}
