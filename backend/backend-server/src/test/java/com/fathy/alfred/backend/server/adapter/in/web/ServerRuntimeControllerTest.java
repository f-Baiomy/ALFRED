package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ServerRuntimeController.class)
@TestPropertySource(properties = "alfred.webhook.secret=s3cret")
class ServerRuntimeControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private ServerRuntimeUseCase runtime;
    @MockBean
    private EditAccessUseCase editAccess;

    @BeforeEach
    void localOnly() {
        when(editAccess.access(anyString(), any())).thenAnswer(inv -> AccessRule.parse("local")
                .decide(inv.getArgument(0), inv.getArgument(1), Set.of(), RuntimeMode.NATIVE));
    }

    @Test
    void aLocalRestartIsAccepted() throws Exception {
        mvc.perform(post("/server/restart").contentType(MediaType.APPLICATION_JSON).content("{\"what\":\"PROXIES\"}"))
                .andExpect(status().isAccepted());
        verify(runtime).restart(ServerRuntimeUseCase.Target.PROXIES);
    }

    @Test
    void aRestartThroughTheTunnelIsRefused() throws Exception {
        mvc.perform(post("/server/restart").contentType(MediaType.APPLICATION_JSON).content("{\"what\":\"BACKEND\"}")
                        .header("Cf-Ray", "1"))
                .andExpect(status().isForbidden());
        verify(runtime, never()).restart(any());
    }

    @Test
    void dockerModeAnswers409() throws Exception {
        doThrow(new IllegalStateException("Alfred runs with Docker here")).when(runtime).restart(any());
        mvc.perform(post("/server/restart").contentType(MediaType.APPLICATION_JSON).content("{\"what\":\"BACKEND\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.reason").value("DOCKER_MODE"));
    }

    @Test
    void dockerLetsAnAttachThroughButNoOtherWriteAndNothingFromTheTunnel() throws Exception {
        org.mockito.Mockito.doAnswer(inv -> AccessRule.parse("local")
                .decide(inv.getArgument(0), inv.getArgument(1), Set.of(), RuntimeMode.DOCKER)).when(editAccess).access(anyString(), any());
        when(runtime.attachAgent("odeysys", java.util.List.of("db"), true)).thenReturn(true);
        mvc.perform(post("/server/agents/attach").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"odeysys\",\"features\":[\"db\"],\"force\":true}"))
                .andExpect(status().isAccepted());
        mvc.perform(post("/server/agents/attach").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"odeysys\",\"features\":[\"db\"],\"force\":true}").header("Cf-Ray", "1"))
                .andExpect(status().isForbidden());
        mvc.perform(post("/server/restart").contentType(MediaType.APPLICATION_JSON).content("{\"what\":\"BACKEND\"}"))
                .andExpect(status().isForbidden());
        verify(runtime, times(1)).attachAgent(any(), any(), org.mockito.ArgumentMatchers.anyBoolean());
        verify(runtime, never()).restart(any());
    }

    @Test
    void anAttachIsPassedOnOrSaysWhyItCannotBe() throws Exception {
        when(runtime.attachAgent("odeysys", java.util.List.of("proxy", "db", "logs", "redis"), false)).thenReturn(true);
        mvc.perform(post("/server/agents/attach").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"odeysys\",\"features\":[\"proxy\",\"db\",\"logs\",\"redis\"]}"))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.accepted").value(true));
        when(runtime.attachAgent("core", java.util.List.of("db", "logs", "redis"), false)).thenReturn(false);
        mvc.perform(post("/server/agents/attach").contentType(MediaType.APPLICATION_JSON).content("{\"project\":\"core\"}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("alfred attach")));
        mvc.perform(post("/server/agents/attach").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"odeysys\",\"features\":[\"rm -rf\"]}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void supervisorEventsNeedTheWebhookSecretNotTheAccessRule() throws Exception {
        String body = "{\"name\":\"OUTBOUND\",\"state\":\"CRASHED\",\"pid\":12,\"listeners\":[]}";
        mvc.perform(post("/server/supervisor-events").contentType(MediaType.APPLICATION_JSON).content(body)
                        .header("X-Webhook-Secret", "wrong").with(r -> { r.setRemoteAddr("10.0.0.9"); return r; }))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/server/supervisor-events").contentType(MediaType.APPLICATION_JSON).content(body)
                        .header("X-Webhook-Secret", "s3cret"))
                .andExpect(status().isNoContent());
        verify(runtime).processChanged("OUTBOUND");
    }

    @Autowired
    private AppSeenListener appSeen;

    @Test
    void anAppEventFromTheSupervisorIsPublishedForTheAttachDecision() throws Exception {
        String body = "{\"name\":\"APP\",\"state\":\"LISTENING\",\"project\":\"odeysys\",\"port\":9001,\"pid\":68108}";
        mvc.perform(post("/server/supervisor-events").contentType(MediaType.APPLICATION_JSON).content(body)
                        .header("X-Webhook-Secret", "s3cret"))
                .andExpect(status().isNoContent());
        org.assertj.core.api.Assertions.assertThat(appSeen.seen)
                .containsExactly(new ServerRuntimeUseCase.AppSeen("odeysys", 9001, 68108, true));
        mvc.perform(post("/server/supervisor-events").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"APP\",\"state\":\"GONE\",\"project\":\"odeysys\",\"port\":9001,\"pid\":0}")
                        .header("X-Webhook-Secret", "s3cret"))
                .andExpect(status().isNoContent());
        org.assertj.core.api.Assertions.assertThat(appSeen.seen).hasSize(2);
        org.assertj.core.api.Assertions.assertThat(appSeen.seen.get(1).listening()).isFalse();
    }

    @org.springframework.boot.test.context.TestConfiguration
    static class AppSeenListener {
        final java.util.List<ServerRuntimeUseCase.AppSeen> seen = new java.util.concurrent.CopyOnWriteArrayList<>();

        @org.springframework.context.event.EventListener
        void on(ServerRuntimeUseCase.AppSeen event) {
            seen.add(event);
        }
    }
}
