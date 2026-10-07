package com.fathy.alfred.backend.server.adapter.out.update;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.application.port.out.UpdateFeedPort;
import com.fathy.alfred.backend.server.domain.model.UpdateManifest;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reads {@code latest.json} from ALFRED_UPDATE_URL. GitHub's
 * {@code /releases/latest/download/latest.json} answers with a redirect to the asset, so redirects are followed;
 * {@code file:} URLs work too, for an installer folder on a share (offline servers) and for tests. The whole read is
 * bounded: 15 s and 1 MB, because this runs on a schedule inside the backend.
 */
public class HttpUpdateFeedAdapter implements UpdateFeedPort {

    static final int MAX_BYTES = 1 << 20;

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @Override
    public UpdateManifest fetch(String url) throws IOException {
        if (url == null || url.isBlank()) {
            throw new IOException("ALFRED_UPDATE_URL is empty");
        }
        return parse(read(url.strip()));
    }

    private String read(String url) throws IOException {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new IOException("not a URL");
        }
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            Path path = Path.of(uri);
            if (Files.size(path) > MAX_BYTES) {
                throw new IOException("the manifest is larger than 1 MB");
            }
            return Files.readString(path, StandardCharsets.UTF_8);
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) {
            throw new IOException("only http(s) and file URLs are supported");
        }
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(15))
                .header("Accept", "application/json").header("User-Agent", "alfred-update-check").GET().build();
        HttpResponse<byte[]> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        }
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode());
        }
        if (response.body().length > MAX_BYTES) {
            throw new IOException("the manifest is larger than 1 MB");
        }
        return new String(response.body(), StandardCharsets.UTF_8);
    }

    UpdateManifest parse(String text) throws IOException {
        JsonNode root;
        try {
            root = mapper.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IOException("not JSON: " + e.getOriginalMessage());
        }
        if (root == null || !root.isObject() || !root.hasNonNull("version")) {
            throw new IOException("not an Alfred release manifest (no \"version\")");
        }
        Map<String, UpdateManifest.Asset> assets = new LinkedHashMap<>();
        JsonNode list = root.path("assets");
        for (Iterator<Map.Entry<String, JsonNode>> it = list.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            JsonNode a = entry.getValue();
            assets.put(entry.getKey(), new UpdateManifest.Asset(a.path("url").asText(""), a.path("sha256").asText(""),
                    a.path("size").asLong(0)));
        }
        return new UpdateManifest(root.path("version").asText(), root.path("notes").asText(""),
                root.path("publishedAt").asText(""), assets);
    }
}
