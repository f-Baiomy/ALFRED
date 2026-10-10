package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.FixCheck;

import java.util.List;

/** The Fixed cards of a board checked against a re-test cycle's calls (by signature). */
public interface VerifyFixesUseCase {

    int MAX_CALLS = 5000;

    List<FixCheck> verify(String project, String cycleId);
}
