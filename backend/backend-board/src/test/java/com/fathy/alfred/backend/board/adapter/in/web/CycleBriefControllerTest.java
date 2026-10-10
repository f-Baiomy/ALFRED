package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(CycleBriefController.class)
class CycleBriefControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean ManageBriefUseCase briefs;
    @MockBean ManageSpecFilesUseCase specs;
    @MockBean MarkChecklistUseCase checklist;

    private static ManageSpecFilesUseCase.SpecOutcome ok() {
        return new ManageSpecFilesUseCase.SpecOutcome(CardChange.Outcome.OK, new SpecFileInfo("spec.md", 4, Instant.parse("2026-10-10T09:00:00Z")),
                false, null);
    }

    @Test
    void aRawTextUploadKeepsItsExtensionAndText() throws Exception {
        when(specs.put(Actor.USER, "c-1", "spec.md", "# hi")).thenReturn(ok());

        mvc.perform(put("/board/cycles/c-1/specs/spec.md").contentType("text/markdown").content("# hi"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("spec.md"))
                .andExpect(jsonPath("$.replaced").value(false));
    }

    @Test
    void aMultipartUploadReadsTheFilePart() throws Exception {
        when(specs.put(Actor.USER, "c-1", "spec.md", "# hi")).thenReturn(ok());
        MockMultipartFile file = new MockMultipartFile("file", "spec.md", "text/markdown", "# hi".getBytes(StandardCharsets.UTF_8));

        mvc.perform(multipart("/board/cycles/c-1/specs/spec.md").file(file).with(r -> {
                    r.setMethod("PUT");
                    return r;
                }))
                .andExpect(status().isOk());
    }

    @Test
    void aWrongTypeIs400NamingTheAcceptedTypes() throws Exception {
        when(specs.put(eq(Actor.USER), eq("c-1"), eq("spec.pdf"), anyString())).thenReturn(new ManageSpecFilesUseCase.SpecOutcome(
                CardChange.Outcome.INVALID, null, false, "Only .md and .txt spec files are accepted"));

        mvc.perform(put("/board/cycles/c-1/specs/spec.pdf").contentType("application/pdf").content("x"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Only .md and .txt spec files are accepted"));
    }

    @Test
    void aSpecIsServedAsUtf8Text() throws Exception {
        when(specs.spec("c-1", "spec.md")).thenReturn(Optional.of(new SpecFile("c-1", "spec.md", "Déjà", 6, Instant.now())));

        mvc.perform(get("/board/cycles/c-1/specs/spec.md"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("text/plain;charset=UTF-8"))
                .andExpect(content().string("Déjà"));
    }

    @Test
    void readingStopsAtTheLimit() throws Exception {
        assertThat(CycleBriefController.readCapped(new ByteArrayInputStream(new byte[ManageSpecFilesUseCase.MAX_BYTES + 1]))).isNull();
        assertThat(CycleBriefController.readCapped(new ByteArrayInputStream("ok".getBytes(StandardCharsets.UTF_8)))).isEqualTo("ok");
    }
}
