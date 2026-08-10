package com.fathy.alfred.backend.calls.adapter.out.websocket;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/** Wire envelope for the /ws/calls broadcast - the call itself plus which session-cycles (if any) captured it, so a cycle-detail view can filter the same broadcast the dashboard already listens to. */
public record CallEvent(CallRecord call, List<String> capturedByCycleIds) {
}
