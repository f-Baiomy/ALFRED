package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import com.fathy.alfred.backend.board.domain.model.SnippetVersion;

import java.util.List;
import java.util.Optional;

/**
 * Pages and what snippets keep (specs/017 R23, R28-R32). Claude may create pages and change or delete the ones it
 * created; the user may do anything. State and shots belong to any snippet - a page, or an inline block whose id says
 * where it is.
 */
public interface SnippetsUseCase {

    /** The outcome of a write: the value after it, or why it was not made. */
    record Result<T>(CardChange.Outcome outcome, T value, String message) {

        public static <T> Result<T> ok(T value) {
            return new Result<>(CardChange.Outcome.OK, value, null);
        }

        public static <T> Result<T> refused(CardChange.Outcome outcome, String message) {
            return new Result<>(outcome, null, message);
        }

        public boolean isOk() {
            return outcome == CardChange.Outcome.OK;
        }
    }

    /** A new page. {@code owner} is {@code card:<id>}, {@code cycle:<id>} or {@code project:<name>}. */
    record NewPage(String owner, String project, String name, String kind, String info, String source) {
    }

    /** What changes; a null field stays. {@code baseVersion}: the version the editor started from (a newer one is a conflict). */
    record PageEdit(String name, String info, String source, Boolean pinned, Integer position, Integer baseVersion) {
    }

    Result<List<Snippet>> pages(String owner, String project);

    Result<Snippet> create(Actor actor, NewPage page);

    Optional<Snippet> page(String id, Integer version);

    Result<Snippet> update(Actor actor, String id, PageEdit edit);

    Result<Void> delete(Actor actor, String id);

    Result<List<SnippetVersion>> versions(String id);

    Result<List<SnippetState>> state(String snippetId);

    Result<SnippetState> state(String snippetId, String key);

    /** {@code json}: the value as JSON text; null removes the key. */
    Result<SnippetState> putState(Actor actor, String snippetId, String key, String json);

    Result<List<SnippetState>> stateHistory(String snippetId, String key);

    /** {@code pngBase64}: the picture (a data: URL or bare base64); {@code console}: its log lines. */
    Result<Void> putShot(String snippetId, int version, String pngBase64, List<String> console);

    Optional<SnippetShot> shot(String snippetId);

    /** A page with every version of it, sources included (newest first). */
    record PageWithVersions(Snippet page, List<SnippetVersion> versions) {
    }

    /**
     * Everything visual kept with a card ({@code cardId}), a cycle ({@code cycleId}) or a project ({@code project}) - its
     * pages with all their versions, the saved values of its snippets and each one's newest shot - for the board export.
     */
    record Visuals(List<PageWithVersions> pages, List<SnippetState> states, List<SnippetShot> shots) {
    }

    Result<Visuals> visuals(String cardId, String cycleId, String project);
}
