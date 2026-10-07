package com.fathy.alfred.backend.server.application.port.in;

import java.util.List;

/** Lines of .env Alfred does not use, reported at start and in the Server section (FR-016). */
public interface CheckEnvUseCase {

    /** @param line 1-based line number */
    record EnvProblem(int line, String text, String reason) {
    }

    List<EnvProblem> problems();
}
