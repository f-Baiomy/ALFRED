package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
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

    /**
     * A proxy reporting a GLOBAL capture ({@code interception.py::_save_global} already wrote the
     * file; this merges the value into the store of record and tells dashboards to refetch).
     * Fire-and-forget from the proxy's side - a failure here must never affect traffic, only
     * liveness of the variables panel, which still converges on its next load via the file.
     */
    @PostMapping("/promoted") public Map<String, Object> promoted(@RequestBody Map<String, Object> body) {
        try { return variables.promote((String) body.get("name"), body.get("value")); }
        catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }
}
