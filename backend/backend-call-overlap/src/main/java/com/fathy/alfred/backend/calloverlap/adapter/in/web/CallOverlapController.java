package com.fathy.alfred.backend.calloverlap.adapter.in.web;

import com.fathy.alfred.backend.calloverlap.application.port.in.GetCallOverlapsUseCase;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapQuery;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;

@RestController
public class CallOverlapController {

    private final GetCallOverlapsUseCase getCallOverlapsUseCase;

    public CallOverlapController(GetCallOverlapsUseCase getCallOverlapsUseCase) {
        this.getCallOverlapsUseCase = getCallOverlapsUseCase;
    }

    /**
     * Windowed+filtered "what calls (external + internal) happened in this time range" - built for
     * the frontend's own containment/nesting check, not for browsing/pagination (GET /calls and
     * GET /internal-calls already cover that). {@code from}/{@code to} are required ISO-8601
     * instants; every other param is optional and blank/absent means "no filter", same convention
     * as GET /calls and GET /internal-calls.
     */
    @GetMapping("/call-overlaps")
    public List<CallOverlapEntry> listOverlaps(
            @RequestParam String from,
            @RequestParam String to,
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "") String serviceNames,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId
    ) {
        Instant fromInstant = parseInstant("from", from);
        Instant toInstant = parseInstant("to", to);
        return getCallOverlapsUseCase.getOverlaps(new CallOverlapQuery(
                fromInstant, toInstant, search, supplier, serviceNames, sessionId, operationId, requestId));
    }

    /** Accepts both Java's Instant.toString() format (trailing "Z") and an OffsetDateTime-shaped offset, same fallback CallListSupport's own timestamp parsing uses elsewhere. */
    private static Instant parseInstant(String paramName, String value) {
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            try {
                return OffsetDateTime.parse(value).toInstant();
            } catch (DateTimeParseException e2) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid " + paramName + " - expected an ISO-8601 timestamp");
            }
        }
    }
}
