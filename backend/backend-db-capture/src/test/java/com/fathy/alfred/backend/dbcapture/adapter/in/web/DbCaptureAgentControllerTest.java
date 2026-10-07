package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.RecordAgentHeartbeatUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(DbCaptureAgentController.class)
@TestPropertySource(properties = "alfred.webhook.secret=s3cret")
class DbCaptureAgentControllerTest {

    private static final String BATCH = """
            {"agentId":"agent-1","project":"wallet-app","statements":[
              {"sid":"agent-1:1","callId":"call-1","thread":"default task-14","seq":1,"kind":"SELECT",
               "sql":"SELECT balance FROM wallet WHERE user_id = ?","params":[[{"type":"BIGINT","value":"1042"}]],
               "outcome":{"kind":"ROWS","columns":[{"name":"balance","type":"DECIMAL"}],"rowsRead":1},
               "rows":[[{"type":"DECIMAL","value":"500.00"}]],"durationMicros":6200,"someNewerField":true}],
             "markers":[{"callId":"call-1","seq":0,"type":"CALL_OPEN"}]}
            """;

    @Autowired
    private MockMvc mvc;

    @MockBean
    private IngestStatementsUseCase ingest;
    @MockBean
    private RecordAgentHeartbeatUseCase heartbeat;

    @Test
    void aMissingOrWrongSecretIs401() throws Exception {
        mvc.perform(post("/db-capture/agent/batch").contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "nope").contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(ingest);
    }

    @Test
    void theKeyTheReverseProxyStampedIsAcceptedInPlaceOfTheSecret() throws Exception {
        when(ingest.ingest(any())).thenReturn(new IngestResult(1, 0));
        String key = AgentKey.make("s3cret", java.time.Instant.now());
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "stale").header("X-Alfred-Agent-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isAccepted());
        // a key made under another secret, an expired one, or garbage: 401 as before
        mvc.perform(post("/db-capture/agent/batch").header("X-Alfred-Agent-Key", AgentKey.make("other", java.time.Instant.now()))
                        .contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/db-capture/agent/batch").header("X-Alfred-Agent-Key", AgentKey.make("s3cret", java.time.Instant.now().minusSeconds(2 * 24 * 3600)))
                        .contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/db-capture/agent/batch").header("X-Alfred-Agent-Key", "nonsense")
                        .contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void aValidBatchIsAcceptedAndMapped() throws Exception {
        when(ingest.ingest(any())).thenReturn(new IngestResult(1, 0));
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "s3cret").contentType(MediaType.APPLICATION_JSON).content(BATCH))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.accepted").value(1));

        ArgumentCaptor<IngestBatch> captor = ArgumentCaptor.forClass(IngestBatch.class);
        verify(ingest).ingest(captor.capture());
        assertThat(captor.getValue().statements()).singleElement().satisfies(s -> {
            assertThat(s.callId()).isEqualTo("call-1");
            assertThat(s.rows()).hasSize(1);
            assertThat(s.outcome().rowsRead()).isEqualTo(1);
        });
        assertThat(captor.getValue().markers()).hasSize(1);
    }

    @Test
    void invalidStatementsAre400() throws Exception {
        String noKind = BATCH.replace("\"kind\":\"SELECT\",", "");
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "s3cret").contentType(MediaType.APPLICATION_JSON).content(noKind))
                .andExpect(status().isBadRequest());
        String negativeSeq = BATCH.replace("\"seq\":1", "\"seq\":-1");
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "s3cret").contentType(MediaType.APPLICATION_JSON).content(negativeSeq))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(ingest);
    }

    @Test
    void theHeartbeatReturnsTheAgentsSettings() throws Exception {
        when(heartbeat.heartbeat(any())).thenReturn(new AgentDirective(DbCaptureSettings.defaults(), true));
        mvc.perform(post("/db-capture/agent/heartbeat").header("X-Webhook-Secret", "s3cret").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agentId\":\"agent-1\",\"project\":\"wallet-app\",\"agentVersion\":\"1.0.0\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.rowsPerResult").value(50000))
                .andExpect(jsonPath("$.outsideCallCapture").value(true))
                .andExpect(jsonPath("$.captureEnabled").value(true))
                .andExpect(jsonPath("$.logLevel").value("ERROR"))
                .andExpect(jsonPath("$.thresholds").doesNotExist());
    }

    @org.junit.jupiter.api.Test
    void redisCommandsAndPartsAreMappedAndAnUnreadableCommandNeverRejectsTheBatch() throws Exception {
        when(ingest.ingest(any())).thenReturn(new IngestResult(1, 0));
        String batch = """
                {"agentId":"agent-1","project":"odeysys","statements":[],
                 "markers":[{"callId":"call-1","seq":0,"type":"CALL_OPEN","redis":true}],
                 "redis":[{"sid":"a-r1","callId":"call-1","seq":1,"command":"GET","keys":["fare:rule:EK"],"args":"KjINCg==","reply":"JC0xDQo=",
                           "replyType":"NIL","origin":{"store":"spring-cache","cache":"fareRules"},"group":{"kind":"tx","id":"g1","index":0,"size":2}},
                          {"sid":"a-r2","callId":"call-1","seq":2,"command":"GET","keys":["k"],"args":"%%%not-base64"}],
                 "redisChunks":[{"sid":"a-r3","which":"reply","part":0,"of":1,"data":"AQID"}],
                 "droppedRedis":{"call-1":1}}
                """;
        mvc.perform(post("/db-capture/agent/batch").header("X-Webhook-Secret", "s3cret").contentType(MediaType.APPLICATION_JSON).content(batch))
                .andExpect(status().isAccepted());
        org.mockito.ArgumentCaptor<com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch> captor =
                org.mockito.ArgumentCaptor.forClass(com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch.class);
        org.mockito.Mockito.verify(ingest).ingest(captor.capture());
        var b = captor.getValue();
        org.assertj.core.api.Assertions.assertThat(b.markers().get(0).redis()).isTrue();
        org.assertj.core.api.Assertions.assertThat(b.redis()).hasSize(2);
        org.assertj.core.api.Assertions.assertThat(b.redis().get(0).command().origin().cache()).isEqualTo("fareRules");
        org.assertj.core.api.Assertions.assertThat(b.redis().get(0).command().reply()).isEqualTo("$-1\r\n".getBytes());
        org.assertj.core.api.Assertions.assertThat(b.redis().get(1).invalid()).startsWith("invalid record");
        org.assertj.core.api.Assertions.assertThat(b.redisChunks().get(0).data()).containsExactly(1, 2, 3);
        org.assertj.core.api.Assertions.assertThat(b.droppedRedis()).containsEntry("call-1", 1L);
    }
}
