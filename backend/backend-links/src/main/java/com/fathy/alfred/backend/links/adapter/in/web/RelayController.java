package com.fathy.alfred.backend.links.adapter.in.web;

import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * GET /links/r/{slug}/&lt;the owner's own path&gt; - a page showing a whole streamed board or cycle (opened "as" the owner)
 * reads everything through here: the path and query go to the owner as they are, the answer comes back as it is (no ids
 * rewritten - the page knows where it is). Reads only: the owner answers nothing else through a stream.
 */
@RestController
public class RelayController {

    static final String PREFIX = "/links/r/";

    private final RelayUseCase relay;

    public RelayController(RelayUseCase relay) {
        this.relay = relay;
    }

    @GetMapping(PREFIX + "{slug}/**")
    public void relay(@PathVariable String slug, HttpServletRequest request, HttpServletResponse response) throws IOException {
        String uri = request.getRequestURI().substring(request.getContextPath().length());
        String rest = uri.substring((PREFIX + slug).length());
        if (rest.isEmpty()) {
            rest = "/";
        }
        Map<String, String> headers = new LinkedHashMap<>();
        String accept = request.getHeader("Accept");
        headers.put("Accept", accept == null ? "application/json" : accept);
        RelayRequest r = new RelayRequest("GET", rest, request.getQueryString(), headers, null, List.of());
        RelayPipe.pipe(relay, slug, r, response, null);
    }

    /** Anything but a read is refused here: writes from a reader are requests (D10). */
    @RequestMapping(value = PREFIX + "{slug}/**", method = {RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE})
    public void write(@PathVariable String slug, HttpServletResponse response) throws IOException {
        RelayPipe.unavailable(response, "READ_ONLY", "A stream answers reads only - ask the owner with a request", slug);
    }
}
