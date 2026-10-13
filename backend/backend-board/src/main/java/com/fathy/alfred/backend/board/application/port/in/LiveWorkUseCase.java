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

    /**
     * The runner's heartbeat: it is answering this project's board from {@code host} (it runs on the user's machine, which
     * may not be Alfred's). Listen in any session reads it and leaves the user's changes to it. stopped ends it at once.
     */
    LiveRunner beat(String project, String host, String model, boolean stopped);

    /** The runner answering this project's board right now, if any (empty once it stopped or went quiet). */
    Optional<LiveRunner> runner(String project);

    record LiveRunner(String project, String host, String model, java.time.Instant startedAt, java.time.Instant lastSeen) {
    }

    record Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                  String outcome) {
    }
}
