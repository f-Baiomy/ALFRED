package com.fathy.alfred.backend.relive.domain.model;

/** One "Continue with the rest" of an ended run (FR-034d) - the run keeps its id. */
public record Resumed(String at, String afterStepKey) {
}
