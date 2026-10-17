package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.board.application.port.in.BoardFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The Team slice's way into Alfred's boards (specs/027 US8): a start is the user's waiting /alfred-setup message in the
 * target board's chat - answered by the terminal holding that board, else the project's runner (R6) - and the item's
 * attachments become the board's files.
 */
@Component
public class TeamBoardsAdapter implements TeamBoardsPort {

    static final String START_ORIGIN = "team-start";

    private final ManageBoardsUseCase boards;
    private final ChatUseCase chats;
    private final BoardFilesUseCase files;
    private final LiveWorkUseCase live;
    private final ObjectProvider<ManageDbCaptureUseCase> projects;

    public TeamBoardsAdapter(ManageBoardsUseCase boards, ChatUseCase chats, BoardFilesUseCase files, LiveWorkUseCase live,
                             ObjectProvider<ManageDbCaptureUseCase> projects) {
        this.boards = boards;
        this.chats = chats;
        this.files = files;
        this.live = live;
        this.projects = projects;
    }

    @Override
    public boolean projectExists(String project) {
        if (project == null || project.isBlank()) {
            return false;
        }
        var capture = projects.getIfAvailable();
        if (capture != null && capture.projects().stream().anyMatch(p -> project.equals(p.project()))) {
            return true; // a project Alfred fronts
        }
        // the default board is listed for any name (a read never writes it), so it counts only once it holds cards
        return boards.list(project, EnumSet.allOf(BoardState.class), null, 2).stream()
                .anyMatch(s -> project.equals(s.board().project()) && (!s.board().isDefault() || s.cards() > 0));
    }

    @Override
    public String whoAnswers(String project, String boardId) {
        if (boardId != null && live.cycleChat(boardId).isPresent()) {
            return "the terminal holding this board";
        }
        return live.runner(project).isPresent() ? "the project's live runner" : null;
    }

    /** A board's chat; the default board's is the project chat. */
    static ChatKey chatOf(String project, String boardId) {
        return new ChatKey(project, boardId == null ? "" : boardId);
    }

    @Override
    public Optional<String> projectOf(String boardId) {
        if (boardId == null || boardId.isBlank()) {
            return Optional.empty();
        }
        return boards.get(boardId).map(s -> s.board().project());
    }

    @Override
    public Optional<Long> postStart(String project, String boardId, String text) {
        if (boardId != null && !projectOf(boardId).map(project::equals).orElse(false)) {
            return Optional.empty();
        }
        ChatUseCase.Result<ChatMessage> r = chats.post(Actor.USER, chatOf(project, boardId),
                new ChatUseCase.Post(text, null, List.of(), null, false, START_ORIGIN, List.of()));
        return r.outcome() == CardChange.Outcome.OK ? Optional.of(r.value().id()) : Optional.empty();
    }

    @Override
    public boolean withdrawStart(long messageId) {
        return chats.cancel(Actor.USER, messageId).outcome() == CardChange.Outcome.OK; // refused once the setup was taken
    }

    @Override
    public boolean askedBy(String askedIn) {
        return boards.askedBy(askedIn).isPresent();
    }

    @Override
    public Set<String> files(String boardId) {
        com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result<List<BoardFile>> r = files.files(null, boardId);
        return r.value() == null ? Set.of() : r.value().stream().map(BoardFile::name).collect(Collectors.toSet());
    }

    @Override
    public String attach(String boardId, String name, byte[] data) {
        Optional<String> project = projectOf(boardId);
        if (project.isEmpty()) {
            return "no such board";
        }
        com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result<BoardFile> r = files.attach(Actor.USER, null, boardId, project.get(), name, data);
        return r.outcome() == CardChange.Outcome.OK ? null : r.message() == null ? "not stored" : r.message();
    }

    @Override
    public boolean suggest(String project, String boardId, String conn, String extId, String text) {
        if (boardId != null && !projectOf(boardId).map(project::equals).orElse(false)) {
            return false;
        }
        boolean someoneToAct = live.runner(project).isPresent() || (boardId != null && live.cycleChat(boardId).isPresent());
        if (!someoneToAct) {
            return false;
        }
        return chats.suggestStart(chatOf(project, boardId), conn, extId, text).outcome() == CardChange.Outcome.OK;
    }
}
