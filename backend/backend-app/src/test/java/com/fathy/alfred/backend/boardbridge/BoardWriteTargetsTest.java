package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.BoardOfUseCase;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class BoardWriteTargetsTest {

    private final ObjectMapper json = new ObjectMapper();
    private BoardWriteTargets targets;

    @BeforeEach
    void setUp() {
        BoardOfUseCase of = mock(BoardOfUseCase.class);
        when(of.boardOfCard(anyString())).thenAnswer(i -> "card-1".equals(i.getArgument(0)) ? Optional.of("b-card") : Optional.empty());
        when(of.boardOfCardNumber(anyString(), any(Integer.class))).thenReturn(Optional.of("b-number"));
        when(of.boardOfChatMessage(anyLong())).thenReturn(Optional.of("b-message"));
        when(of.boardOfChatRecord(anyLong())).thenReturn(Optional.of("b-record"));
        when(of.boardOfSnippet(anyString())).thenReturn(Optional.of("b-snippet"));
        when(of.boardOfFile(anyString())).thenReturn(Optional.of("b-file"));
        when(of.boardOfAsk(anyString())).thenReturn(Optional.of("b-ask"));
        when(of.boardOfRun(anyString())).thenReturn(Optional.of("b-run"));
        when(of.boardOfChat(anyString(), anyString())).thenAnswer(i -> "project".equals(i.getArgument(1))
                ? "default:" + i.getArgument(0) : i.getArgument(1));
        targets = new BoardWriteTargets(of);
    }

    private BoardWriteTargets.Target of(String method, String path, String body) throws Exception {
        JsonNode node = body == null ? null : json.readTree(body);
        return targets.of(method, path, Map.of(), node);
    }

    @Test
    void boardsAndCyclesAreNamedInThePath() throws Exception {
        assertThat(of("PUT", "/board/boards/b1/brief", "{}").boards()).containsExactly("b1");
        assertThat(of("PUT", "/board/cycles/c1/steps/s1", null).boards()).containsExactly("c1");
        assertThat(of("PUT", "/board/boards/b1/boards/b2", null).boards()).containsExactlyInAnyOrder("b1", "b2");
    }

    @Test
    void aCardWriteIsItsBoardsAndACommentIsAComment() throws Exception {
        BoardWriteTargets.Target move = of("POST", "/board/cards/card-1/move", "{\"status\":\"TO_DO\"}");
        assertThat(move.boards()).containsExactly("b-card");
        assertThat(move.kind()).isEqualTo(WriteDecision.Kind.EDIT);
        assertThat(of("POST", "/board/cards/card-1/comments", "{\"text\":\"hi\"}").kind()).isEqualTo(WriteDecision.Kind.COMMENT);
    }

    @Test
    void aQuestionsFormAndADryRunImportAreNotLockedApplyingIs() throws Exception {
        // specs/037: making the form and reading an answers file change no card
        assertThat(of("POST", "/board/boards/b1/questions-form", "{\"cards\":[3]}").boards()).isEmpty();
        assertThat(of("POST", "/board/boards/b1/answers-import", "{\"fileId\":\"f-12345678\"}").boards()).isEmpty();
        assertThat(of("POST", "/board/boards/b1/answers-import", "{\"fileId\":\"f-12345678\",\"dryRun\":true}").boards()).isEmpty();
        assertThat(of("POST", "/board/boards/b1/answers-import", "{\"fileId\":\"f-12345678\",\"dryRun\":false}").boards()).containsExactly("b1");
    }

    @Test
    void aCardMovedHomeLocksBothBoards() throws Exception {
        assertThat(of("PUT", "/board/cards/card-1/home", "{\"boardId\":\"b9\"}").boards()).containsExactlyInAnyOrder("b-card", "b9");
    }

    @Test
    void chatsByScopeAndMessagesByTheirChat() throws Exception {
        BoardWriteTargets.Target send = targets.of("POST", "/board/chats/project/messages", Map.of("project", "odeysys"), null);
        assertThat(send.boards()).containsExactly("default:odeysys");
        assertThat(send.kind()).isEqualTo(WriteDecision.Kind.MESSAGE);
        assertThat(of("POST", "/board/chats/b1/messages", "{\"project\":\"odeysys\",\"text\":\"x\"}").boards()).containsExactly("b1");
        assertThat(of("POST", "/board/chats/messages/12/reply", "{}").boards()).containsExactly("b-message");
        assertThat(of("POST", "/board/chats/records/4/undo", null).boards()).containsExactly("b-record");
    }

    @Test
    void newCardsRunsAndAsksByTheirFields() throws Exception {
        assertThat(of("POST", "/board/cards", "{\"project\":\"odeysys\",\"cycleId\":\"c1\"}").boards()).containsExactly("c1");
        assertThat(of("POST", "/board/cards/quick", "{\"project\":\"odeysys\"}").boards()).containsExactly("default:odeysys");
        assertThat(of("POST", "/board/skill-runs", "{\"project\":\"odeysys\",\"cardNumber\":7}").boards()).containsExactly("b-number");
        assertThat(of("POST", "/board/skill-runs/r1/stop", null).boards()).containsExactly("b-run");
        assertThat(of("POST", "/board/asks/a1/cancel", null).boards()).containsExactly("b-ask");
        assertThat(of("PUT", "/board/snippets/s1", "{}").boards()).containsExactly("b-snippet");
        assertThat(of("DELETE", "/board/files/f1", null).boards()).containsExactly("b-file");
    }

    @Test
    void sessionPlumbingAndProjectWideSettingsAreNeverLocked() throws Exception {
        for (String path : new String[]{"/board/holders/request", "/board/helpers/heartbeat", "/board/browsers/pair", "/board/me/settings",
                "/board/sessions", "/board/helper-commands/claim", "/board/live-runner", "/board/live-work", "/board/skill-runs/claim",
                "/board/teams/t1", "/board/widgets/w", "/board/storage/compact", "/board/chats/terminal/delivered", "/board/import"}) {
            assertThat(of("POST", path, "{\"boardId\":\"b1\",\"project\":\"odeysys\"}").boards()).as(path).isEmpty();
        }
        assertThat(of("PUT", "/board/skill-runs/r1", "{\"state\":\"DONE\"}").boards()).isEmpty();
    }
}
