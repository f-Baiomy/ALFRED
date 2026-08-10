package com.fathy.alfred.backend.profiles.adapter.in.web;

import com.fathy.alfred.backend.profiles.application.port.in.CreateProfileUseCase;
import com.fathy.alfred.backend.profiles.application.port.in.DeleteProfileUseCase;
import com.fathy.alfred.backend.profiles.application.port.in.GetProfileUseCase;
import com.fathy.alfred.backend.profiles.application.port.in.ListProfilesUseCase;
import com.fathy.alfred.backend.profiles.application.port.in.UpdateProfileUseCase;
import com.fathy.alfred.backend.profiles.domain.model.Profile;
import com.fathy.alfred.backend.profiles.domain.model.ProfileUpdate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ProfilesController.class)
class ProfilesControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ListProfilesUseCase listProfilesUseCase;
    @MockBean
    private GetProfileUseCase getProfileUseCase;
    @MockBean
    private CreateProfileUseCase createProfileUseCase;
    @MockBean
    private UpdateProfileUseCase updateProfileUseCase;
    @MockBean
    private DeleteProfileUseCase deleteProfileUseCase;

    private static Profile profile(String id) {
        return new Profile(id, "Ada", "2026-01-01T00:00:00Z", "🦊");
    }

    @Test
    void rejectsAProfileWithABlankName() throws Exception {
        mockMvc.perform(post("/profiles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"","avatar":"🦊"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void acceptsAValidProfileAndDelegatesToTheUseCase() throws Exception {
        when(createProfileUseCase.create(any())).thenReturn(profile("p1"));

        mockMvc.perform(post("/profiles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Ada","avatar":"🦊"}
                                """))
                .andExpect(status().isOk());

        verify(createProfileUseCase).create(any());
    }

    @Test
    void returnsNotFoundWhenGettingAMissingProfile() throws Exception {
        when(getProfileUseCase.getById(eq("missing"))).thenReturn(Optional.empty());

        mockMvc.perform(get("/profiles/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsOkWhenGettingAnExistingProfile() throws Exception {
        when(getProfileUseCase.getById(eq("p1"))).thenReturn(Optional.of(profile("p1")));

        mockMvc.perform(get("/profiles/p1"))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenUpdatingAMissingProfile() throws Exception {
        when(updateProfileUseCase.update(eq("missing"), any(ProfileUpdate.class))).thenReturn(Optional.empty());

        mockMvc.perform(patch("/profiles/missing")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"New name"}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsOkWhenUpdatingAnExistingProfile() throws Exception {
        when(updateProfileUseCase.update(eq("p1"), any(ProfileUpdate.class))).thenReturn(Optional.of(profile("p1")));

        mockMvc.perform(patch("/profiles/p1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"New name"}
                                """))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenDeletingAMissingProfile() throws Exception {
        when(deleteProfileUseCase.deleteById(eq("missing"))).thenReturn(false);

        mockMvc.perform(delete("/profiles/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsNoContentWhenDeletingAnExistingProfile() throws Exception {
        when(deleteProfileUseCase.deleteById(eq("p1"))).thenReturn(true);

        mockMvc.perform(delete("/profiles/p1"))
                .andExpect(status().isNoContent());
    }
}
