package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fathy.alfred.backend.relive.adapter.in.web.dto.FinishRunRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.HoldRunRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.ResumeRunRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.RunDetailDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.SetRunVariableRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.StartRunRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.StepDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.StepResultPairDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.UpdateRunDefinitionRequestDto;
import com.fathy.alfred.backend.relive.application.port.in.CycleValidationException;
import com.fathy.alfred.backend.relive.application.port.in.FinishRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.HoldRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RecordStepResultUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ResumeRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RunBlockedException;
import com.fathy.alfred.backend.relive.application.port.in.RunDefinitionConflictException;
import com.fathy.alfred.backend.relive.application.port.in.RunLeaseHeldException;
import com.fathy.alfred.backend.relive.application.port.in.RunNotResumableException;
import com.fathy.alfred.backend.relive.application.port.in.SetRunVariableUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StartRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StopRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UpdateRunDefinitionUseCase;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveLimits;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** REST surface for the run engine (contracts/rest-api.md "Runs" - excluding live-calls/
 *  use-as-recording, which are US7's own T073 LiveCallsController, not built yet). */
@RestController
@RequestMapping("/relive-cycles")
public class ReliveRunsController {

    private final StartRunUseCase startRun;
    private final RecordStepResultUseCase recordStepResult;
    private final StopRunUseCase stopRun;
    private final FinishRunUseCase finishRun;
    private final HoldRunUseCase holdRun;
    private final ResumeRunUseCase resumeRun;
    private final UpdateRunDefinitionUseCase updateRunDefinition;
    private final ListRunsUseCase listRuns;
    private final GetRunUseCase getRun;
    private final SetRunVariableUseCase setRunVariable;
    private final ManageReliveCyclesUseCase manageCycles;

    public ReliveRunsController(StartRunUseCase startRun, RecordStepResultUseCase recordStepResult,
                                StopRunUseCase stopRun, FinishRunUseCase finishRun, HoldRunUseCase holdRun,
                                ResumeRunUseCase resumeRun, UpdateRunDefinitionUseCase updateRunDefinition,
                                ListRunsUseCase listRuns, GetRunUseCase getRun, SetRunVariableUseCase setRunVariable,
                                ManageReliveCyclesUseCase manageCycles) {
        this.startRun = startRun;
        this.recordStepResult = recordStepResult;
        this.stopRun = stopRun;
        this.finishRun = finishRun;
        this.holdRun = holdRun;
        this.resumeRun = resumeRun;
        this.updateRunDefinition = updateRunDefinition;
        this.listRuns = listRuns;
        this.getRun = getRun;
        this.setRunVariable = setRunVariable;
        this.manageCycles = manageCycles;
    }

    @PostMapping("/{id}/runs")
    public ResponseEntity<?> start(@PathVariable String id, @RequestBody(required = false) StartRunRequestDto request) {
        StartRunRequestDto body = request == null ? StartRunRequestDto.empty() : request;
        try {
            Run run = startRun.start(id, body.toCommand());
            return ResponseEntity.status(HttpStatus.CREATED).body(run);
        } catch (RunBlockedException e) {
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(e.findings());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @GetMapping("/{id}/runs")
    public List<Run> list(@PathVariable String id, @RequestParam(required = false, defaultValue = "50") int limit) {
        return listRuns.list(id, Math.min(Math.max(limit, 0), ReliveLimits.MAX_LIST_LIMIT));
    }

    @GetMapping("/{id}/runs/{runId}")
    public ResponseEntity<RunDetailDto> get(@PathVariable String id, @PathVariable String runId) {
        return getRun.get(runId)
                .map(detail -> new RunDetailDto(detail.run(), detail.stepResults(), secretsOf(detail.run())))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Small boundary read so the next step sees variables captured by proxy rules. */
    @GetMapping("/{id}/runs/{runId}/variables")
    public ResponseEntity<Map<String, String>> variables(@PathVariable String id, @PathVariable String runId) {
        return getRun.get(runId).map(detail -> {
            Map<String, String> values = new LinkedHashMap<>();
            detail.run().definition().variables().forEach(variable -> values.put(variable.name(), variable.value()));
            detail.run().variableTimeline().forEach(change -> values.put(change.name(), change.value()));
            return ResponseEntity.ok(values);
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Every cycle variable flagged secret, by name (contracts/rest-api.md masking note) - the
     *  frontend is the one that actually masks values wherever it shows them. */
    private static List<String> secretsOf(Run run) {
        return run.definition().variables().stream().filter(CycleVariable::secret).map(CycleVariable::name).toList();
    }

    @PutMapping("/{id}/runs/{runId}/steps/{stepKey}/attempts/{attempt}")
    public ResponseEntity<Void> recordStepResult(@PathVariable String id, @PathVariable String runId,
                                                  @PathVariable String stepKey, @PathVariable int attempt,
                                                  @RequestBody StepResult body) {
        try {
            recordStepResult.recordStepResult(runId, body);
            return ResponseEntity.ok().build();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/runs/{runId}/variables")
    public ResponseEntity<Void> setVariable(@PathVariable String id, @PathVariable String runId,
                                             @Valid @RequestBody SetRunVariableRequestDto request) {
        try {
            setRunVariable.setVariable(runId, request.name(), request.value(), request.stepKey());
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/runs/{runId}/stop")
    public ResponseEntity<Run> stop(@PathVariable String id, @PathVariable String runId) {
        try {
            return ResponseEntity.ok(stopRun.stop(runId));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/runs/{runId}/finish")
    public ResponseEntity<Run> finish(@PathVariable String id, @PathVariable String runId,
                                       @Valid @RequestBody FinishRunRequestDto request) {
        try {
            return ResponseEntity.ok(finishRun.finish(runId, RunStatus.valueOf(request.status())));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PutMapping("/{id}/runs/{runId}/hold")
    public ResponseEntity<Run> hold(@PathVariable String id, @PathVariable String runId,
                                     @RequestBody(required = false) HoldRunRequestDto request) {
        HoldRunRequestDto body = request == null ? new HoldRunRequestDto(null, null) : request;
        try {
            return ResponseEntity.ok(holdRun.hold(runId, body.stepKey(), body.reason()));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/runs/{runId}/resume")
    public ResponseEntity<Run> resume(@PathVariable String id, @PathVariable String runId,
                                       @RequestBody(required = false) ResumeRunRequestDto request) {
        try {
            return ResponseEntity.ok(resumeRun.resume(runId, request == null ? null : request.afterStepKey()));
        } catch (RunNotResumableException | RunLeaseHeldException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PutMapping("/{id}/runs/{runId}/definition")
    public ResponseEntity<Run> updateDefinition(@PathVariable String id, @PathVariable String runId,
                                                 @Valid @RequestBody UpdateRunDefinitionRequestDto request) {
        try {
            ReliveCycle definition = request.definition().toDomain(id);
            return ResponseEntity.ok(updateRunDefinition.updateDefinition(runId, definition, request.reason()));
        } catch (RunDefinitionConflictException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/runs/{runId}/steps/{stepKey}/save-edits")
    public ResponseEntity<ReliveCycle> saveEdits(@PathVariable String id, @PathVariable String runId,
                                                  @PathVariable String stepKey, @Valid @RequestBody StepDto request) {
        ReliveCycle existing = manageCycles.get(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Cycle " + id + " does not exist"));
        Step edited = request.toDomain();
        List<Step> steps = existing.steps().stream().map(s -> s.key().equals(stepKey) ? edited : s).toList();
        ReliveCycle updated = new ReliveCycle(existing.id(), existing.name(), existing.description(), steps,
                existing.variables(), existing.cycleRules(), existing.globalRules(), existing.settings(),
                existing.noise(), existing.unexpectedCalls(), existing.createdAt(), existing.updatedAt(),
                existing.isTransient(), existing.lastRun());
        try {
            String reason = "Edits from run " + runId + ", step " + stepKey;
            return ResponseEntity.ok(manageCycles.update(id, updated, null, reason));
        } catch (CycleValidationException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }

    @GetMapping("/{id}/runs/{a}/compare/{b}")
    public List<StepResultPairDto> compare(@PathVariable String id, @PathVariable String a, @PathVariable String b) {
        Map<String, StepResult> resultsA = latestByStepKey(getRun.get(a));
        Map<String, StepResult> resultsB = latestByStepKey(getRun.get(b));
        Set<String> stepKeys = new LinkedHashSet<>();
        stepKeys.addAll(resultsA.keySet());
        stepKeys.addAll(resultsB.keySet());
        return stepKeys.stream().map(k -> new StepResultPairDto(k, resultsA.get(k), resultsB.get(k))).toList();
    }

    private Map<String, StepResult> latestByStepKey(java.util.Optional<GetRunUseCase.RunDetail> detail) {
        Map<String, StepResult> latest = new LinkedHashMap<>();
        detail.map(GetRunUseCase.RunDetail::stepResults).orElse(List.of())
                .forEach(r -> latest.merge(r.stepKey(), r, (x, y) -> y.attempt() >= x.attempt() ? y : x));
        return latest;
    }
}
