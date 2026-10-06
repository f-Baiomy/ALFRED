package com.fathy.alfred.backend.triage.domain.model;

import java.util.List;

/** One problem call: its saved mark and every signal it carries, errors first; {@code severity} "error" or "warning". */
public record ProblemCall(CallAttention call, List<Signal> signals, String severity) {
}
