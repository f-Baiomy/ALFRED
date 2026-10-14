package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.SkillRun;

import java.util.List;
import java.util.Optional;

/** Where the skill runs started from the board are kept (board.db's skill_runs): the queue, and each card's run history. */
public interface SkillRunStorePort {

    /** Inserts or replaces the run with this id. */
    void saveRun(SkillRun run);

    Optional<SkillRun> findRun(String id);

    /** The runs of a project (every project for null), newest first; only one card's when {@code cardNumber} is given. */
    List<SkillRun> runs(String project, Integer cardNumber, int limit);

    /** Queued and running runs, oldest first; every project's for null. */
    List<SkillRun> activeRuns(String project);

    /** Drops a project's oldest ended runs beyond {@code keep}. */
    void pruneRuns(String project, int keep);
}
