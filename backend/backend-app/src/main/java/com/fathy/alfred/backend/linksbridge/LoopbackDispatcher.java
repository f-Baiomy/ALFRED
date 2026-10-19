package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.ReadLogUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayInputStream;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.application.port.out.LocalDispatchPort;
import com.fathy.alfred.backend.links.domain.JsonRewriter;
import com.fathy.alfred.backend.links.domain.RefTagger;
import com.fathy.alfred.backend.links.domain.RemoteRef;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.redactions.application.port.in.ListRedactionsUseCase;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Answers a linked Alfred's read (R2): finds the route and the stream that covers its ref (none - refused), answers
 * through this Alfred's own route on 127.0.0.1 with the answer masked at the source (D17, D28), logs the read (D31) -
 * or, for a third Alfred's thing on a streamed board, passes the read on to it with the hops (D8, R6), where that
 * Alfred's own stream rules decide.
 */
@Component
public class LoopbackDispatcher implements LocalDispatchPort {

    private static final Logger log = LoggerFactory.getLogger(LoopbackDispatcher.class);

    static final String SCOPE_HEADER = "X-Alfred-Scope-Cycles";
    static final String READER_HEADER = "X-Alfred-Reader-Name";
    static final int MAX_CHECKED_BYTES = 64 * 1024 * 1024;
    static final Set<String> PASSED_HEADERS = Set.of("content-type", "content-disposition", "x-total-count", "x-alfred-total", "x-alfred-next",
            "x-alfred-truncated");

    private final Loopback loopback;
    private final StreamScope scope;
    private final ObjectProvider<ReadLogUseCase> reads;
    private final ObjectProvider<RelayUseCase> relay;
    private final ObjectProvider<LinksUseCase> links;
    private final ObjectProvider<ListRedactionsUseCase> redactions;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ObjectMapper json = new ObjectMapper();

    public LoopbackDispatcher(Loopback loopback, StreamScope scope, ObjectProvider<ReadLogUseCase> reads, ObjectProvider<RelayUseCase> relay,
                              ObjectProvider<LinksUseCase> links, ObjectProvider<ListRedactionsUseCase> redactions) {
        this.loopback = loopback;
        this.scope = scope;
        this.reads = reads;
        this.relay = relay;
        this.links = links;
        this.redactions = redactions;
    }

