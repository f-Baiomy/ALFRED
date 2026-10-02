package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fathy.alfred.backend.relive.adapter.in.web.dto.DuplicateCycleRequestDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.ReliveCycleRequestDto;
import com.fathy.alfred.backend.relive.application.port.in.CycleInUseException;
import com.fathy.alfred.backend.relive.application.port.in.CycleValidationException;
import com.fathy.alfred.backend.relive.application.port.in.ManageCycleVersionsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StaleCycleException;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** REST surface for cycle CRUD and versions (contracts/rest-api.md "Cycles"). */
@RestController
@RequestMapping("/relive-cycles")
public class ReliveCyclesController {

    private final ManageReliveCyclesUseCase manageCycles;
    private final ValidateCycleUseCase validateCycle;
    private final ManageCycleVersionsUseCase manageVersions;

    public ReliveCyclesController(ManageReliveCyclesUseCase manageCycles, ValidateCycleUseCase validateCycle,
                                   ManageCycleVersionsUseCase manageVersions) {
        this.manageCycles = manageCycles;
        this.validateCycle = validateCycle;
        this.manageVersions = manageVersions;
    }

    @GetMapping
    public List<ReliveCycleSummary> list() {
        return manageCycles.list();
    }

    @GetMapping("/{id}")
    public ResponseEntity<ReliveCycle> get(@PathVariable String id) {
        return manageCycles.get(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<ReliveCycle> create(@Valid @RequestBody ReliveCycleRequestDto request,
                                               @RequestParam(name = "transient", required = false, defaultValue = "false") boolean isTransient,
                                               @RequestParam(name = "deferFingerprint", required = false, defaultValue = "false") boolean deferFingerprint) {
        try {
            ReliveCycle created = isTransient
                    ? manageCycles.createTransient(request.toDomain(null), deferFingerprint)
                    : manageCycles.create(request.toDomain(null), deferFingerprint);
            return ResponseEntity.status(HttpStatus.CREATED).body(created);
        } catch (CycleValidationException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/fingerprints")
    public ResponseEntity<ReliveCycle> fingerprint(@PathVariable String id,
                                                    @RequestParam(name = "rebuild", required = false, defaultValue = "false") boolean rebuild) {
        try {
            return ResponseEntity.ok(manageCycles.fingerprint(id, rebuild));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PutMapping("/{id}")
    public ResponseEntity<ReliveCycle> update(@PathVariable String id, @Valid @RequestBody ReliveCycleRequestDto request,
                                               @RequestHeader(value = "If-Match", required = false) String ifMatch,
                                               @RequestParam(required = false) String reason) {
        try {
            ReliveCycle updated = manageCycles.update(id, request.toDomain(id), ifMatch, reason);
            return ResponseEntity.ok(updated);
        } catch (CycleValidationException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (StaleCycleException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/duplicate")
    public ResponseEntity<ReliveCycle> duplicate(@PathVariable String id, @RequestBody(required = false) DuplicateCycleRequestDto request) {
        try {
            ReliveCycle copy = manageCycles.duplicate(id, request == null ? null : request.name());
            return ResponseEntity.status(HttpStatus.CREATED).body(copy);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        try {
            manageCycles.delete(id);
            return ResponseEntity.noContent().build();
        } catch (CycleInUseException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        }
    }

    /** "Save as cycle" for a Relive now quick run (FR-003c). */
    @PostMapping("/{id}/keep")
    public ResponseEntity<ReliveCycle> keep(@PathVariable String id) {
        try {
            return ResponseEntity.ok(manageCycles.keep(id));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    @PostMapping("/{id}/validate")
    public List<ValidationFinding> validate(@PathVariable String id) {
        return validateCycle.validate(id);
    }

    @GetMapping("/{id}/versions")
    public List<CycleVersion> listVersions(@PathVariable String id) {
        return manageVersions.list(id);
    }

    @PostMapping("/{id}/versions/{version}/restore")
    public ResponseEntity<ReliveCycle> restore(@PathVariable String id, @PathVariable int version) {
        try {
            return ResponseEntity.ok(manageVersions.restore(id, version));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }
}
