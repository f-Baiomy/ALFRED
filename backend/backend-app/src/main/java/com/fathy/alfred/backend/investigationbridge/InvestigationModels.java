package com.fathy.alfred.backend.investigationbridge;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * The shapes of the cross-call investigation endpoints (specs/010-mcp-log-investigation, contracts/investigate-api.md).
 * Every request names a scope - which calls to look at - and every answer says what that scope was.
 */
public final class InvestigationModels {

    private InvestigationModels() {
    }

    public static final int MAX_CYCLES = 50;

    /**
     * live (default): the live inbound calls; cycles: these cycles' calls, with the live ones too when
     * {@code includeLive}; all: the live calls and every cycle's.
     */
    public record ScopeDto(@Pattern(regexp = "live|cycles|all") String kind, @Size(max = MAX_CYCLES) List<@Size(max = 100) String> cycleIds,
                           Boolean includeLive) {

        public static final ScopeDto LIVE = new ScopeDto("live", null, null);

        public String kindOrLive() {
            return kind == null || kind.isBlank() ? "live" : kind;
        }
    }

    /** One call of a resolved scope - what an answer shows of it, and where it is held ("live", "cycle:<name>"). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ScopeCall(String callId, String method, String path, Integer status, String error, String startedAt, Double durationMs,
                            String project, List<String> heldIn) {
    }

    /** A project of the scope whose lines or statements may be missing: LOGS_OFF, NO_AGENT or DB_OFF. */
    public record Unavailable(String project, String why) {
    }

    public record CycleRef(String id, String name) {
    }

    /** What was looked at - in every answer. */
    public record ScopeInfo(String kind, List<CycleRef> cycles, boolean includeLive, int calls, String from, String to) {
    }

    /** The scope resolved to its calls, each once. */
    public record ResolvedScope(Map<String, ScopeCall> calls, ScopeInfo info, List<Unavailable> unavailable) {

        public Collection<String> ids() {
            return calls.keySet();
        }
    }

    // ------------------------------------------------------------------ requests

    public record ProblemCallsRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                      @Size(max = 8) List<String> all, @Size(max = 8) List<String> any, @Size(max = 8) List<String> none,
                                      @Size(max = 20) List<@Size(max = 60) String> dbFlags, @Min(100) @Max(600) Integer minStatus,
                                      @Min(0) Integer offset, @Min(1) @Max(200) Integer limit) {
    }

    public record EndpointsRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                   @Min(1) @Max(200) Integer limit) {
    }

    public record TimelineRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                  @Min(1) @Max(1440) Integer bucketMinutes) {
    }

    public record LogSearchRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                   @Size(max = 500) String text, @Size(max = 200) String pattern, @Size(max = 10) String minLevel,
                                   @Size(max = 300) String logger, @Size(max = 300) String exceptionType, Boolean outside, Long before,
                                   @Min(1) @Max(200) Integer limit) {
    }

    public record LogProblemsRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                     @Size(max = 2) List<@Pattern(regexp = "ERROR|WARN") String> levels, @Size(max = 40) String newSince,
                                     @Min(1) @Max(100) Integer limit) {
    }

    public record LogProblemCallsRequest(@Valid ScopeDto scope, @Size(max = 100) String project, @Size(max = 40) String from, @Size(max = 40) String to,
                                         @Pattern(regexp = "[0-9a-f]{16}") String fingerprint, @Min(0) Integer offset, @Min(1) @Max(200) Integer limit) {
    }
}
