package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;

@RestController
@RequestMapping("/settings/variables")
public class GlobalVariablesController {
    private final ManageGlobalVariablesUseCase variables;
    public GlobalVariablesController(ManageGlobalVariablesUseCase variables) { this.variables = variables; }

    @GetMapping public Map<String, Object> get() { return variables.get(); }

    @PutMapping public Map<String, Object> put(@RequestBody Map<String, Object> state) {
        try { return variables.save(state); }
        catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }
}
