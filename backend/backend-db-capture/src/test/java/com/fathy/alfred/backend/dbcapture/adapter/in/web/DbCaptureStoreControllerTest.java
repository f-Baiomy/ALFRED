package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.GetStoreCommandsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.StoreSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandsPage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The Redis view's endpoints (specs/011-redis-capture T038). */
@WebMvcTest(DbCaptureStoreController.class)
class DbCaptureStoreControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private GetStoreCommandsUseCase commands;
    @MockBean
    private StoreSummariesUseCase summaries;

    @Test
    void pagesCommandsAndPassesTheLimitToTheUseCaseToClamp() throws Exception {
        when(commands.commands("c1", 0, 9999)).thenReturn(new StoreCommandsPage(0, List.of(), List.of(), 0, null));
        mvc.perform(get("/db-capture/calls/c1/store-commands").param("limit", "9999")).andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(0));
        verify(commands).commands("c1", 0, 9999);
    }

    @Test
    void anUnknownCommandIs404() throws Exception {
        when(commands.command(42, false)).thenReturn(Optional.empty());
        mvc.perform(get("/db-capture/store-commands/42")).andExpect(status().isNotFound());
    }

    @Test
    void redisCliIsPlainText() throws Exception {
        when(commands.redisCli("c1", List.of(1, 2))).thenReturn("SET k v\n");
        mvc.perform(get("/db-capture/calls/c1/store-commands/redis-cli").param("seq", "1,2")).andExpect(status().isOk())
                .andExpect(content().string("SET k v\n"));
    }

    @Test
    void tooManyIdsIs400() throws Exception {
        when(summaries.storeSummaries(anyList())).thenThrow(new IllegalArgumentException("at most 100 call ids per request"));
        mvc.perform(get("/db-capture/store/summaries").param("callIds", "a,b")).andExpect(status().isBadRequest());
    }

    @Test
    void failuresListTheCallsWithAFailedCommand() throws Exception {
        when(summaries.redisFailedCallIds(List.of("a", "b"))).thenReturn(List.of("b"));
        mvc.perform(get("/db-capture/store/failures").param("callIds", "a,b")).andExpect(status().isOk())
                .andExpect(jsonPath("$.redisFailedCallIds[0]").value("b"));
    }
}
