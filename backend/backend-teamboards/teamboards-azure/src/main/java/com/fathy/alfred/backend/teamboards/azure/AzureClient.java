package com.fathy.alfred.backend.teamboards.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderException.Kind;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;

/**
 * Azure DevOps REST over the JDK client (research R9): basic auth with the PAT, connect 5 s / request 30 s, one retry
 * after {@code Retry-After} on 429/503, 401/403 as TOKEN_REJECTED. Never logs or rethrows a body or the token.
 */
class AzureClient {

    static final String API = "api-version=7.1";
    private static final int MAX_RETRY_WAIT_SECONDS = 10;

    private final HttpClient http;
    private final ObjectMapper json = new ObjectMapper();
    /** Sleeps between a 429 and its one retry; tests replace it. */
    java.util.function.LongConsumer sleeper = ms -> {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    };

    AzureClient() {
        this(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build());
    }

    AzureClient(HttpClient http) {
        this.http = http;
    }

    private static String auth(Token t) {
        return "Basic " + Base64.getEncoder().encodeToString((":" + t.value()).getBytes(StandardCharsets.UTF_8));
    }

    JsonNode get(URI uri, Token t) throws ProviderException {
        return send(HttpRequest.newBuilder(uri).GET(), t);
    }

    JsonNode post(URI uri, Token t, Object body) throws ProviderException {
        String text;
        try {
            text = json.writeValueAsString(body);
        } catch (IOException e) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Could not write the request");
        }
        return send(HttpRequest.newBuilder(uri).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(text)), t);
    }

    /** A JSON-Patch (work item updates and creates). */
    JsonNode patch(URI uri, Token t, Object ops) throws ProviderException {
        return sendJson(uri, t, "PATCH", "application/json-patch+json", ops);
    }

    /** A JSON-Patch POST (create a work item of a type). */
    JsonNode postPatch(URI uri, Token t, Object ops) throws ProviderException {
        return sendJson(uri, t, "POST", "application/json-patch+json", ops);
    }

    private JsonNode sendJson(URI uri, Token t, String method, String type, Object body) throws ProviderException {
        String text;
        try {
            text = json.writeValueAsString(body);
        } catch (IOException e) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Could not write the request");
        }
        return send(HttpRequest.newBuilder(uri).header("Content-Type", type).method(method, HttpRequest.BodyPublishers.ofString(text)), t);
    }

    /** Raw bytes (an attachment upload). */
    JsonNode postBytes(URI uri, Token t, byte[] data) throws ProviderException {
        return send(HttpRequest.newBuilder(uri).header("Content-Type", "application/octet-stream").POST(HttpRequest.BodyPublishers.ofByteArray(data)), t);
    }

    private JsonNode send(HttpRequest.Builder b, Token t) throws ProviderException {
        HttpRequest request = b.timeout(Duration.ofSeconds(60)).header("Authorization", auth(t)).header("Accept", "application/json").build();
        for (int attempt = 0; ; attempt++) {
            HttpResponse<InputStream> r = exchange(request);
            int status = r.statusCode();
            try (InputStream in = r.body()) {
                if (status == 429 || status == 503) {
                    int wait = retryAfter(r);
                    if (attempt == 0 && wait <= MAX_RETRY_WAIT_SECONDS) {
                        sleeper.accept(wait * 1000L);
                        continue;
                    }
                    throw new ProviderException(Kind.BUSY, "Azure DevOps asks to wait " + wait + " s", wait);
                }
                if (status == 400 || status == 409 || status >= 500) {
                    throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps answered " + status + " to " + call(request.uri())
                            + reason(in));
                }
                check(status, request.uri());
                JsonNode n = json.readTree(in);
                return n == null ? json.missingNode() : n;
            } catch (IOException e) {
                throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps sent an answer that is not JSON");
            }
        }
    }

    /** Downloads at most {@code max} bytes; null when the file is bigger. */
    /**
     * Downloads an attachment. The token goes only to the URL given (the caller checks its host); a redirect (Azure sends
     * large files to blob storage with a signed link) is followed once WITHOUT the token, so it never leaves the org.
     */
    byte[] download(URI uri, Token t, long max) throws ProviderException {
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).header("Authorization", auth(t)).GET().build();
        HttpResponse<InputStream> r = exchange(request);
        int status = r.statusCode();
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            String to = r.headers().firstValue("location").orElse(null);
            close(r);
            if (to == null) {
                throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps redirected the download nowhere");
            }
            URI next;
            try {
                next = uri.resolve(to);
            } catch (IllegalArgumentException e) {
                throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps redirected the download to a bad link");
            }
            if (!"https".equalsIgnoreCase(next.getScheme()) && !"localhost".equalsIgnoreCase(next.getHost())) {
                throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps redirected the download off https");
            }
            r = exchange(HttpRequest.newBuilder(next).timeout(Duration.ofSeconds(30)).GET().build());
            if (r.statusCode() == 401 || r.statusCode() == 403) {
                close(r);
                throw new ProviderException(Kind.BAD_RESPONSE, "The attachment's storage refused the download (" + r.statusCode() + ")");
            }
        }
        try (InputStream in = r.body()) {
            check(r.statusCode(), uri);
            byte[] data = in.readNBytes((int) Math.min(Integer.MAX_VALUE - 8, max + 1));
            return data.length > max ? null : data;
        } catch (IOException e) {
            throw new ProviderException(Kind.UNREACHABLE, "The download stopped");
        }
    }

    private static void close(HttpResponse<InputStream> r) {
        try {
            r.body().close();
        } catch (IOException e) {
            // nothing to read from it
        }
    }

    /**
     * What Alfred may send besides reads (specs/038 G-3): work-item reads that are POSTs (search, WIQL, batch), creating
     * and editing work items, their comments and attachments. Never a DELETE or PUT, never a process, project, area,
     * iteration, team, permission or service-hook write - refused here before anything leaves Alfred.
     */
    private static final java.util.List<java.util.regex.Pattern> WRITES = java.util.stream.Stream.of(
            "POST .*/_apis/search/workitemsearch(results)?",
            "POST .*/_apis/wit/wiql",
            "POST .*/_apis/wit/workitemsbatch",
            "POST .*/_apis/wit/workitems/\\$[^/]+",
            "POST .*/_apis/wit/workitems/\\d+/comments",
            "POST .*/_apis/wit/attachments",
            "PATCH .*/_apis/wit/workitems/\\d+").map(p -> java.util.regex.Pattern.compile(p, java.util.regex.Pattern.CASE_INSENSITIVE)).toList();

    static void allowed(String method, URI uri) throws ProviderException {
        if ("GET".equalsIgnoreCase(method)) {
            return;
        }
        String line = method.toUpperCase(java.util.Locale.ROOT) + " " + (uri.getRawPath() == null ? "" : uri.getRawPath().replace("%24", "$"));
        if (WRITES.stream().noneMatch(p -> p.matcher(line).matches())) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Alfred never sends " + method.toUpperCase(java.util.Locale.ROOT) + " " + call(uri)
                    + " to Azure DevOps - it only creates and edits work items, their comments and attachments");
        }
    }

    private HttpResponse<InputStream> exchange(HttpRequest request) throws ProviderException {
        allowed(request.method(), request.uri());
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new ProviderException(Kind.UNREACHABLE, "Azure DevOps is not reachable at " + request.uri().getHost());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ProviderException(Kind.UNREACHABLE, "Interrupted");
        }
    }

    /** The call in a few words ("wiql", "workitemsbatch", "teams"): the last word of the path. */
    static String call(URI uri) {
        String path = uri.getPath() == null ? "" : uri.getPath();
        String last = path.substring(path.lastIndexOf('/') + 1);
        return last.isEmpty() ? "the request" : last;
    }

    /**
     * Azure's own words for a refused request ({@code {"message": "TF51005: ..."}}): what a 400 means is in them. Only the
     * message, flattened and capped - never the request, so never the token.
     */
    String reason(InputStream in) {
        try {
            byte[] head = in.readNBytes(16 * 1024);
            String message = json.readTree(head).path("message").asText("").replaceAll("\\s+", " ").strip();
            if (message.isEmpty()) {
                return "";
            }
            return ": " + (message.length() > 300 ? message.substring(0, 299) + "…" : message);
        } catch (IOException | RuntimeException e) {
            return "";
        }
    }

    private static void check(int status, URI uri) throws ProviderException {
        if (status == 401 || status == 203) { // 203: Azure's sign-in page for a bad token
            throw new ProviderException(Kind.TOKEN_REJECTED, "Azure DevOps refused the token");
        }
        if (status >= 300 && status < 400) { // an API call sent to the sign-in page: a refused token, or not the organisation's URL
            throw new ProviderException(Kind.TOKEN_REJECTED, "Azure DevOps sent the sign-in page (" + status + "): the token was refused, or the base URL "
                    + "is not the organisation (https://dev.azure.com/<org>)");
        }
        if (status == 403) { // the token is fine; its owner may not do this one thing
            throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps does not allow this for the token's owner (403)");
        }
        if (status == 404) {
            throw new ProviderException(Kind.NOT_FOUND, "Azure DevOps has no " + uri.getPath());
        }
        if (status < 200 || status >= 300) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps answered " + status);
        }
    }

    private static int retryAfter(HttpResponse<?> r) {
        try {
            return Math.max(1, Integer.parseInt(r.headers().firstValue("Retry-After").orElse("30").strip()));
        } catch (NumberFormatException e) {
            return 30;
        }
    }
}
