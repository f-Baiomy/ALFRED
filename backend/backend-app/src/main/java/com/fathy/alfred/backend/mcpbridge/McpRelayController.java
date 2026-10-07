package com.fathy.alfred.backend.mcpbridge;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;

/**
 * Claude's tools over HTTP (specs/012-server-program FR-080..082, research R13): {@code /mcp} on the UI port is relayed
 * to the MCP server the supervisor runs on 127.0.0.1, so Claude on another machine reaches Alfred wherever the UI is.
 * The MCP Streamable HTTP transport answers with server-sent events; every chunk is flushed as it arrives so a long
 * tool call streams instead of arriving at the end. Not behind the settings access rule: it is as open as the UI is.
 */
@RestController
public class McpRelayController {

    /** Request bodies above this are refused, as the MCP server itself does. */
    static final long MAX_BODY_BYTES = 10L * 1024 * 1024;

    private static final List<String> REQUEST_HEADERS = List.of("content-type", "accept", "mcp-session-id",
            "mcp-protocol-version", "last-event-id");
    private static final List<String> RESPONSE_HEADERS = List.of("content-type", "mcp-session-id", "mcp-protocol-version",
            "cache-control");

    private final String upstream;
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(3))
            .build();

    public McpRelayController(@Value("${ALFRED_MCP_PORT:3009}") int port) {
        this.upstream = "http://127.0.0.1:" + port + "/mcp";
    }

    @RequestMapping(value = {"/mcp", "/mcp/"}, method = {RequestMethod.GET, RequestMethod.POST, RequestMethod.DELETE})
    public void relay(HttpServletRequest request, HttpServletResponse response) throws IOException {
        if (request.getContentLengthLong() > MAX_BODY_BYTES) {
            error(response, 413, "request body over " + MAX_BODY_BYTES + " bytes");
            return;
        }
        byte[] body = request.getInputStream().readNBytes((int) MAX_BODY_BYTES + 1);
        if (body.length > MAX_BODY_BYTES) {
            error(response, 413, "request body over " + MAX_BODY_BYTES + " bytes");
            return;
        }
        String query = request.getQueryString();
        HttpRequest.Builder forward = HttpRequest.newBuilder(URI.create(upstream + (query == null ? "" : "?" + query)))
                .method(request.getMethod(), body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(body));
        for (String name : REQUEST_HEADERS) {
            String value = request.getHeader(name);
            if (value != null) {
                forward.header(name, value);
            }
        }

        HttpResponse<InputStream> answer;
        try {
            answer = http.send(forward.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            error(response, 502, "Alfred's MCP server is not running here. On a native install 'alfred status' shows it and "
                    + "'alfred restart' starts it; the Docker install has no /mcp - run mcp-server on your machine (docs/mcp.md).");
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            error(response, 502, "interrupted");
            return;
        }

        response.setStatus(answer.statusCode());
        for (String name : RESPONSE_HEADERS) {
            answer.headers().firstValue(name).ifPresent(value -> response.setHeader(name, value));
        }
        boolean events = answer.headers().firstValue("content-type").orElse("").toLowerCase(Locale.ROOT).startsWith("text/event-stream");
        if (events) {
            response.setHeader("X-Accel-Buffering", "no"); // nginx in front (the Docker gateway) must not hold events back
        }
        try (InputStream in = answer.body()) {
            OutputStream out = response.getOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                out.write(buffer, 0, n);
                out.flush();
            }
        }
    }

    private static void error(HttpServletResponse response, int status, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        String json = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"" + message.replace("\"", "'") + "\"},\"id\":null}";
        response.getOutputStream().write(json.getBytes(StandardCharsets.UTF_8));
    }
}
