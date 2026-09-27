package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;
import java.util.function.Supplier;

/** Global variables API - contracts.md section 1 (B3 variables by source, C2 environments, D6 secret variables). */
@RestController
@RequestMapping("/settings/variables")
public class GlobalVariablesController {
    private final ManageGlobalVariablesUseCase variables;
    public GlobalVariablesController(ManageGlobalVariablesUseCase variables) { this.variables = variables; }

    @GetMapping public Map<String, Object> get() { return variables.get(); }

    @PutMapping public Map<String, Object> put(@RequestBody Map<String, Object> state) {
        return guarded(() -> variables.save(state));
    }

    /**
     * Per-name upsert (UI edit of one variable) in the active environment, so the dashboard stops
     * PUTting a whole stale copy of the state back and racing another tab's/the proxy's concurrent
     * write. Body is {@code {"value": "<text>"}}.
     */
    @PutMapping("/{name}") public Map<String, Object> upsert(@PathVariable String name, @RequestBody(required = false) Map<String, Object> body) {
        return guarded(() -> {
            Object rawValue = body == null ? null : body.get("value");
            if (!(rawValue instanceof String value)) {
                throw new IllegalArgumentException("A JSON body with a text \"value\" is required.");
            }
            return variables.upsert(name, value);
        });
    }

    /**
     * Per-name delete (UI delete of one variable) from the active environment. {@code ?fallback=<text>}
     * sets a replacement fallback; omitted clears it. The name's {@code updatedAt} entry (tombstone) stays either way.
     */
    @DeleteMapping("/{name}") public Map<String, Object> remove(@PathVariable String name,
            @RequestParam(name = "fallback", required = false) String fallback) {
        return guarded(() -> variables.remove(name, fallback));
    }

    /**
     * A proxy reporting a GLOBAL capture ({@code interception.py::_save_global} already wrote the
     * file; this merges the value into the store of record and tells dashboards to refetch).
     * Fire-and-forget from the proxy's side - a failure here must never affect traffic, only
     * liveness of the variables panel, which still converges on its next load via the file.
     * Body is {@code {name, value, ruleId?, ruleName?}} - the last two make the source CAPTURE.
     */
    @PostMapping("/promoted") public Map<String, Object> promoted(@RequestBody Map<String, Object> body) {
        Object rawName = body.get("name");
        if (!(rawName instanceof String name)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "name must be text");
        }
        String ruleId = body.get("ruleId") instanceof String s ? s : null;
        String ruleName = body.get("ruleName") instanceof String s ? s : null;
        return guarded(() -> variables.promote(name, body.get("value"), ruleId, ruleName));
    }

    /** Marks (or unmarks) a name as secret - {@code {"secret": boolean}}. The name need not exist yet. */
    @PutMapping("/{name}/secret") public Map<String, Object> setSecret(@PathVariable String name, @RequestBody Map<String, Object> body) {
        return guarded(() -> {
            Object raw = body == null ? null : body.get("secret");
            if (!(raw instanceof Boolean secret)) {
                throw new IllegalArgumentException("A JSON body with a boolean \"secret\" is required.");
            }
            return variables.setSecret(name, secret);
        });
    }

    /** Creates a new environment - {@code {name, copyFrom?}}. Never activates it. */
    @PostMapping("/environments") public Map<String, Object> createEnvironment(@RequestBody Map<String, Object> body) {
        return guarded(() -> {
            Object rawName = body == null ? null : body.get("name");
            String copyFrom = body != null && body.get("copyFrom") instanceof String s ? s : null;
            if (!(rawName instanceof String name)) {
                throw new IllegalArgumentException("A JSON body with a text \"name\" is required.");
            }
            return variables.createEnvironment(name, copyFrom);
        });
    }

    /** Switches the active environment - {@code {name}} - and republishes {@code variables.json}. */
    @PutMapping("/environments/active") public Map<String, Object> activateEnvironment(@RequestBody Map<String, Object> body) {
        return guarded(() -> {
            Object rawName = body == null ? null : body.get("name");
            if (!(rawName instanceof String name)) {
                throw new IllegalArgumentException("A JSON body with a text \"name\" is required.");
            }
            return variables.activateEnvironment(name);
        });
    }

    /** 400 if {@code name} is the active environment, or the last one left. */
    @DeleteMapping("/environments/{name}") public Map<String, Object> deleteEnvironment(@PathVariable String name) {
        return guarded(() -> variables.deleteEnvironment(name));
    }

    /** {@code {name, variables, fallbacks}} for one environment. */
    @GetMapping("/environments/{name}/export") public Map<String, Object> exportEnvironment(@PathVariable String name) {
        return guarded(() -> variables.exportEnvironment(name));
    }

    /**
     * Imports variables into an environment (created if absent) - {@code {environment, variables,
     * fallbacks?, mode: "MERGE"|"REPLACE"}}. Imported names get source IMPORT.
     */
    @PostMapping("/import") public Map<String, Object> importEnvironment(@RequestBody Map<String, Object> body) {
        return guarded(() -> {
            Object rawEnvironment = body == null ? null : body.get("environment");
            if (!(rawEnvironment instanceof String environment)) {
                throw new IllegalArgumentException("A JSON body with a text \"environment\" is required.");
            }
            Object mode = body.get("mode");
            return variables.importEnvironment(environment, body.get("variables"), body.get("fallbacks"),
                    mode instanceof String s ? s : null);
        });
    }

    private static <T> T guarded(Supplier<T> action) {
        try {
            return action.get();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }
}
