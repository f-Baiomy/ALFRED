package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.WidgetsUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.Widget;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(BoardFilesController.class)
class BoardFilesControllerTest {

    private static final Instant AT = Instant.parse("2026-10-14T09:00:00Z");
    private static final byte[] CSV = "a,b\n1,2\n".getBytes(StandardCharsets.UTF_8);

    @Autowired
    MockMvc mvc;

    @MockBean BoardFilesUseCase files;
    @MockBean WidgetsUseCase widgets;

    private static BoardFile file(byte[] data) {
        return new BoardFile("f-12345678", "odeysys", "card-1", null, "fares.csv", "text/csv", CSV.length, data, Actor.USER, AT);
    }

    @Test
    void theBodyIsTheFileAsItIs() throws Exception {
        when(files.attach(eq(Actor.USER), eq("card-1"), eq(null), eq(null), eq("fares.csv"), eq(CSV))).thenReturn(Result.ok(file(null)));
        mvc.perform(post("/board/files").param("card", "card-1").param("name", "fares.csv").contentType("text/csv").content(CSV))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("f-12345678"))
                .andExpect(jsonPath("$.data").doesNotExist());
    }

    @Test
    void aFileIsServedAsADownloadInASandboxOrAsPlainTextForASnippet() throws Exception {
        when(files.file("f-12345678")).thenReturn(Optional.of(file(CSV)));
        mvc.perform(get("/board/files/f-12345678"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "text/csv"))
                .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.startsWith("attachment")))
                .andExpect(header().string("Content-Security-Policy", "sandbox; default-src 'none'"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(content().bytes(CSV));
        mvc.perform(get("/board/files/f-12345678").param("inline", "true"))
                .andExpect(header().string("Content-Type", "text/plain;charset=UTF-8"))
                .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.startsWith("inline")));
        mvc.perform(get("/board/files/nope-0000")).andExpect(status().isNotFound());
    }

    @Test
    void widgetsByNameInAProject() throws Exception {
        Widget w = new Widget("odeysys", "fare-chart", Widget.Kind.BLOCK, "", "```chart\n```", Actor.USER, AT, Actor.USER);
        when(widgets.widget("odeysys", "fare-chart")).thenReturn(Optional.of(w));
        when(widgets.put(Actor.CLAUDE, "odeysys", "fare-chart", "block", "", "x")).thenReturn(Result.refused(
                com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.REFUSED_FOR_CLAUDE, "Claude changes only the widgets it created"));
        mvc.perform(get("/board/widgets/fare-chart").param("project", "odeysys")).andExpect(status().isOk()).andExpect(jsonPath("$.kind").value("BLOCK"));
        mvc.perform(get("/board/widgets/other").param("project", "odeysys")).andExpect(status().isNotFound());
        mvc.perform(put("/board/widgets/fare-chart").param("project", "odeysys").header("X-Alfred-Actor", "claude").contentType("application/json")
                        .content("{\"kind\":\"block\",\"info\":\"\",\"source\":\"x\"}"))
                .andExpect(status().isConflict());
    }
}