    @Override
    public void serve(Link from, List<Stream> offered, RelayRequest req, ResponseWriter w) {
        String decoded = StreamRoutes.decodePath(req.path());
        Map<String, List<String>> params = StreamRoutes.params(req.query());
        List<String> bodyIds = "POST".equals(req.method()) ? callIds(req.body()) : List.of();
        Optional<StreamRoutes.Match> match = StreamRoutes.match(req.method(), decoded, params, bodyIds);
        if (match.isEmpty() || match.get().found().isEmpty()) {
            refuse(w, 403, "NOT_STREAMED", "That is not something a stream lets another Alfred read");
            return;
        }
        StreamRoutes.Match m = match.get();
        Set<String> slugs = new LinkedHashSet<>();
        boolean local = false;
        for (StreamRoutes.Found f : m.found()) {
            for (String v : values(f)) {
                Optional<RemoteRef.Split> sp = RemoteRef.outer(v).filter(x -> scope.isRemote(v));
                if (sp.isPresent()) {
                    slugs.add(sp.get().slug());
                } else {
                    local = true;
                }
            }
        }
        if (!slugs.isEmpty()) {
            if (local || slugs.size() > 1) {
                refuse(w, 400, "MIXED_ORIGINS", "One read can only name things of one Alfred");
                return;
            }
            passOn(from, offered, req, m, slugs.iterator().next(), w);
            return;
        }
        Set<String> onlyCycles = req.hops().size() > 1 ? headerList(req.headers().get(SCOPE_HEADER)) : null;
        Optional<Stream> grant;
        boolean checkAnswer = m.of(StreamRoutes.Kind.STATEMENT).isPresent() || m.of(StreamRoutes.Kind.STORE_COMMAND).isPresent();
        if (checkAnswer) {
            grant = Optional.empty(); // decided from the answer's call
        } else {
            grant = grant(offered, m, onlyCycles);
            if (grant.isEmpty()) {
                refuse(w, 403, "NOT_STREAMED", "That is not part of what is streamed to you");
                return;
            }
            if (!passAllowed(req, grant.get(), w)) {
                return;
            }
        }
        String target = m.found().get(0).value();
        String via = req.hops().size() > 1 ? req.headers().getOrDefault(READER_HEADER, "another Alfred") : null;
        // a reader that kept a copy or made an export says so once, and the read log names it (D31, D34)
        String purpose = m.param("alfredPurpose");
        String family = "copy".equals(purpose) || "export".equals(purpose) ? purpose : m.route().family();
        try {
            local(from, offered, req, w, grant, onlyCycles, family, target, via);
        } catch (IOException e) {
            w.error("FAILED", e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            w.error("FAILED", "Interrupted");
        }
    }

    private boolean passAllowed(RelayRequest req, Stream s, ResponseWriter w) {
        if (req.hops().size() > 1 && !s.passOn()) {
            refuse(w, 403, "NOT_PASSED_ON", "The owner does not let this stream be passed on");
            return false;
        }
        return true;
    }

    private static List<String> values(StreamRoutes.Found f) {
        if (f.ref().kind() == StreamRoutes.Kind.CALLS) {
            return Arrays.stream(f.value().split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList();
        }
        return List.of(f.value());
    }

    private static Set<String> headerList(String v) {
        if (v == null || v.isBlank()) {
            return null;
        }
        return Arrays.stream(v.split(",")).map(String::trim).filter(x -> !x.isEmpty()).collect(Collectors.toCollection(LinkedHashSet::new));
    }

    /** The stream that covers every ref of the match, or none. */
    Optional<Stream> grant(List<Stream> offered, StreamRoutes.Match m, Set<String> onlyCycles) {
        Optional<Stream> granted = Optional.empty();
        String cycleHint = m.of(StreamRoutes.Kind.CYCLE).map(StreamRoutes.Found::value).orElse(null);
        for (StreamRoutes.Found f : m.found()) {
            Optional<Stream> g = switch (f.ref().kind()) {
                case CYCLE -> onlyCycles != null && !onlyCycles.contains(f.value()) ? Optional.empty() : scope.streamOfCycle(offered, f.value());
                case CALL -> scope.streamOfCall(offered, f.value(), cycleHint, onlyCycles);
                case CALLS -> {
                    Optional<Stream> first = Optional.empty();
                    for (String id : values(f)) {
                        Optional<Stream> one = scope.streamOfCall(offered, id, null, onlyCycles);
                        if (one.isEmpty()) {
                            yield Optional.empty();
                        }
                        if (first.isEmpty()) {
                            first = one;
                        }
                    }
                    yield first;
                }
                case BOARD, BOARD_OR_PROJECT -> scope.streamOfBoard(offered, f.value());
                case PROJECT -> offered.stream().filter(s -> s.kind() == StreamKind.BOARD
                        && scope.projectOf(s.target()).map(f.value()::equals).orElse(false)).findFirst();
                case CARD -> scope.boardOfCard(f.value()).flatMap(b -> scope.streamOfBoard(offered, b));
                case CARD_NUMBER -> {
                    int n;
                    try {
                        n = Integer.parseInt(f.value());
                    } catch (NumberFormatException e) {
                        yield Optional.empty();
                    }
                    yield scope.boardOfCardNumber(m.param("project"), n).flatMap(b -> scope.streamOfBoard(offered, b));
                }
                case CHAT -> scope.boardOfChat(m.param("project"), f.value()).flatMap(b -> scope.streamOfBoard(offered, b));
                case FILE -> scope.boardOfFile(f.value()).flatMap(b -> scope.streamOfBoard(offered, b));
                case SNIPPET -> scope.boardOfSnippet(f.value()).flatMap(b -> scope.streamOfBoard(offered, b));
                case IMAGE -> scope.boardOfImage(f.value()).flatMap(b -> scope.streamOfBoard(offered, b));
                case STATEMENT, STORE_COMMAND -> Optional.empty();
            };
            if (g.isEmpty()) {
                return Optional.empty();
            }
            if (granted.isEmpty()) {
                granted = g;
            }
        }
        return granted;
    }

    // ------------------------------------------------------------------------------------------- from this Alfred

    private void local(Link from, List<Stream> offered, RelayRequest req, ResponseWriter w, Optional<Stream> grant, Set<String> onlyCycles,
                       String family, String target, String via) throws IOException, InterruptedException {
        String uri = loopback.base() + req.path() + (req.query().isEmpty() ? "" : "?" + req.query());
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(120))
                .header(Loopback.TOKEN_HEADER, loopback.token())
                .header(Loopback.LINK_HEADER, from.id())
                .header(Loopback.HOPS_HEADER, String.join(",", req.hops()))
                .header("Accept", req.headers().getOrDefault("Accept", "application/json"));
        if (via != null) {
            b.header(Loopback.READER_HEADER, via);
        }
        if ("POST".equals(req.method())) {
            b.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(req.body() == null ? "{}" : req.body()));
        } else {
            b.GET();
        }
        HttpResponse<InputStream> r = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        Map<String, String> headers = new LinkedHashMap<>();
        r.headers().map().forEach((k, v) -> {
            if (PASSED_HEADERS.contains(k.toLowerCase(Locale.ROOT)) && !v.isEmpty()) {
                headers.put(k, v.get(0));
            }
        });
        String contentType = headers.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("content-type")).map(Map.Entry::getValue)
                .findFirst().orElse("");
        InputStream raw = r.body();
        try (raw) {
            InputStream body = raw;
            Optional<Stream> granted = grant;
            if (granted.isEmpty()) {
                // a statement or a Redis command: covered when its call is
                byte[] whole = readCapped(body);
                String callId = r.statusCode() < 400 ? callIdIn(whole) : null;
                granted = callId == null ? Optional.empty() : scope.streamOfCall(offered, callId, null, onlyCycles);
                if (granted.isEmpty()) {
                    refuse(w, 403, "NOT_STREAMED", "That is not part of what is streamed to you");
                    return;
                }
                if (req.hops().size() > 1 && !granted.get().passOn()) {
                    refuse(w, 403, "NOT_PASSED_ON", "The owner does not let this stream be passed on");
                    return;
                }
                body = new ByteArrayInputStream(whole);
            }
            record(from, family, target, via);
            w.head(r.statusCode(), headers);
            OutputStream out = new WriterOutputStream(w);
            if (!granted.get().unmasked() && contentType.toLowerCase(Locale.ROOT).contains("json")) {
                JsonRewriter.rewrite(body, out, new SourceMasker(redactionList()));
            } else {
                body.transferTo(out);
            }
            out.flush();
            w.end();
        }
    }

    private List<Redaction> redactionList() {
        ListRedactionsUseCase r = redactions.getIfAvailable();
        if (r == null) {
            return List.of();
        }
        try {
            return r.listAll();
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    private void record(Link from, String family, String target, String via) {
        ReadLogUseCase r = reads.getIfAvailable();
        if (r != null) {
            try {
                r.record(from.id(), family, target, via);
            } catch (RuntimeException e) {
                log.debug("Read log failed: {}", e.toString());
            }
        }
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > MAX_CHECKED_BYTES) {
                throw new IOException("The answer is too large to check");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** The first {@code callId} field of a JSON answer (a statement's or a command's call), breadth first. */
    String callIdIn(byte[] body) {
        try {
            JsonNode root = json.readTree(body);
            List<JsonNode> level = List.of(root);
            for (int depth = 0; depth < 4 && !level.isEmpty(); depth++) {
                List<JsonNode> next = new ArrayList<>();
                for (JsonNode n : level) {
                    if (n.isObject()) {
                        if (n.hasNonNull("callId")) {
                            return n.path("callId").asText();
                        }
                        n.forEach(next::add);
                    }
                }
                level = next;
            }
        } catch (IOException | RuntimeException e) {
            return null;
        }
        return null;
    }

    static List<String> callIds(String body) {
        if (body == null || body.isBlank()) {
            return List.of();
        }
        try {
            JsonNode n = new ObjectMapper().readTree(body).path("callIds");
            List<String> out = new ArrayList<>();
            n.forEach(x -> out.add(x.asText()));
            return out;
        } catch (IOException e) {
            return List.of();
        }
    }

    // --------------------------------------------------------------------------------- for a third Alfred (D8, R6)

    private void passOn(Link from, List<Stream> offered, RelayRequest req, StreamRoutes.Match m, String slug, ResponseWriter w) {
        RelayUseCase r = relay.getIfAvailable();
        if (r == null) {
            refuse(w, 501, "UNSUPPORTED", "This Alfred cannot pass reads on");
            return;
        }
        // which of the far Alfred's cycles are on what this link may read here
        Set<String> theirs = new LinkedHashSet<>();
        for (String c : scope.cycles(offered)) {
            RemoteRef.outer(c).filter(sp -> sp.slug().equals(slug)).ifPresent(sp -> theirs.add(sp.inner()));
        }
        if (theirs.isEmpty()) {
            refuse(w, 403, "NOT_STREAMED", "That is not part of what is streamed to you");
            return;
        }
        Optional<StreamRoutes.Found> cycle = m.of(StreamRoutes.Kind.CYCLE);
        if (cycle.isPresent()) {
            String inner = RemoteRef.outer(cycle.get().value()).map(RemoteRef.Split::inner).orElse("");
            if (!theirs.contains(inner)) {
                refuse(w, 403, "NOT_STREAMED", "That cycle is not on what is streamed to you");
                return;
            }
        }
        for (StreamRoutes.Found f : m.found()) {
            StreamRoutes.Kind k = f.ref().kind();
            if (k != StreamRoutes.Kind.CYCLE && k != StreamRoutes.Kind.CALL && k != StreamRoutes.Kind.CALLS && k != StreamRoutes.Kind.STATEMENT
                    && k != StreamRoutes.Kind.STORE_COMMAND) {
                refuse(w, 403, "NOT_STREAMED", "Only a passed-on cycle's calls pass through this Alfred");
                return;
            }
        }
        RelayRequest onward = stripped(req, m, slug);
        Map<String, String> h = new LinkedHashMap<>(onward.headers());
        h.put(SCOPE_HEADER, String.join(",", theirs));
        h.put(READER_HEADER, from.name());
        onward = new RelayRequest(onward.method(), onward.path(), onward.query(), h, onward.body(), req.hops());
        BlockingResponse answer = new BlockingResponse();
        RelayCall call;
        try {
            call = r.open(slug, onward, answer);
        } catch (LinkUnavailableException e) {
            refuse(w, 503, e.code(), e.getMessage());
            return;
        }
        answer.attach(call);
        RelayInputStream in = new RelayInputStream(answer, Duration.ofSeconds(90));
        try (in) {
            int status;
            try {
                status = in.awaitHead();
            } catch (LinkUnavailableException e) {
                refuse(w, 503, e.code(), e.getMessage());
                return;
            }
            record(from, m.route().family() + " (passed on)", m.found().get(0).value(), slug);
            Map<String, String> headers = new LinkedHashMap<>();
            in.headers().forEach((k, v) -> {
                if (PASSED_HEADERS.contains(k.toLowerCase(Locale.ROOT))) {
                    headers.put(k, v);
                }
            });
            w.head(status, headers);
            OutputStream out = new WriterOutputStream(w);
            String ct = headers.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("content-type")).map(Map.Entry::getValue).findFirst()
                    .orElse("");
            if (ct.toLowerCase(Locale.ROOT).contains("json") && status < 400) {
                JsonRewriter.rewrite(in, out, new RefTagger(slug));
            } else {
                in.transferTo(out);
            }
            out.flush();
            w.end();
        } catch (IOException e) {
            answer.cancel();
            w.error("OFFLINE", e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            answer.cancel();
            w.error("FAILED", "Interrupted");
        }
    }

    /** The request with this link's suffix taken off every ref (the far Alfred calls them by its own ids). */
    static RelayRequest stripped(RelayRequest req, StreamRoutes.Match m, String slug) {
        String suffix = "@" + slug;
        String decoded = StreamRoutes.decodePath(req.path());
        StringBuilder path = new StringBuilder();
        for (String seg : decoded.split("/", -1)) {
            if (path.length() > 0 || decoded.startsWith("/")) {
                path.append('/');
            }
            String s = seg.endsWith(suffix) ? seg.substring(0, seg.length() - suffix.length()) : seg;
            path.append(encodeSegment(s.replace("%2F", "/")));
        }
        String p = path.toString().startsWith("//") ? path.substring(1) : path.toString();
        Map<String, List<String>> params = StreamRoutes.params(req.query());
        StringBuilder q = new StringBuilder();
        for (Map.Entry<String, List<String>> e : params.entrySet()) {
            for (String v : e.getValue()) {
                if (q.length() > 0) {
                    q.append('&');
                }
                String stripped = Arrays.stream(v.split(",", -1)).map(x -> x.endsWith(suffix) ? x.substring(0, x.length() - suffix.length()) : x)
                        .collect(Collectors.joining(","));
                q.append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8)).append('=').append(URLEncoder.encode(stripped, StandardCharsets.UTF_8));
            }
        }
        String body = req.body();
        if (body != null && m.route().post()) {
            try {
                ObjectMapper om = new ObjectMapper();
                ObjectNode n = (ObjectNode) om.readTree(body);
                ArrayNode ids = om.createArrayNode();
                n.path("callIds").forEach(x -> {
                    String v = x.asText();
                    ids.add(v.endsWith(suffix) ? v.substring(0, v.length() - suffix.length()) : v);
                });
                n.set("callIds", ids);
                body = om.writeValueAsString(n);
            } catch (IOException | ClassCastException e) {
                // left as it is
            }
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", req.headers().getOrDefault("Accept", "application/json"));
        if (body != null) {
            headers.put("Content-Type", "application/json");
        }
        return new RelayRequest(req.method(), p, q.toString(), headers, body, req.hops());
    }

    /** Percent-encodes a path segment, keeping what a path may hold as it is (letters, digits, -._~ and :@!$&'()*+,;=). */
    static String encodeSegment(String s) {
        StringBuilder out = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if (Character.isLetterOrDigit(c) && c < 128 || "-._~:@!$&'()*+,;=".indexOf(c) >= 0) {
                out.append((char) c);
            } else {
                out.append('%').append(String.format("%02X", c));
            }
        }
        return out.toString();
    }

    static void refuse(ResponseWriter w, int status, String code, String message) {
        try {
            w.head(status, Map.of("Content-Type", "application/json"));
            w.write(new ObjectMapper().writeValueAsBytes(Map.of("error", code, "message", message == null ? "" : message)));
            w.end();
        } catch (IOException e) {
            w.error(code, message);
        }
    }

    /** What a JSON rewriter or a copy writes, sent on as the reader's credit allows. */
    static final class WriterOutputStream extends OutputStream {

        private final ResponseWriter w;

        WriterOutputStream(ResponseWriter w) {
            this.w = w;
        }

        @Override
        public void write(int b) throws IOException {
            w.write(new byte[]{(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            w.write(b, off, len);
        }
    }
}
