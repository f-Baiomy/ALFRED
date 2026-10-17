package com.fathy.alfred.backend.board.domain.model;

/**
 * Where a task stands in the one workflow (specs/030 FR-013): Board → Define → Triage → Code → Verify → Test → Close.
 * Worked out from the board each time it is asked - never stored - so the stage strip, task_context's NEXT and
 * /alfred-guide always agree. {@code next} is the one next step with its exact command; {@code ref} is how the
 * commands name the board (AB#&lt;main item id&gt;, else its name).
 */
public record BoardStage(Stage stage, String next, String ref, Counts counts) {

    public enum Stage {
        DEFINE, TRIAGE, CODE, VERIFY, TEST, CLOSE
    }

    /** What the stage was worked out from. {@code untested}: items no call has judged yet; {@code unmarked}: items the user has not marked. */
    public record Counts(boolean brief, int items, int inbox, int waitingOnUser, int toDo, int inProgress, int fixed, int untested,
                         int failing, int unmarked) {
    }

    /** The rule, first match wins. */
    public static BoardStage of(String ref, Counts c) {
        if (!c.brief()) {
            return new BoardStage(Stage.DEFINE, "/alfred-setup " + ref + " - Claude reads the task (and its work item) and drafts the brief, "
                    + "spec, test steps and cards", ref, c);
        }
        if (c.items() == 0 && c.inbox() + c.toDo() + c.inProgress() + c.fixed() == 0) {
            return new BoardStage(Stage.DEFINE, "/alfred-spec " + ref + " - add the requirements (an Acceptance list) so the task can be checked",
                    ref, c);
        }
        if (c.inbox() > 0) {
            return new BoardStage(Stage.TRIAGE, "/alfred-triage " + ref + " - sort the " + c.inbox() + " Inbox card(s): yours, another team's, "
                    + "or close", ref, c);
        }
        if (c.waitingOnUser() > 0) {
            return new BoardStage(Stage.TRIAGE, "Answer the " + c.waitingOnUser() + " question(s) and proposal(s) waiting on you on the board",
                    ref, c);
        }
        if (c.toDo() + c.inProgress() > 0) {
            return new BoardStage(Stage.CODE, "Write the code for the " + (c.toDo() + c.inProgress()) + " To do card(s), then /alfred-verify "
                    + ref + " - it finds what is written and asks \"Record as fixed?\"", ref, c);
        }
        if (c.fixed() > 0) {
            return new BoardStage(Stage.VERIFY, "/alfred-verify " + ref + " - re-test the " + c.fixed() + " Fixed card(s) from the live calls "
                    + "(or press Record and /alfred-listen " + ref + ")", ref, c);
        }
        if (c.failing() > 0 || c.untested() > 0) {
            return new BoardStage(Stage.TEST, "Press Record (Cycles tab), then /alfred-listen " + ref + " and run the test steps - "
                    + (c.untested() > 0 ? c.untested() + " item(s) not tested yet" : c.failing() + " item(s) failing by the calls"), ref, c);
        }
        if (c.unmarked() > 0) {
            return new BoardStage(Stage.VERIFY, "/alfred-verify " + ref + " suggests the marks; mark the " + c.unmarked()
                    + " remaining item(s) on the Task tab", ref, c);
        }
        return new BoardStage(Stage.CLOSE, "/alfred-report " + ref + " - the summary and the update for the main item", ref, c);
    }
}
