package com.fathy.alfred.backend.board.domain.model;

import com.fathy.alfred.backend.board.domain.model.BoardStage.Counts;
import com.fathy.alfred.backend.board.domain.model.BoardStage.Stage;
import com.fathy.alfred.backend.board.domain.model.BoardStage.StepKind;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BoardStageTest {

    /** brief, items, inbox, waiting, toDo, inProgress, fixed, untested, failing, unmarked */
    private static BoardStage at(boolean brief, int items, int inbox, int waiting, int toDo, int inProgress, int fixed, int untested, int failing,
                                 int unmarked) {
        return BoardStage.of("AB#61813", new Counts(brief, items, inbox, waiting, toDo, inProgress, fixed, untested, failing, unmarked));
    }

    @Test
    void eachStageWithItsCommand() {
        assertThat(at(false, 0, 0, 0, 0, 0, 0, 0, 0, 0)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.DEFINE);
            assertThat(s.next()).startsWith("/alfred-setup AB#61813");
        });
        assertThat(at(true, 0, 0, 0, 0, 0, 0, 0, 0, 0).next()).startsWith("/alfred-spec AB#61813");
        assertThat(at(true, 12, 5, 5, 0, 0, 0, 12, 0, 12)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.TRIAGE);
            assertThat(s.next()).startsWith("/alfred-triage AB#61813 - sort the 5 Inbox card(s)");
        });
        assertThat(at(true, 12, 0, 2, 3, 0, 0, 12, 0, 12).next()).startsWith("Answer the 2 question(s)");
        assertThat(at(true, 12, 0, 0, 3, 1, 0, 12, 0, 12)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.CODE);
            assertThat(s.next()).contains("then /alfred-verify AB#61813").contains("Record as fixed?");
        });
        assertThat(at(true, 12, 0, 0, 0, 0, 2, 12, 0, 12)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.VERIFY);
            assertThat(s.next()).startsWith("/alfred-verify AB#61813 - re-test the 2 Fixed card(s)");
        });
        assertThat(at(true, 12, 0, 0, 0, 0, 0, 4, 0, 12)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.TEST);
            assertThat(s.next()).contains("/alfred-listen AB#61813").contains("4 item(s) not tested yet");
        });
        assertThat(at(true, 12, 0, 0, 0, 0, 0, 0, 0, 3)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.VERIFY);
            assertThat(s.next()).contains("mark the 3 remaining item(s)");
        });
        assertThat(at(true, 12, 0, 0, 0, 0, 0, 0, 0, 0)).satisfies(s -> {
            assertThat(s.stage()).isEqualTo(Stage.CLOSE);
            assertThat(s.next()).startsWith("/alfred-report AB#61813");
        });
    }

    @Test
    void eachBranchCarriesItsStructuredStepNextToTheUnchangedText() {
        record Want(BoardStage s, StepKind kind, String skill, int count) {
        }
        java.util.List<Want> all = java.util.List.of(
                new Want(at(false, 0, 0, 0, 0, 0, 0, 0, 0, 0), StepKind.CLAUDE, "alfred-setup", 0),
                new Want(at(true, 0, 0, 0, 0, 0, 0, 0, 0, 0), StepKind.CLAUDE, "alfred-spec", 0),
                new Want(at(true, 12, 5, 5, 0, 0, 0, 12, 0, 12), StepKind.CLAUDE, "alfred-triage", 5),
                new Want(at(true, 12, 0, 2, 3, 0, 0, 12, 0, 12), StepKind.USER, null, 2),
                new Want(at(true, 12, 0, 0, 3, 1, 0, 12, 0, 12), StepKind.CLAUDE, "alfred-fix", 4),
                new Want(at(true, 12, 0, 0, 0, 0, 2, 12, 0, 12), StepKind.CLAUDE, "alfred-verify", 2),
                new Want(at(true, 12, 0, 0, 0, 0, 0, 4, 0, 12), StepKind.RECORD, "alfred-listen", 4),
                new Want(at(true, 12, 0, 0, 0, 0, 0, 0, 2, 12), StepKind.RECORD, "alfred-listen", 2),
                new Want(at(true, 12, 0, 0, 0, 0, 0, 0, 0, 3), StepKind.CLAUDE, "alfred-verify", 3),
                new Want(at(true, 12, 0, 0, 0, 0, 0, 0, 0, 0), StepKind.CLAUDE, "alfred-report", 0));
        for (Want w : all) {
            assertThat(w.s().step().kind()).as(w.s().next()).isEqualTo(w.kind());
            assertThat(w.s().step().skill()).as(w.s().next()).isEqualTo(w.skill());
            assertThat(w.s().step().count()).as(w.s().next()).isEqualTo(w.count());
            assertThat(w.s().step().command()).isEqualTo(w.skill() == null ? null : "/" + w.skill() + " AB#61813");
        }
    }

    @Test
    void theInboxComesBeforeTheCodeAndTheCodeBeforeTheReTest() {
        assertThat(at(true, 12, 1, 1, 3, 0, 2, 12, 0, 12).stage()).isEqualTo(Stage.TRIAGE);
        assertThat(at(true, 12, 0, 0, 3, 0, 2, 12, 0, 12).stage()).isEqualTo(Stage.CODE);
        assertThat(at(true, 12, 0, 0, 0, 0, 2, 0, 0, 0).stage()).isEqualTo(Stage.VERIFY);
    }
}
