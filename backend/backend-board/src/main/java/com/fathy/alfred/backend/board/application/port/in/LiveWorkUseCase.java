package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.LiveWork;

import java.util.List;
import java.util.Optional;

/** /alfred-live's work on a card, shown as it happens (docs/board.md "Live answers"). In memory only. */
public interface LiveWorkUseCase {

    /** The runner's report: the whole current state of one run. Returns it as held - with stop set when the user pressed Stop. */
    LiveWork report(Report report);

    /** Runs still working, and the ones that ended recently (so the card can show "6 s · 4 steps"). */
    List<LiveWork> current(String project);

    /** The user's Stop on one run; empty when there is no such run. */
    Optional<LiveWork> stop(String id);

    record Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                  String outcome) {
    }
}
