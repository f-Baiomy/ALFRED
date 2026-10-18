package com.fathy.alfred.backend.board.domain.model;

/**
 * Where a task stands in the one workflow (specs/030 FR-013): Board → Define → Triage → Code → Verify → Test → Close.
 * Worked out from the board each time it is asked - never stored - so the stage strip, task_context's NEXT and
 * /alfred-guide always agree. {@code next} is the one next step with its exact command; {@code ref} is how the
 * commands name the board (AB#&lt;main item id&gt;, else its name). {@code step} is the same next step, structured
 * (specs/032 D1): the board page words it and runs it from one button - never a second rule.
 */
public record BoardStage(Stage stage, String next, String ref, Counts counts, Step step) {

    public enum Stage {
        DEFINE, TRIAGE, CODE, VERIFY, TEST, CLOSE
    }

    /**
     * Who does the next step (specs/032): {@code CLAUDE} - a skill run the board session can do; {@code RECORD} - press
     * Record, then Claude listens; {@code USER} - only the user can (answer questions, write the code). A new type, so no
     * older enum gains a value; readers treat an unknown kind as USER.
     */
    public enum StepKind {
        CLAUDE, RECORD, USER
    }

    /** The next step: its kind, the skill (alfred-setup ...) and exact command when one runs it, and the count it is about. */
    public record Step(StepKind kind, String skill, String command, int count) {
    }

    /** What the stage was worked out from. {@code untested}: items no call has judged yet; {@code unmarked}: items the user has not marked. */
    public record Counts(boolean brief, int items, int inbox, int waitingOnUser, int toDo, int inProgress, int fixed, int untested,
                         int failing, int unmarked) {
    }

    private static Step claude(String skill, String ref, int count) {
        return new Step(StepKind.CLAUDE, skill, "/" + skill + " " + ref, count);
    }

    /** The rule, first match wins. */
    public static BoardStage of(String ref, Counts c) {
        if (!c.brief()) {
            return new BoardStage(Stage.DEFINE, "/alfred-setup " + ref + " - Claude reads the task (and its work item) and drafts the brief, "
                    + "spec, test steps and cards", ref, c, claude("alfred-setup", ref, 0));
        }
        if (c.items() == 0 && c.inbox() + c.toDo() + c.inProgress() + c.fixed() == 0) {
            return new BoardStage(Stage.DEFINE, "/alfred-spec " + ref + " - add the requirements (an Acceptance list) so the task can be checked",
                    ref, c, claude("alfred-spec", ref, 0));
        }
        if (c.inbox() > 0) {
            return new BoardStage(Stage.TRIAGE, "/alfred-triage " + ref + " - sort the " + c.inbox() + " Inbox card(s): yours, another team's, "
                    + "or close", ref, c, claude("alfred-triage", ref, c.inbox()));
        }
        if (c.waitingOnUser() > 0) {
            return new BoardStage(Stage.TRIAGE, "Answer the " + c.waitingOnUser() + " question(s) and proposal(s) waiting on you on the board",
                    ref, c, new Step(StepKind.USER, null, null, c.waitingOnUser()));
        }
        if (c.toDo() + c.inProgress() > 0) {
            return new BoardStage(Stage.CODE, "Write the code for the " + (c.toDo() + c.inProgress()) + " To do card(s), then /alfred-verify "
                    + ref + " - it finds what is written and asks \"Record as fixed?\"", ref, c, claude("alfred-fix", ref, c.toDo() + c.inProgress()));
        }
        if (c.fixed() > 0) {
            return new BoardStage(Stage.VERIFY, "/alfred-verify " + ref + " - re-test the " + c.fixed() + " Fixed card(s) from the live calls "
                    + "(or press Record and /alfred-listen " + ref + ")", ref, c, claude("alfred-verify", ref, c.fixed()));
        }
        if (c.failing() > 0 || c.untested() > 0) {
            return new BoardStage(Stage.TEST, "Press Record (Cycles tab), then /alfred-listen " + ref + " and run the test steps - "
                    + (c.untested() > 0 ? c.untested() + " item(s) not tested yet" : c.failing() + " item(s) failing by the calls"), ref, c,
                    new Step(StepKind.RECORD, "alfred-listen", "/alfred-listen " + ref, c.untested() > 0 ? c.untested() : c.failing()));
        }
        if (c.unmarked() > 0) {
            return new BoardStage(Stage.VERIFY, "/alfred-verify " + ref + " suggests the marks; mark the " + c.unmarked()
                    + " remaining item(s) on the Task tab", ref, c, claude("alfred-verify", ref, c.unmarked()));
        }
        return new BoardStage(Stage.CLOSE, "/alfred-report " + ref + " - the summary and the update for the main item", ref, c,
                claude("alfred-report", ref, 0));
    }
}
