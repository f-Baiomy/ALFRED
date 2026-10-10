package com.fathy.alfred.backend.triage.application.port.in;

/**
 * Triage's endpoint grouping ({@code POST /api/orders/{n}}) for other features to reuse rather than copy - the task
 * board compares cards by it (specs/014-task-board research R12).
 */
public interface NormalizeEndpointUseCase {

    String endpointOf(String method, String url);
}
