package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Regression;

import java.util.List;

/** Done / Verified cards of a project whose endpoint failed again the same way in recent live calls (specs/015 FR-17). */
public interface RegressionsUseCase {

    int RECENT_CALLS = 2000;

    List<Regression> regressions(String project);
}
