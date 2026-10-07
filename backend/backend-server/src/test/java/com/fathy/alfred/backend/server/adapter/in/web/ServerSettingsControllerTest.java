package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.PreviewSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.SettingCatalog;
import com.fathy.alfred.backend.server.domain.model.SettingValue;
import com.fathy.alfred.backend.server.domain.model.Source;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** GET/PUT /server/settings and the access rule in front of every write (FR-050..052, contracts/server-api.md). */
@WebMvcTest(ServerSettingsController.class)
class ServerSettingsControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private GetSettingsUseCase getSettings;
    @MockBean
    private PreviewSettingsUseCase preview;
    @MockBean
    private SaveSettingsUseCase save;
    @MockBean
    private EditAccessUseCase editAccess;

    private static final String BODY = "{\"baseHash\":\"h\",\"edits\":[{\"key\":\"ALFRED_MEMORY\",\"value\":\"3g\"}]}";

    @BeforeEach
    void realAccessRule() {
        when(editAccess.access(anyString(), any())).thenAnswer(inv -> AccessRule.parse("local")
                .decide(inv.getArgument(0), inv.getArgument(1), Set.of(), RuntimeMode.NATIVE));
        when(save.save(any(), any(), anyString())).thenReturn(new SaveSettingsUseCase.Saved("h2", List.of(), 1));
    }

    @Test
    void settingsAreReadableAndSecretsHaveNoValue() throws Exception {
        var secret = SettingCatalog.find("WEBHOOK_SECRET").orElseThrow();
        var memory = SettingCatalog.find("ALFRED_MEMORY").orElseThrow();
        when(getSettings.settings()).thenReturn(new GetSettingsUseCase.SettingsView(RuntimeMode.NATIVE, "/opt/alfred/.env", "h",
                List.of(new SettingValue(memory, "2g", true, Source.DEFAULT, "2g", false, null),
                        new SettingValue(secret, null, true, Source.ENV_FILE, null, true, null)),
                List.of("ALFRED_MEMORY"), List.of(), List.of()));

        mvc.perform(get("/server/settings").header("Cf-Ray", "x"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.envHash").value("h"))
                .andExpect(jsonPath("$.settings[0].key").value("ALFRED_MEMORY"))
                .andExpect(jsonPath("$.settings[0].applies").value("RESTART"))
                .andExpect(jsonPath("$.settings[1].value").doesNotExist())
                .andExpect(jsonPath("$.settings[1].isSet").value(true))
                .andExpect(jsonPath("$.missingFromEnv[0]").value("ALFRED_MEMORY"));
    }

    @Test
    void aWriteThroughTheTunnelIsRefusedEvenFromLoopback() throws Exception {
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY)
                        .header("CF-Connecting-IP", "203.0.113.9").with(r -> { r.setRemoteAddr("127.0.0.1"); return r; }))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.reason").value("TUNNEL"))
                .andExpect(jsonPath("$.howToEdit").exists());
        verify(save, never()).save(any(), any(), anyString());
    }

    @Test
    void aWriteFromAnAddressNotListedIsRefused() throws Exception {
        mvc.perform(post("/server/settings/add-missing").with(r -> { r.setRemoteAddr("192.168.1.23"); return r; }))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.reason").value("NOT_LISTED"));
    }

    @Test
    void aLocalWriteIsSavedAndTheCliUserIsRecordedOnlyFromLoopback() throws Exception {
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY)
                        .header("X-Alfred-Cli-User", "fathy").with(r -> { r.setRemoteAddr("127.0.0.1"); return r; }))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.envHash").value("h2"));
        verify(save).save(any(), eq(HistoryEntry.HistorySource.CLI), eq("fathy"));
    }

    @Test
    void validationFailuresAre422AndConflictsAre409() throws Exception {
        when(save.save(any(), any(), anyString())).thenThrow(new SaveSettingsUseCase.SettingsRefusedException(
                List.of(ValidationResult.error("ALFRED_MEMORY", "use e.g. 2g or 1536m"))));
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.results[0].message").value("use e.g. 2g or 1536m"));

        org.mockito.Mockito.doThrow(new SaveSettingsUseCase.SettingsConflictException(List.of("ALFRED_MEMORY"), "h9"))
                .when(save).save(any(), any(), anyString());
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.conflict.changedKeys[0]").value("ALFRED_MEMORY"));
    }

    @Test
    void tooManyEditsAreRefusedBeforeAnythingRuns() throws Exception {
        StringBuilder edits = new StringBuilder();
        for (int i = 0; i < 65; i++) {
            edits.append(i == 0 ? "" : ",").append("{\"key\":\"ALFRED_MEMORY\",\"value\":\"2g\"}");
        }
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content("{\"edits\":[" + edits + "]}"))
                .andExpect(status().isBadRequest());
        verify(save, never()).save(any(), any(), anyString());
    }

    @Test
    void accessTellsTheUiWhetherToRenderReadOnly() throws Exception {
        mvc.perform(get("/server/access").with(r -> { r.setRemoteAddr("10.0.0.5"); return r; }))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.allowed").value(false))
                .andExpect(jsonPath("$.reason").value(EditAccess.Reason.NOT_LISTED.name()));
    }
}
