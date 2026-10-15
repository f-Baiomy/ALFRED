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

    /**
     * The chat that handles a cycle (docs/board.md "Run from the board"): the Claude Code chat whose /alfred-live or
     * /alfred-listen runs for that cycle - one chat per cycle. Each of its runners beats with the chat's id; another chat
     * is refused while this one beats. {@code stopped} by the chat's last runner frees the cycle.
     */
    default ChatBeat chatBeat(String project, String cycleId, String chatId, String host, String cwd, String kind, boolean chatAlive,
                              boolean stopped) {
        return chatBeat(project, cycleId, chatId, host, cwd, kind, chatAlive, stopped, null);
    }

    /**
     * {@code terminalAt}: the latest significant work of the cycle's terminal session the runner saw (specs/022 R4), written
     * through to the chat's session row - the one place the panel reads "terminal moved on" from. Null when not known.
     */
    ChatBeat chatBeat(String project, String cycleId, String chatId, String host, String cwd, String kind, boolean chatAlive, boolean stopped,
                      java.time.Instant terminalAt);

    /** The chat handling this cycle now, if any (empty once its runners stopped or went quiet). */
    Optional<CycleChat> cycleChat(String cycleId);

    /** The repo folder the last chat of this project ran in (for "cd <repo>" in the start steps), if known. */
    Optional<String> lastCwd(String project);

    String KIND_LIVE = "live";
    String KIND_LISTEN = "listen";

    /** A runner's heartbeat as held: {@code kind} is {@link #KIND_LIVE} or {@link #KIND_LISTEN}. */
    record LiveRunner(String project, String host, String model, String kind, java.time.Instant startedAt, java.time.Instant lastSeen) {

        /** The same heartbeat, seen again at {@code at}. */
        public LiveRunner seenAt(java.time.Instant at) {
            return new LiveRunner(project, host, model, kind, startedAt, at);
        }
    }

    /**
     * A cycle's chat as held: {@code kinds} the skills it runs for the cycle (live, listen); {@code chatAlive} whether
     * the chat's own process was alive at the last beat - false: the chat was closed but its runner still runs.
     */
    record CycleChat(String project, String cycleId, String chatId, String host, String cwd, java.util.Set<String> kinds, boolean chatAlive,
                     java.time.Instant since, java.time.Instant lastSeen) {
    }

    /** The beat as held, or {@code conflict}: another chat handles this cycle (its chat in {@code chat}). */
    record ChatBeat(CycleChat chat, boolean conflict) {
    }

    record Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                  String outcome, Long chatMessageId, java.util.Map<String, Double> usage) {

        public Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                      String outcome, Long chatMessageId) {
            this(id, project, cardNumber, head, steps, draft, state, outcome, chatMessageId, null);
        }

        public Report(String id, String project, int cardNumber, String head, List<String> steps, String draft, LiveWork.State state,
                      String outcome) {
            this(id, project, cardNumber, head, steps, draft, state, outcome, null, null);
        }
    }
}
