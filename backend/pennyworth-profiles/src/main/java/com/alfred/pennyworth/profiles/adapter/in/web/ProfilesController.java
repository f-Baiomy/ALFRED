package com.alfred.pennyworth.profiles.adapter.in.web;

import com.alfred.pennyworth.profiles.adapter.in.web.dto.CreateProfileRequestDto;
import com.alfred.pennyworth.profiles.adapter.in.web.dto.UpdateProfileRequestDto;
import com.alfred.pennyworth.profiles.application.port.in.CreateProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.DeleteProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.GetProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.ListProfilesUseCase;
import com.alfred.pennyworth.profiles.application.port.in.UpdateProfileUseCase;
import com.alfred.pennyworth.profiles.domain.model.NewProfile;
import com.alfred.pennyworth.profiles.domain.model.Profile;
import com.alfred.pennyworth.profiles.domain.model.ProfileUpdate;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/profiles")
public class ProfilesController {

    private final ListProfilesUseCase listProfilesUseCase;
    private final GetProfileUseCase getProfileUseCase;
    private final CreateProfileUseCase createProfileUseCase;
    private final UpdateProfileUseCase updateProfileUseCase;
    private final DeleteProfileUseCase deleteProfileUseCase;

    public ProfilesController(
            ListProfilesUseCase listProfilesUseCase,
            GetProfileUseCase getProfileUseCase,
            CreateProfileUseCase createProfileUseCase,
            UpdateProfileUseCase updateProfileUseCase,
            DeleteProfileUseCase deleteProfileUseCase
    ) {
        this.listProfilesUseCase = listProfilesUseCase;
        this.getProfileUseCase = getProfileUseCase;
        this.createProfileUseCase = createProfileUseCase;
        this.updateProfileUseCase = updateProfileUseCase;
        this.deleteProfileUseCase = deleteProfileUseCase;
    }

    @GetMapping
    public List<Profile> list() {
        return listProfilesUseCase.listAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<Profile> get(@PathVariable String id) {
        return getProfileUseCase.getById(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public Profile create(@Valid @RequestBody CreateProfileRequestDto request) {
        return createProfileUseCase.create(new NewProfile(request.name(), request.avatar()));
    }

    @PatchMapping("/{id}")
    public ResponseEntity<Profile> update(@PathVariable String id, @RequestBody UpdateProfileRequestDto request) {
        return updateProfileUseCase.update(id, new ProfileUpdate(request.name(), request.avatar()))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        boolean deleted = deleteProfileUseCase.deleteById(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
