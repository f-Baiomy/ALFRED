package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;

import java.util.List;
import java.util.Map;

/**
 * An answers file back on the board (specs/037 D16-D20): read, checked against the form Alfred made and the board as it
 * is now, shown as a report, and - when asked - applied: each answer recorded on its question as the user's, with where
 * it came from. A dry run writes nothing. Applying is the user's; Claude applies only with {@code askedIn} naming the
 * user's request (a user chat message on the board, or "terminal").
 */
public interface AnswersImportUseCase {

    /** What happened (or would happen) to one answer. */
    enum Verdict { APPLY, APPLIED, ALREADY_ANSWERED, CHANGED, UNKNOWN_KEY, LATER, NOT_ANSWERED, REFUSED }

    record Choice(String id, String label) {
    }

    record FollowRow(String header, String question, List<Choice> choice) {
    }

    record Row(String q, Integer card, String header, String question, List<Choice> choice, boolean other, boolean later, String note,
               String sure, FollowRow follow, Verdict result, String message) {
    }

    record FileInfo(String formId, String board, String boardName, String answeredBy, String role, String answeredAt, String lang) {
    }

    record Report(FileInfo file, List<Row> rows, int applied, Map<Verdict, Integer> summary, boolean dryRun) {
    }

    /** {@code name} and {@code data}: the file as uploaded (.html or .zip). {@code boardId} null: the form's own board. */
    Result<Report> fromFile(String boardId, String name, byte[] data, boolean dryRun, Actor actor, String askedIn);

    /** The machine block's JSON, already taken out of the file (the MCP server reads files itself). */
    Result<Report> fromJson(String boardId, String json, boolean dryRun, Actor actor, String askedIn);

    /** A file stored on the board (POST /board/files). */
    Result<Report> fromStoredFile(String boardId, String fileId, boolean dryRun, Actor actor, String askedIn);
}
