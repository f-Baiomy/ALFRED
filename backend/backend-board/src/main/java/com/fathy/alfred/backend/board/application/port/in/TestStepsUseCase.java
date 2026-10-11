package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;

import java.util.List;

/** The brief's test steps and what the cycle showed for each (specs/015 FR-14). */
public interface TestStepsUseCase {

    List<TestStep> steps(String cycleId);

    record StepOutcome(CardChange.Outcome outcome, TestStep step, String message) {
    }

    StepOutcome mark(Actor actor, String cycleId, String stepKey, StepState state, int calls, Integer cardNumber, String note);
}
