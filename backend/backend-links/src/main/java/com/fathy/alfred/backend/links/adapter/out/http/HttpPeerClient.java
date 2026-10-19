package com.fathy.alfred.backend.links.adapter.out.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase;
import com.fathy.alfred.backend.links.application.port.out.PeerHttpPort;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/** Plain HTTP to another Alfred's gateway before a link exists: hello, offer, and the long wait for an answer. */
@Component
public class HttpPeerClient implements PeerHttpPort {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(6)).build();

    static String base(String address) {
        String a = address.trim();
        while (a.endsWith("/")) {
            a = a.substring(0, a.length() - 1);
        }
        if (a.startsWith("ws://")) {
            a = "http://" + a.substring(5);
        } else if (a.startsWith("wss://")) {
            a = "https://" + a.substring(6);
        } else if (!a.startsWith("http://") && !a.startsWith("https://")) {
            a = "http://" + a;
        }
        return a;
    }

    private JsonNode call(HttpRequest request, String address) {
        HttpResponse<String> r;
        try {
            r = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new LinkUnavailableException("OFFLINE", null, "Nothing answers at " + address + " (" + e.getClass().getSimpleName() + ")");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LinkUnavailableException("OFFLINE", null, "Interrupted");
        }
        if (r.statusCode() == 404) {
            throw new LinkUnavailableException("UNSUPPORTED", null, "The Alfred at " + address + " is too old for streams - update it");
        }
        JsonNode body;
        try {
            body = JSON.readTree(r.body() == null || r.body().isBlank() ? "{}" : r.body());
        } catch (IOException e) {
            throw new LinkUnavailableException("UNSUPPORTED", null, "What answers at " + address + " is not an Alfred");
        }
        if (r.statusCode() >= 400) {
            throw new LinkUnavailableException(body.path("error").asText("REFUSED"), null,
                    body.path("message").asText("The Alfred at " + address + " refused (" + r.statusCode() + ")"));
        }
        return body;
    }

    @Override
    public LinksUseCase.Hello hello(String address) {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base(address) + "/links/hello")).timeout(Duration.ofSeconds(8))
                .header("Accept", "application/json").GET().build();
        JsonNode b = call(req, address);
        if (!b.hasNonNull("alfredId")) {
            throw new LinkUnavailableException("UNSUPPORTED", null, "What answers at " + address + " is not an Alfred");
        }
        return new LinksUseCase.Hello(b.path("alfredId").asText(), b.path("name").asText(""), b.path("version").asText(""),
                b.path("streams").asInt(0), b.path("announce").asBoolean(false));
    }

    @Override
    public PairingUseCase.OfferAnswer offer(String address, PairingUseCase.OfferIn in) {
        ObjectNode body = JSON.createObjectNode();
        body.put("alfredId", in.alfredId());
        body.put("name", in.name());
        body.put("version", in.version());
        body.put("nonce", in.nonce());
        body.put("address", in.address());
        HttpRequest req = HttpRequest.newBuilder(URI.create(base(address) + "/links/pair/offers")).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
        JsonNode b = call(req, address);
        return new PairingUseCase.OfferAnswer(b.path("offerId").asText(), b.path("code").asText(), b.path("alfredId").asText(),
                b.path("name").asText(""), b.path("version").asText(""));
    }

    @Override
    public PairingUseCase.OfferResult await(String address, String offerId, String nonce) {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base(address) + "/links/pair/offers/" + URLEncoder.encode(offerId, StandardCharsets.UTF_8)
                        + "/wait?nonce=" + URLEncoder.encode(nonce, StandardCharsets.UTF_8)))
                .timeout(Duration.ofSeconds(75)).header("Accept", "application/json").GET().build();
        JsonNode b = call(req, address);
        return new PairingUseCase.OfferResult(b.path("state").asText("WAITING"), b.hasNonNull("secret") ? b.path("secret").asText() : null,
                b.path("alfredId").asText(null), b.path("name").asText(null), b.path("version").asText(null));
    }
}
