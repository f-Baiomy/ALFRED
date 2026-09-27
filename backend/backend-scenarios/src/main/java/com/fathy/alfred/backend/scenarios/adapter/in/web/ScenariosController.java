package com.fathy.alfred.backend.scenarios.adapter.in.web;

import com.fathy.alfred.backend.scenarios.adapter.in.web.dto.CreateRunRequestDto;
import com.fathy.alfred.backend.scenarios.adapter.in.web.dto.CreateScenarioRequestDto;
import com.fathy.alfred.backend.scenarios.adapter.in.web.dto.UpdateScenarioRequestDto;
import com.fathy.alfred.backend.scenarios.application.port.in.CreateRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.CreateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.DeleteScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListScenariosUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.UpdateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.domain.model.NewRun;
import com.fathy.alfred.backend.scenarios.domain.model.NewScenario;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioUpdate;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/**
 * REST surface for scenarios and their runs (contracts/002-power-features section 3). Bean
 * Validation (name blank/too long) already yields a 400 via GlobalExceptionHandler
 * (backend-platform); a size-limit violation on the opaque definition/results JSON only surfaces
 * once inside the service, as IllegalArgumentException - caught here and translated the same way
 * backend-settings' GlobalVariablesController does for its own domain-level validation.
 */
@RestController
@RequestMapping("/scenarios")
public class ScenariosController {

    private final ListScenariosUseCase listScenariosUseCase;
    private final GetScenarioUseCase getScenarioUseCase;
    private final CreateScenarioUseCase createScenarioUseCase;
    private final UpdateScenarioUseCase updateScenarioUseCase;
    private final DeleteScenarioUseCase deleteScenarioUseCase;
    private final ListRunsUseCase listRunsUseCase;
    private final GetRunUseCase getRunUseCase;
    private final CreateRunUseCase createRunUseCase;

    public ScenariosController(
            ListScenariosUseCase listScenariosUseCase,
            GetScenarioUseCase getScenarioUseCase,
            CreateScenarioUseCase createScenarioUseCase,
            UpdateScenarioUseCase updateScenarioUseCase,
            DeleteScenarioUseCase deleteScenarioUseCase,
            ListRunsUseCase listRunsUseCase,
            GetRunUseCase getRunUseCase,
            CreateRunUseCase createRunUseCase
    ) {
        this.listScenariosUseCase = listScenariosUseCase;
        this.getScenarioUseCase = getScenarioUseCase;
        this.createScenarioUseCase = createScenarioUseCase;
        this.updateScenarioUseCase = updateScenarioUseCase;
        this.deleteScenarioUseCase = deleteScenarioUseCase;
        this.listRunsUseCase = listRunsUseCase;
        this.getRunUseCase = getRunUseCase;
        this.createRunUseCase = createRunUseCase;
    }

    @GetMapping
    public List<ScenarioSummary> list() {
        return listScenariosUseCase.listAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<Scenario> get(@PathVariable String id) {
        return getScenarioUseCase.getById(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<Scenario> create(@Valid @RequestBody CreateScenarioRequestDto request) {
        try {
            Scenario created = createScenarioUseCase.create(new NewScenario(request.name(), request.description(), request.definition()));
            return ResponseEntity.status(HttpStatus.CREATED).body(created);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<Scenario> update(@PathVariable String id, @Valid @RequestBody UpdateScenarioRequestDto request) {
        try {
            return updateScenarioUseCase.update(id, new ScenarioUpdate(request.name(), request.description(), request.definition()))
                    .map(ResponseEntity::ok)
                    .orElseGet(() -> ResponseEntity.notFound().build());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        boolean deleted = deleteScenarioUseCase.deleteById(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @GetMapping("/{id}/runs")
    public ResponseEntity<List<RunListItem>> listRuns(@PathVariable String id) {
        return listRunsUseCase.listRuns(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/{id}/runs/{runId}")
    public ResponseEntity<Run> getRun(@PathVariable String id, @PathVariable String runId) {
        return getRunUseCase.getRun(id, runId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/runs")
    public ResponseEntity<Run> createRun(@PathVariable String id, @Valid @RequestBody CreateRunRequestDto request) {
        try {
            NewRun newRun = new NewRun(request.startedAt(), request.finishedAt(), request.summary(), request.results());
            return createRunUseCase.createRun(id, newRun)
                    .map(run -> ResponseEntity.status(HttpStatus.CREATED).body(run))
                    .orElseGet(() -> ResponseEntity.notFound().build());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }
}
