package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.SkillRunStorePort;
import com.fathy.alfred.backend.board.application.service.LiveWorkService;
import com.fathy.alfred.backend.board.application.service.SkillRunsService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** ▶ over HTTP: the board's request, the chat's runner's claim that waits for it, the reports, and the refusals the button reads. */
@WebMvcTest(SkillRunsController.class)
@Import({SkillRunsService.class, LiveWorkService.class, SkillRunsControllerTest.Store.class})
class SkillRunsControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    MockMvc mvc;

    @Autowired
    LiveWorkUseCase live;

    @MockBean
    BoardNotificationPort notifications;

    @TestConfiguration
    static class Store {
        @Bean
        SkillRunStorePort skillRunStore() {
            return new com.fathy.alfred.backend.board.application.service.SkillRunsServiceTest.MemoryStore();
        }
    }

    private static String body(String json) {
        return json.replace('\'', '"');
    }

    @Test
    void withNoChatForTheCycleTheRequestIsRefusedWith404AndAReason() throws Exception {
        mvc.perform(post("/board/skill-runs").contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'project':'odeysys','cycleId':'no-chat-here','cardNumber':35,'command':'/alfred-fix 35'}")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("No chat handles this cycle")));
    }

    @Test
    void aWaitingClaimIsWokenByTheRequestAndTheReportsEndTheRun() throws Exception {
        live.chatBeat("odeysys", "cy1", "chat-a", "laptop", "C:/work/odeysys", "live", true, false);
        MvcResult waiting = mvc.perform(post("/board/skill-runs/claim").contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'chatId':'chat-a','host':'laptop','max':2,'waitSeconds':10}")))
                .andExpect(request().asyncStarted()).andReturn();

        mvc.perform(post("/board/skill-runs").contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'project':'odeysys','cycleId':'cy1','cardNumber':35,'command':'/alfred-fix 35','prompt':'/alfred-fix 35 with details','note':'only the SQL'}")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.state").value("QUEUED"));

        JsonNode taken = JSON.readTree(mvc.perform(asyncDispatch(waiting)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(taken).hasSize(1);
        assertThat(taken.get(0).get("state").asText()).isEqualTo("SENT");
        assertThat(taken.get(0).get("note").asText()).isEqualTo("only the SQL");
        String id = taken.get(0).get("id").asText();

        mvc.perform(post("/board/skill-runs").contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'project':'odeysys','cycleId':'cy1','cardNumber':35,'command':'/alfred-sync 35'}")))
                .andExpect(status().isConflict());

        mvc.perform(put("/board/skill-runs/" + id).contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'state':'RUNNING'}"))).andExpect(status().isOk());
        mvc.perform(put("/board/skill-runs/" + id).contentType(MediaType.APPLICATION_JSON)
                        .content(body("{'state':'DONE','steps':['reading #35'],'outcome':'→ plan posted','result':'#35 [16]'}")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("DONE"));

        mvc.perform(get("/board/skill-runs").param("project", "odeysys").param("cardNumber", "35"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runs[0].result").value("#35 [16]"))
                .andExpect(jsonPath("$.usualMs['/alfred-fix']").exists());
    }

    @Test
    void aClaimWithNothingQueuedAndNoWaitAnswersAtOnce() throws Exception {
        mvc.perform(post("/board/skill-runs/claim").contentType(MediaType.APPLICATION_JSON).content(body("{'chatId':'chat-a','host':'laptop'}")))
                .andExpect(request().asyncStarted())
                .andExpect(request().asyncResult(org.hamcrest.Matchers.notNullValue()));
    }
}
