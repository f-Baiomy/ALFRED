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
        this(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NORMAL).build());
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

    private JsonNode send(HttpRequest.Builder b, Token t) throws ProviderException {
        HttpRequest request = b.timeout(Duration.ofSeconds(30)).header("Authorization", auth(t)).header("Accept", "application/json").build();
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
                check(status, request.uri());
                return json.readTree(in);
            } catch (IOException e) {
                throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps sent an answer that is not JSON");
            }
        }
    }

    /** Downloads at most {@code max} bytes; null when the file is bigger. */
    byte[] download(URI uri, Token t, long max) throws ProviderException {
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).header("Authorization", auth(t)).GET().build();
        HttpResponse<InputStream> r = exchange(request);
        try (InputStream in = r.body()) {
            check(r.statusCode(), uri);
            byte[] data = in.readNBytes((int) Math.min(Integer.MAX_VALUE - 8, max + 1));
            return data.length > max ? null : data;
        } catch (IOException e) {
            throw new ProviderException(Kind.UNREACHABLE, "The download stopped");
        }
    }

    private HttpResponse<InputStream> exchange(HttpRequest request) throws ProviderException {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new ProviderException(Kind.UNREACHABLE, "Azure DevOps is not reachable at " + request.uri().getHost());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ProviderException(Kind.UNREACHABLE, "Interrupted");
        }
    }

    private static void check(int status, URI uri) throws ProviderException {
        if (status == 401 || status == 403 || status == 203) { // 203: Azure's sign-in page for a bad token
            throw new ProviderException(Kind.TOKEN_REJECTED, "Azure DevOps refused the token");
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
