package com.fathy.alfred.backend.calls.adapter.out.websocket;

import com.fathy.alfred.backend.calls.domain.model.CallSummary;

import java.util.List;

/**
 * Wire envelope for the /ws/calls broadcast - the call itself plus which session-cycles (if any)
 * captured it, so a cycle-detail view can filter the same broadcast the dashboard already listens
 * to. Carries a CallSummary, not the full CallRecord - a live push is only ever used to show the
 * new call in a list (same as GET /calls' own response shape) and trigger a refetch; the full
 * request/response is fetched the same lazy way as any other call, via GET /calls/{id}/detail
 * once it's actually expanded.
 */
public record CallEvent(CallSummary call, List<String> capturedByCycleIds) {
}
