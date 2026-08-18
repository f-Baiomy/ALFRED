package com.fathy.alfred.backend.internalcalls.adapter.out.websocket;

import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;

import java.util.List;

/**
 * Wire envelope for the /ws/internal-calls broadcast - the call itself, plus which session-cycles
 * (if any) captured it. Carries a CallSummary, not the full CallRecord - a live push is only ever
 * used to show the new call in a list and trigger a refetch; the full request/response is fetched
 * the same lazy way as any other call, via GET /internal-calls/{id}/detail once it's actually
 * expanded. {@code capturedByCycleIds} is always empty for a prepare-time event (nothing is ever
 * captured before a call completes in this slice) and lists whichever RECORDING cycles captured
 * the call for a completion event.
 */
public record CallEvent(CallSummary call, List<String> capturedByCycleIds) {
}
