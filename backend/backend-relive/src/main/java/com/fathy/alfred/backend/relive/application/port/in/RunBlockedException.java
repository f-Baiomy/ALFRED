package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;

import java.util.List;

/** Start refused because pre-run validation (FR-017) found a BLOCK finding (422). */
public class RunBlockedException extends RuntimeException {

    private final List<ValidationFinding> findings;

    public RunBlockedException(List<ValidationFinding> findings) {
        super("Cannot start run: " + findings.size() + " blocking finding(s)");
        this.findings = findings;
    }

    public List<ValidationFinding> findings() {
        return findings;
    }
}
