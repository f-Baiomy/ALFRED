package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.UploadResult;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** POST /interception/answers - the ANSWER_WITH_FILE upload endpoint. */
@WebMvcTest(StoredAnswersController.class)
@TestPropertySource(properties = "alfred.interception.max-answer-bytes=1048576")
class StoredAnswersControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ManageStoredAnswersUseCase answers;

    @Test
    void aMultipartUploadReturns201() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "stub.json", "application/json", "{}".getBytes());
        StoredAnswer created = new StoredAnswer("3f2504e0-4f89-41d3-9a0c-0305e82c3301", StoredAnswer.Kind.FILE, 200,
                Map.of("content-type", "application/json"), "application/json", 2, null, List.of(),
                null, null, null, null, "2026-09-24T00:00:00Z");
        when(answers.upload(any(), eq("application/json"), isNull())).thenReturn(new UploadResult.Created(created));

        mockMvc.perform(multipart("/interception/answers").file(file))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
                .andExpect(jsonPath("$.kind").value("FILE"));
    }

    @Test
    void overTheCapReturns413WithTheLimitAndSize() throws Exception {
        byte[] tooBig = new byte[2 * 1024 * 1024];
        MockMultipartFile file = new MockMultipartFile("file", "big.bin", "application/octet-stream", tooBig);

        mockMvc.perform(multipart("/interception/answers").file(file))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error").value("answer-too-large"))
                .andExpect(jsonPath("$.limitBytes").value(1048576));
    }

    @Test
    void noContentTypeReturns415() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "stub", null, "{}".getBytes());

        mockMvc.perform(multipart("/interception/answers").file(file))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.error").value("missing-content-type"));
    }

    @Test
    void anExplicitContentTypeOverridesTheFilesOwn() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "stub.txt", "text/plain", "hi".getBytes());
        StoredAnswer created = new StoredAnswer("3f2504e0-4f89-41d3-9a0c-0305e82c3301", StoredAnswer.Kind.FILE, null,
                Map.of("content-type", "application/xml"), "application/xml", 2, null, List.of(),
                null, null, null, null, "2026-09-24T00:00:00Z");
        when(answers.upload(any(), eq("application/xml"), isNull())).thenReturn(new UploadResult.Created(created));

        mockMvc.perform(multipart("/interception/answers").file(file).param("contentType", "application/xml"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.contentType").value("application/xml"));
    }
}
