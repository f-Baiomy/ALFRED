package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.platform.web.GlobalExceptionHandler;
import com.fathy.alfred.backend.teamboards.core.adapter.in.web.SavedSearchesController;
import com.fathy.alfred.backend.teamboards.core.adapter.in.web.TeamErrors;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SavedSearchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Regression (found on the Team tab, 2026-10-17): with the platform's catch-all GlobalExceptionHandler in the same
 * context, a refused Team request kept its code and reason - not a bare 500 "Internal server error" (a Cancel after the
 * setup was taken, a search with no token).
 */
@WebMvcTest(SavedSearchesController.class)
@Import({GlobalExceptionHandler.class, TeamErrors.class})
class TeamErrorsWithPlatformHandlerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private SavedSearchesUseCase saved;

    @Test
    void aRefusalKeepsItsCodeAndReason() throws Exception {
        when(saved.delete(any(), anyLong())).thenThrow(TeamException.userOnly("Only the user deletes a saved search"));
        mvc.perform(delete("/teamboards/saved/3"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("USER_ONLY"))
                .andExpect(jsonPath("$.message").value("Only the user deletes a saved search"));
    }
}
