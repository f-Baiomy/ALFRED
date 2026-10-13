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
     * may not be Alfred's). Listen in any session reads it and leaves the user's changes to it. {@code kind} says which
     * runner it is - {@link #KIND_LIVE} (answers the user) or {@link #KIND_LISTEN} (checks calls while the user tests);
     * missing or unknown reads as live. Each kind holds its own heartbeat per board, so a listen runner never replaces
     * the live runner's. stopped ends the heartbeat of that kind at once.
     */
    LiveRunner beat(String project, String host, String model, String kind, boolean stopped);

    /**
     * The runner answering this project's board right now, if any (empty once it stopped or went quiet): the live runner
     * when there is one, else the listen runner.
     */
    default Optional<LiveRunner> runner(String project) {
        return runner(project, null);
    }

    /** As {@link #runner(String)}, but only a runner of this kind when {@code kind} is given. */
    Optional<LiveRunner> runner(String project, String kind);

    String KIND_LIVE = "live";
    String KIND_LISTEN = "listen";

    /** A runner's heartbeat as held: {@code kind} is {@link #KIND_LIVE} or {@link #KIND_LISTEN}. */
    record LiveRunner(String project, String host, String model, String kind, java.time.Instant startedAt, java.time.Instant lastSeen) {

        /** The same heartbeat, seen again at {@code at}. */
        public LiveRunner seenAt(java.time.Instant at) {
            return new LiveRunner(project, host, model, kind, startedAt, at);
        }
    }

    record Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                  String outcome) {
    }
}
