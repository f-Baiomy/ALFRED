package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(SnippetsController.class)
class SnippetsControllerTest {

    private static final Instant AT = Instant.parse("2026-10-14T09:00:00Z");

    @Autowired
    MockMvc mvc;

    @MockBean SnippetsUseCase snippets;

    private static Snippet page() {
        return new Snippet("p-12345678", Snippet.Owner.CARD, "card-1", "odeysys", "card-1", null, "Dash", Snippet.Kind.HTML, "live", "<b>x</b>",
                Actor.CLAUDE, false, 0, 1, AT, AT, Actor.CLAUDE);
    }

    @Test
    void claudeCreatesAPageAsClaude() throws Exception {
        when(snippets.create(eq(Actor.CLAUDE), any())).thenReturn(Result.ok(page()));

        mvc.perform(post("/board/pages").header("X-Alfred-Actor", "claude").contentType("application/json")
                        .content("{\"owner\":\"card:card-1\",\"name\":\"Dash\",\"kind\":\"html\",\"info\":\"live\",\"source\":\"<b>x</b>\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("p-12345678"))
                .andExpect(jsonPath("$.author").value("CLAUDE"));
    }

    @Test
    void anInlineSnippetsIdWithColonsReachesItsStateAndAValueIsAnyJson() throws Exception {
        String id = "inline:card:card-1:desc:0";
        when(snippets.putState(Actor.USER, id, "filter", "{\"status\":[500,502]}"))
                .thenReturn(Result.ok(new SnippetState(id, "filter", "{\"status\":[500,502]}", Actor.USER, AT)));
        when(snippets.state(id)).thenReturn(Result.ok(List.of(new SnippetState(id, "filter", "1", Actor.USER, AT))));

        mvc.perform(put("/board/snippets/" + id + "/state/filter").contentType("application/json").content("{\"value\":{\"status\":[500,502]}}"))
                .andExpect(status().isOk());
        mvc.perform(get("/board/snippets/" + id + "/state")).andExpect(status().isOk()).andExpect(jsonPath("$[0].key").value("filter"));
        when(snippets.putState(Actor.USER, id, "filter", null)).thenReturn(Result.ok(null));
        mvc.perform(put("/board/snippets/" + id + "/state/filter").contentType("application/json").content("{\"value\":null}"))
                .andExpect(status().isNoContent());
        verify(snippets).putState(eq(Actor.USER), eq(id), eq("filter"), isNull());
    }

    @Test
    void aRefusalSaysWhy() throws Exception {
        when(snippets.update(eq(Actor.USER), eq("p-12345678"), any()))
                .thenReturn(Result.refused(CardChange.Outcome.CONFLICT, "The page was saved again"));

        mvc.perform(put("/board/snippets/p-12345678").contentType("application/json").content("{\"source\":\"x\",\"baseVersion\":1}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("conflict"))
                .andExpect(jsonPath("$.message").value("The page was saved again"));
    }

    @Test
    void theShotIsServedAsJsonForClaudeAndAsAPicture() throws Exception {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 1};
        when(snippets.shot("p-12345678")).thenReturn(Optional.of(new SnippetShot("p-12345678", 3, png, "error: x", AT)));

        mvc.perform(get("/board/snippets/p-12345678/shot"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(3))
                .andExpect(jsonPath("$.console").value("error: x"))
                .andExpect(jsonPath("$.png").value("data:image/png;base64,iVBORwE="));
        mvc.perform(get("/board/snippets/p-12345678/shot").param("png", "false"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(3))
                .andExpect(jsonPath("$.png").doesNotExist());
        mvc.perform(get("/board/snippets/p-12345678/shot.png"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"))
                .andExpect(content().bytes(png));
        mvc.perform(get("/board/snippets/other-1234/shot")).andExpect(status().isNotFound());
    }
}
