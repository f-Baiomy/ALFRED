package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.service.LiveWorkService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The live-work endpoints over the real service: what the runners send, what the board and the other sessions read back. */
@WebMvcTest(LiveWorkController.class)
@Import(LiveWorkService.class)
class LiveWorkControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** What the service keeps of a report: the latest steps, and an outcome cut to this length. */
    private static final int KEPT_STEPS = 40;
    private static final int KEPT_OUTCOME_LENGTH = 500;

    @Autowired
    MockMvc mvc;

    @MockBean
    BoardNotificationPort notifications;

    private static String report(int steps, int outcomeLength) throws Exception {
        List<String> list = new ArrayList<>();
        for (int i = 0; i < steps; i++) {
            list.add("step " + i);
        }
        return JSON.writeValueAsString(java.util.Map.of("id", "r1", "project", "odeysys", "cardNumber", 12, "state", "FAILED",
                "steps", list, "outcome", "o".repeat(outcomeLength)));
    }

    @Test
    void aLongRunsReportIsCutToTheServicesBoundsNotRefused() throws Exception {
        String body = mvc.perform(put("/board/live-work").contentType(MediaType.APPLICATION_JSON).content(report(200, 2000)))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);

        JsonNode work = JSON.readTree(body);
        assertThat(work.get("steps")).hasSize(KEPT_STEPS);
        assertThat(work.get("steps").get(KEPT_STEPS - 1).asText()).isEqualTo("step 199");
        assertThat(work.get("outcome").asText()).hasSize(KEPT_OUTCOME_LENGTH);
    }

    @Test
    void aReportBeyondTheEdgeIsStillRefused() throws Exception {
        mvc.perform(put("/board/live-work").contentType(MediaType.APPLICATION_JSON).content(report(201, 10))).andExpect(status().isBadRequest());
        mvc.perform(put("/board/live-work").contentType(MediaType.APPLICATION_JSON).content(report(1, 2001))).andExpect(status().isBadRequest());
    }

    @Test
    void aRunnerSaysWhichKindItIsAndTheBoardReadsItBack() throws Exception {
        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"odeysys\",\"host\":\"laptop\",\"kind\":\"listen\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.kind").value("listen"));

        mvc.perform(get("/board/live-runner").param("project", "odeysys"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.kind").value("listen"))
                .andExpect(jsonPath("$.host").value("laptop"));
        verify(notifications).liveRunner(eq("odeysys"), eq("laptop"), eq("listen"));
    }

    @Test
    void aRunnerWithNoKindIsTheLiveRunnerAndAskingForAKindFiltersOnIt() throws Exception {
        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON).content("{\"project\":\"shop\",\"host\":\"laptop\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.kind").value("live"));
        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"shop\",\"host\":\"desktop\",\"kind\":\"listen\"}"))
                .andExpect(status().isOk());

        // both run: the board is answered by the live one; each kind can be asked for on its own
        mvc.perform(get("/board/live-runner").param("project", "shop")).andExpect(jsonPath("$.kind").value("live"));
        mvc.perform(get("/board/live-runner").param("project", "shop").param("kind", "listen")).andExpect(jsonPath("$.host").value("desktop"));

        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"shop\",\"host\":\"desktop\",\"kind\":\"listen\",\"stopped\":true}"))
                .andExpect(status().isOk());
        mvc.perform(get("/board/live-runner").param("project", "shop").param("kind", "listen")).andExpect(status().isNoContent());
        mvc.perform(get("/board/live-runner").param("project", "shop").param("kind", "live")).andExpect(status().isOk());
        mvc.perform(get("/board/live-runner").param("project", "nobody")).andExpect(status().isNoContent());
    }

    @Test
    void aCycleBelongsToOneChatASecondChatIsRefusedAndTheBoardReadsTheOwner() throws Exception {
        String beat = "{\"project\":\"crm\",\"host\":\"laptop\",\"kind\":\"live\",\"cycleId\":\"cy9\",\"chatId\":\"%s\",\"cwd\":\"C:/work/crm\"}";
        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON).content(beat.formatted("chat-a")))
                .andExpect(status().isOk());

        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON).content(beat.formatted("chat-b")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("one chat per board")));

        mvc.perform(get("/board/cycle-chat").param("cycleId", "cy9").param("project", "crm"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.chat.chatId").value("chat-a"))
                .andExpect(jsonPath("$.chat.chatAlive").value(true))
                .andExpect(jsonPath("$.lastCwd").value("C:/work/crm"));
        mvc.perform(get("/board/cycle-chat").param("cycleId", "nobody")).andExpect(jsonPath("$.chat").isEmpty());
    }

    @Test
    void aKindLongerThanTwentyCharactersIsRefused() throws Exception {
        mvc.perform(put("/board/live-runner").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"p\",\"host\":\"h\",\"kind\":\"" + "k".repeat(21) + "\"}"))
                .andExpect(status().isBadRequest());
    }
}
