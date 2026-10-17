package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardStageUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.NextStepsUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.domain.model.BoardStage;
import com.fathy.alfred.backend.board.domain.model.BoardSummary;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.Verdict;
import com.fathy.alfred.backend.board.domain.model.NextSteps;
import org.springframework.stereotype.Service;

import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;

/**
 * The board's stage (specs/030): read from the board's brief, its cards and its requirements' verdicts, then
 * {@link BoardStage#of}. Nothing is stored and nothing is judged here beyond what the requirements read already does.
 */
@Service
public class BoardStageService implements BoardStageUseCase {

    /** Verdicts that mean "no call has shown this item yet". */
    static final Set<Verdict> UNTESTED = EnumSet.of(Verdict.NOT_EXERCISED, Verdict.NO_EVIDENCE, Verdict.NO_DATA);
    static final Set<Verdict> FAILING = EnumSet.of(Verdict.MISSING, Verdict.WRONG);

    private final ManageBoardsUseCase boards;
    private final ManageBriefUseCase briefs;
    private final NextStepsUseCase nextSteps;
    private final RequirementUseCase requirements;

    public BoardStageService(ManageBoardsUseCase boards, ManageBriefUseCase briefs, NextStepsUseCase nextSteps, RequirementUseCase requirements) {
        this.boards = boards;
        this.briefs = briefs;
        this.nextSteps = nextSteps;
        this.requirements = requirements;
    }

    @Override
    public Optional<BoardStage> stage(String boardId) {
        Optional<BoardSummary> found = boards.get(boardId);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        BoardSummary b = found.get();
        CycleBrief brief = briefs.brief(boardId);
        NextSteps n = nextSteps.nextSteps(b.board().project(), boardId);
        RequirementUseCase.Requirements r = requirements.requirements(boardId);
        int untested = 0;
        int failing = 0;
        int unmarked = 0;
        for (RequirementUseCase.Requirement item : r.items()) {
            Verdict v = item.verdict() == null ? Verdict.NOT_EXERCISED : item.verdict().verdict();
            if (item.mark() == null || item.mark().isBlank()) {
                unmarked++;
                if (UNTESTED.contains(v)) untested++;
                if (FAILING.contains(v)) failing++;
            }
        }
        BoardStage.Counts counts = new BoardStage.Counts(brief != null && brief.text() != null && !brief.text().isBlank(), r.items().size(), n.inbox(),
                n.waitingOnUser().size(), n.toDo(), n.inProgress(), n.fixed(), untested, failing, unmarked);
        return Optional.of(BoardStage.of(refOf(b), counts));
    }

    /** "AB#1234" when the board has a main item, else its name - how the commands name it. */
    static String refOf(BoardSummary b) {
        String item = b.linkedItem();
        if (item != null && item.contains("/")) {
            return "AB#" + item.substring(item.lastIndexOf('/') + 1);
        }
        String name = b.board().name();
        return name.contains(" ") ? "\"" + name + "\"" : name;
    }
}
