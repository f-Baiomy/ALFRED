package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.UploadResult;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(StoredAnswersController.class)
class StoredAnswersControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ManageStoredAnswersUseCase answers;

    @Test
    void anUploadReturns201WithTheAnswer() throws Exception {
        StoredAnswer answer = new StoredAnswer("3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                StoredAnswer.Kind.FILE, 200, Map.of("content-type", "application/json"),
                "application/json", 2, null, null, null, null, null, null, "2026-09-23T12:00:00Z");
        when(answers.upload(eq("application/json"), eq(200), eq(2L), any()))
                .thenReturn(new UploadResult.Created(answer));

        mockMvc.perform(multipart("/interception/answers")
                        .file(new MockMultipartFile("file", "a.json", "application/json", "{}".getBytes()))
                        .param("contentType", "application/json")
                        .param("status", "200"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
                .andExpect(jsonPath("$.kind").value("FILE"));
    }

    @Test
    void anUploadOverTheCapReturns413WithBothSizes() throws Exception {
        when(answers.upload(eq("application/json"), eq(200), eq(11L), any()))
                .thenReturn(new UploadResult.TooLarge(10, 11));

        mockMvc.perform(multipart("/interception/answers")
                        .file(new MockMultipartFile("file", "a.json", "application/json", "x".repeat(11).getBytes()))
                        .param("contentType", "application/json")
                        .param("status", "200"))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error").value("answer-too-large"))
                .andExpect(jsonPath("$.limitBytes").value(10))
                .andExpect(jsonPath("$.sizeBytes").value(11));
    }

    @Test
    void anUploadWithNoContentTypeReturns415() throws Exception {
        when(answers.upload(eq(null), eq(200), eq(4L), any()))
                .thenReturn(new UploadResult.MissingContentType());

        mockMvc.perform(multipart("/interception/answers")
                        .file(new MockMultipartFile("file", "a.bin", null, "test".getBytes()))
                        .param("status", "200"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.error").value("content-type-required"));
    }

    @Test
    void anUploadWithNoFilePartIs400() throws Exception {
        mockMvc.perform(multipart("/interception/answers")
                        .param("contentType", "application/json")
                        .param("status", "200"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(answers);
    }
}
