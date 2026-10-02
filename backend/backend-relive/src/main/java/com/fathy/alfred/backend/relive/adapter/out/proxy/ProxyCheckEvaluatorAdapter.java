package com.fathy.alfred.backend.relive.adapter.out.proxy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.EvaluateChecksUseCase.ChecksUnavailableException;
import com.fathy.alfred.backend.relive.application.port.out.CheckEvaluatorPort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Asks the forward proxy to evaluate step checks: a plain HTTP request, through the proxy, to a
 * host that resolves nowhere ({@code alfred-checks.internal}). The proxy's addon recognises it and
 * answers it itself with proxy/interception.py's evaluate_check_groups - the same Condition code
 * every rule uses - and never forwards or logs it.
 */
@Component
public class ProxyCheckEvaluatorAdapter implements CheckEvaluatorPort {

    static final String CHECKS_URL = "http://alfred-checks.internal/evaluate";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient client;
    private final Duration timeout;

    public ProxyCheckEvaluatorAdapter(
            @Value("${alfred.relive.checks-proxy-host:${alfred.resend.forward-proxy-host:proxy}}") String proxyHost,
            @Value("${alfred.relive.checks-proxy-port:8080}") int proxyPort,
            @Value("${alfred.relive.checks-timeout-ms:5000}") long timeoutMs) {
        this.timeout = Duration.ofMillis(timeoutMs);
        this.client = HttpClient.newBuilder()
                .connectTimeout(timeout)
                .proxy(ProxySelector.of(new InetSocketAddress(proxyHost, proxyPort)))
                .build();
    }

    @Override
    public JsonNode evaluate(JsonNode request) {
        try {
            HttpRequest httpRequest = HttpRequest.newBuilder(URI.create(CHECKS_URL))
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(request), StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = client.send(httpRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            JsonNode body = objectMapper.readTree(response.body());
            if (response.statusCode() != 200 || body == null || !body.path("groups").isArray()) {
                throw new ChecksUnavailableException("The proxy could not evaluate the checks: " + response.statusCode()
                        + (body != null && body.has("error") ? " " + body.get("error").asText() : ""), null);
            }
            return body;
        } catch (IOException e) {
            throw new ChecksUnavailableException("The proxy is not reachable to evaluate checks: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ChecksUnavailableException("Interrupted while evaluating checks", e);
        }
    }
}
