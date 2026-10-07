package com.fathy.alfred.backend.serverbridge;

import com.fathy.alfred.backend.platform.web.GlobalExceptionHandler;
import com.fathy.alfred.backend.server.adapter.in.web.ServerExceptionHandler;
import com.fathy.alfred.backend.server.adapter.in.web.ServerSettingsController;
import com.fathy.alfred.backend.server.adapter.in.web.ServerWebConfig;
import com.fathy.alfred.backend.server.application.port.in.CheckSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.PreviewSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SettingsHistoryUseCase;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Regression (found by the native install's end-to-end run): with the platform's catch-all GlobalExceptionHandler in
 * the same context, a refused save must stay 422 and a refused write 403 - not become 500.
 */
@WebMvcTest(ServerSettingsController.class)
@Import({GlobalExceptionHandler.class, ServerExceptionHandler.class, ServerWebConfig.class})
class ServerErrorsWithPlatformHandlerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private GetSettingsUseCase get;
    @MockBean
    private PreviewSettingsUseCase preview;
    @MockBean
    private SaveSettingsUseCase save;
    @MockBean
    private EditAccessUseCase editAccess;
    @MockBean
    private CheckSettingsUseCase check;
    @MockBean
    private SettingsHistoryUseCase history;

    private static final String BODY = "{\"edits\":[{\"key\":\"ALFRED_UI_PORT\",\"value\":\"70000\"}]}";

    @Test
    void aRefusedSaveIs422AndATunnelWriteIs403() throws Exception {
        when(editAccess.access(anyString(), any())).thenAnswer(inv -> AccessRule.parse("local")
                .decide(inv.getArgument(0), inv.getArgument(1), Set.of(), RuntimeMode.NATIVE));
        when(save.save(any(), any(), anyString())).thenThrow(new SaveSettingsUseCase.SettingsRefusedException(
                List.of(ValidationResult.error("ALFRED_UI_PORT", "a port is 1-65535"))));

        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnprocessableEntity());
        mvc.perform(put("/server/settings").contentType(MediaType.APPLICATION_JSON).content(BODY).header("Cf-Ray", "x"))
                .andExpect(status().isForbidden());
    }
}
