package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.adapter.in.web.dto.AddUrlRequestDto;
import com.fathy.alfred.backend.settings.adapter.in.web.dto.SetModeRequestDto;
import com.fathy.alfred.backend.settings.adapter.in.web.dto.ToggleUrlRequestDto;
import com.fathy.alfred.backend.settings.application.port.in.GetCallFilterSettingsUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageBlacklistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageWhitelistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.SetFilterModeUseCase;
import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/settings/call-filtering")
public class CallFilterSettingsController {

    private final GetCallFilterSettingsUseCase getCallFilterSettingsUseCase;
    private final SetFilterModeUseCase setFilterModeUseCase;
    private final ManageWhitelistUseCase manageWhitelistUseCase;
    private final ManageBlacklistUseCase manageBlacklistUseCase;

    public CallFilterSettingsController(
            GetCallFilterSettingsUseCase getCallFilterSettingsUseCase,
            SetFilterModeUseCase setFilterModeUseCase,
            ManageWhitelistUseCase manageWhitelistUseCase,
            ManageBlacklistUseCase manageBlacklistUseCase
    ) {
        this.getCallFilterSettingsUseCase = getCallFilterSettingsUseCase;
        this.setFilterModeUseCase = setFilterModeUseCase;
        this.manageWhitelistUseCase = manageWhitelistUseCase;
        this.manageBlacklistUseCase = manageBlacklistUseCase;
    }

    @GetMapping
    public CallFilterSettings getSettings() {
        return getCallFilterSettingsUseCase.getSettings();
    }

    @PutMapping("/mode")
    public CallFilterSettings setMode(@Valid @RequestBody SetModeRequestDto request) {
        return setFilterModeUseCase.setMode(request.mode());
    }

    @PostMapping("/whitelist")
    public CallFilterSettings addWhitelistUrl(@Valid @RequestBody AddUrlRequestDto request) {
        return manageWhitelistUseCase.addWhitelistUrl(request.host());
    }

    @PatchMapping("/whitelist/{id}")
    public CallFilterSettings toggleWhitelistUrl(@PathVariable String id, @RequestBody ToggleUrlRequestDto request) {
        return manageWhitelistUseCase.toggleWhitelistUrl(id, request.enabled());
    }

    @DeleteMapping("/whitelist/{id}")
    public CallFilterSettings removeWhitelistUrl(@PathVariable String id) {
        return manageWhitelistUseCase.removeWhitelistUrl(id);
    }

    @PostMapping("/blacklist")
    public CallFilterSettings addBlacklistUrl(@Valid @RequestBody AddUrlRequestDto request) {
        return manageBlacklistUseCase.addBlacklistUrl(request.host());
    }

    @DeleteMapping("/blacklist/{id}")
    public CallFilterSettings removeBlacklistUrl(@PathVariable String id) {
        return manageBlacklistUseCase.removeBlacklistUrl(id);
    }
}
