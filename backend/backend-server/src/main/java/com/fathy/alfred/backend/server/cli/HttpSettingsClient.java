package com.fathy.alfred.backend.server.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The running backend's /server API on 127.0.0.1 (always allowed: this machine). Saves carry X-Alfred-Cli-User, so
 * the history records them as CLI changes by that OS user.
 */
final class HttpSettingsClient implements SettingsClient {

    private static final Duration TIMEOUT = Duration.ofSeconds(60);

    private final String base;
    private final String user;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    HttpSettingsClient(String base, String user) {
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        this.user = user;
    }

    /** True when a backend answers /health on {@code base}. */
    static boolean answers(String base) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/health")).timeout(Duration.ofSeconds(3)).GET().build();
            return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()
                    .send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (IOException | IllegalArgumentException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Override
    public View view() {
        JsonNode body = call("GET", "/server/settings", null).body;
        List<Setting> settings = new ArrayList<>();
        for (JsonNode s : body.path("settings")) {
            settings.add(new Setting(s.path("key").asText(), s.path("label").asText(), s.path("kind").asText(),
                    s.path("applies").asText(), text(s.path("value")), s.path("isSet").asBoolean(), s.path("source").asText(),
                    text(s.path("defaultValue")), s.path("differsFromDefault").asBoolean()));
        }
        List<String> missing = new ArrayList<>();
        body.path("missingFromEnv").forEach(m -> missing.add(m.asText()));
        List<String> unused = new ArrayList<>();
        body.path("unknownLines").forEach(p -> unused.add("line " + p.path("line").asInt() + ": \"" + p.path("text").asText()
                + "\" (" + p.path("reason").asText() + ")"));
        return new View(body.path("envHash").asText(), settings, missing, unused);
    }

    @Override
    public List<Applied> save(String baseHash, List<SettingsChange.Edit> edits) {
        ObjectNode request = mapper.createObjectNode();
        request.put("baseHash", baseHash);
        request.set("edits", editsJson(edits));
        Response response = call("PUT", "/server/settings", request);
        if (response.status == 422) {
            throw new Refused(results(response.body.path("results")), false, response.body.path("message").asText());
        }
        if (response.status == 409) {
            throw new Refused(List.of(), true, response.body.path("message").asText());
        }
        return applied(response);
    }

    @Override
    public List<Applied> addMissing() {
        return applied(call("POST", "/server/settings/add-missing", mapper.createObjectNode()));
    }

    private List<Applied> applied(Response response) {
        if (response.status >= 300) {
            throw new IllegalStateException(response.body.path("message").asText(response.body.path("howToEdit").asText("HTTP " + response.status)));
        }
        List<Applied> out = new ArrayList<>();
        for (JsonNode a : response.body.path("applied")) {
            out.add(new Applied(a.path("key").asText(), a.path("outcome").asText(), a.path("detail").asText("")));
        }
        return out;
    }

    @Override
    public List<ValidationResult> check(List<SettingsChange.Edit> edits, boolean all) {
        ObjectNode request = mapper.createObjectNode();
        request.set("edits", editsJson(edits));
        request.put("all", all);
        return results(call("POST", "/server/settings/check", request).body.path("results"));
    }

    @Override
    public List<HistoryEntry> history(int limit) {
        List<HistoryEntry> out = new ArrayList<>();
        for (JsonNode e : call("GET", "/server/settings/history?limit=" + limit, null).body) {
            List<HistoryEntry.Change> changes = new ArrayList<>();
            e.path("changes").forEach(c -> changes.add(new HistoryEntry.Change(c.path("key").asText(), text(c.path("before")), text(c.path("after")))));
            out.add(new HistoryEntry(e.path("id").asLong(), Instant.parse(e.path("at").asText()),
                    HistoryEntry.HistorySource.valueOf(e.path("source").asText()), text(e.path("sourceDetail")), changes, e.path("snapshotFile").asText()));
        }
        return out;
    }

    @Override
    public List<SettingsChange.Edit> revert(long id) {
        Response response = call("POST", "/server/settings/history/" + id + "/revert", mapper.createObjectNode());
        if (response.status == 404) {
            throw new java.util.NoSuchElementException(response.body.path("message").asText());
        }
        List<SettingsChange.Edit> edits = new ArrayList<>();
        for (JsonNode e : response.body.path("edits")) {
            edits.add(e.path("reset").asBoolean() ? SettingsChange.Edit.reset(e.path("key").asText())
                    : SettingsChange.Edit.set(e.path("key").asText(), text(e.path("value"))));
        }
        return edits;
    }

    @Override
    public String where() {
        return "live";
    }

    // ------------------------------------------------------------------------------------------------------------------

    private record Response(int status, JsonNode body) {
    }

    private Response call(String method, String path, JsonNode body) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path)).timeout(TIMEOUT)
                    .header("Content-Type", "application/json")
                    .header("X-Alfred-Cli-User", user)
                    .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            String text = response.body();
            return new Response(response.statusCode(), text == null || text.isBlank() ? mapper.createObjectNode() : mapper.readTree(text));
        } catch (IOException e) {
            throw new IllegalStateException("Alfred did not answer on " + base + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", e);
        }
    }

    private ArrayNode editsJson(List<SettingsChange.Edit> edits) {
        ArrayNode array = mapper.createArrayNode();
        for (SettingsChange.Edit edit : edits) {
            ObjectNode e = array.addObject();
            e.put("key", edit.key());
            if (edit.reset()) {
                e.put("reset", true);
            } else {
                e.put("value", edit.value());
            }
        }
        return array;
    }

    private static List<ValidationResult> results(JsonNode array) {
        List<ValidationResult> out = new ArrayList<>();
        for (JsonNode r : array) {
            Map<String, Object> detail = new HashMap<>();
            r.path("detail").fields().forEachRemaining(f -> detail.put(f.getKey(), f.getValue().isNumber() ? f.getValue().numberValue() : f.getValue().toString()));
            out.add(new ValidationResult(r.path("key").asText(), ValidationResult.Level.valueOf(r.path("level").asText("OK")),
                    r.path("message").asText(""), detail));
        }
        return out;
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() || node.isMissingNode() ? null : node.asText();
    }
}
