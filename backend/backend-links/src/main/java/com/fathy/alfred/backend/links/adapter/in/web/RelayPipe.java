package com.fathy.alfred.backend.links.adapter.in.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayInputStream;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.domain.JsonRewriter;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.io.OutputStream;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Streams a relayed read to the browser (R3): the head's status and the few headers that matter, then the body as it
 * arrives - JSON optionally rewritten on the way (ids tagged with the link, R1). A failure before the head is answered as
 * JSON the page can show ({@code OFFLINE}, {@code NOT_STREAMED}…); one after it ends the response early, so the browser
 * sees a broken download and an export says so instead of writing a shorter file (D23).
 */
public final class RelayPipe {

    /** Headers of the owner's answer passed on. Never Set-Cookie or anything about the owner's server. */
    static final Set<String> PASSED = Set.of("content-type", "content-disposition", "x-alfred-total", "x-total-count", "x-alfred-origin",
            "x-alfred-next", "x-alfred-truncated");

    static final Duration WAIT = Duration.ofSeconds(90);
    private static final ObjectMapper JSON = new ObjectMapper();

    private RelayPipe() {
    }

    public static void pipe(RelayUseCase relay, String slug, RelayRequest request, HttpServletResponse response, JsonRewriter.Visitor jsonVisitor)
            throws IOException {
        BlockingResponse answer = new BlockingResponse();
        RelayCall call;
        try {
            call = relay.open(slug, request, answer);
        } catch (LinkUnavailableException e) {
            unavailable(response, e.code(), e.getMessage(), slug);
            return;
        }
        answer.attach(call);
        RelayInputStream in = new RelayInputStream(answer, WAIT);
        int status;
        try {
            status = in.awaitHead();
        } catch (LinkUnavailableException e) {
            unavailable(response, e.code(), e.getMessage(), slug);
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            answer.cancel();
            unavailable(response, "TIMEOUT", "Interrupted", slug);
            return;
        }
        response.setStatus(status);
        String contentType = null;
        for (Map.Entry<String, String> h : in.headers().entrySet()) {
            String k = h.getKey().toLowerCase();
            if (PASSED.contains(k)) {
                response.setHeader(h.getKey(), h.getValue());
                if (k.equals("content-type")) {
                    contentType = h.getValue();
                }
            }
        }
        response.setHeader("X-Alfred-Origin", slug);
        response.setHeader("Cache-Control", "no-store");
        OutputStream out = response.getOutputStream();
        try (in) {
            if (jsonVisitor != null && contentType != null && contentType.toLowerCase().contains("json") && status < 400) {
                JsonRewriter.rewrite(in, out, jsonVisitor);
            } else {
                in.transferTo(out);
            }
            out.flush();
        } catch (IOException e) {
            // the body could not be completed: abort the connection so the reader never takes a short body for a whole one
            answer.cancel();
            throw e;
        }
    }

    public static void unavailable(HttpServletResponse response, String code, String message, String slug) throws IOException {
        if (response.isCommitted()) {
            return;
        }
        int status = switch (code == null ? "" : code) {
            case "UNKNOWN_LINK", "UNLINKED" -> 404;
            case "NOT_STREAMED", "NOT_ALLOWED", "LOOP", "TOO_FAR", "NOT_PASSED_ON" -> 403;
            case "READ_ONLY" -> 405;
            case "TOO_LARGE" -> 413;
            default -> 503;
        };
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        Map<String, String> body = new LinkedHashMap<>();
        body.put("error", code == null ? "OFFLINE" : code);
        body.put("message", message == null ? "" : message);
        body.put("slug", slug == null ? "" : slug);
        response.getWriter().write(JSON.writeValueAsString(body));
    }
}
