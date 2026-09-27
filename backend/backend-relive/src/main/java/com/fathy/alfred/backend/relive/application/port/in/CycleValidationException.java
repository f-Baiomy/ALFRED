package com.fathy.alfred.backend.relive.application.port.in;

import java.util.List;

/** The cycle definition failed validation on save (400) - see data-model.md "Validation on save". */
public class CycleValidationException extends RuntimeException {

    private final List<String> problems;

    public CycleValidationException(List<String> problems) {
        super("Invalid cycle definition: " + String.join("; ", problems));
        this.problems = problems;
    }

    public List<String> problems() {
        return problems;
    }
}
