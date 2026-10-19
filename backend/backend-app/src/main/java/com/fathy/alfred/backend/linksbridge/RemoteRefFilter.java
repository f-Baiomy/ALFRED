package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.boardbridge.BoardEditAccess;
import com.fathy.alfred.backend.links.adapter.in.web.RelayPipe;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.domain.RefTagger;
import com.fathy.alfred.backend.links.domain.RemoteRef;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Reads of another Alfred's things by their refs (R1): a GET on an allowlisted route whose ref ends in a link's suffix
 * ({@code /internal-calls/8f1c…@stg83/summary}) goes over that link with the suffix taken off, and the answer's ids come
 * back tagged with it - so the board, the MCP server and every page keep calling the same routes with the ids they were
 * given. Nothing read is stored (D20). Never through the tunnel (D3).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RemoteRefFilter extends OncePerRequestFilter {

    private final ObjectProvider<RelayUseCase> relay;

    public RemoteRefFilter(ObjectProvider<RelayUseCase> relay) {
        this.relay = relay;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String m = request.getMethod();
        String path = request.getRequestURI();
        if (!"GET".equals(m) && !"POST".equals(m)) {
            // a write naming another Alfred's thing in its path is checked (refused unless this Alfred's own relation)
            return !(path.contains("@") || path.contains("%40"));
        }
        String q = request.getQueryString();
        // only a request that names something with an '@' can be a ref to another Alfred's thing
        return !(path.contains("@") || path.contains("%40") || q != null && (q.contains("@") || q.contains("%40")) || "POST".equals(m));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        RelayUseCase r = relay.getIfAvailable();
        if (r == null) {
            chain.doFilter(request, response);
            return;
        }
        String rawPath = request.getRequestURI().substring(request.getContextPath().length());
        String decoded = StreamRoutes.decodePath(rawPath);
        String query = request.getQueryString();
        Map<String, List<String>> params = StreamRoutes.params(query);
        HttpServletRequest req = request;
        String body = null;
        List<String> bodyIds = List.of();
        String method = request.getMethod();
        boolean postRead = "POST".equals(method) && StreamRoutes.ROUTES.stream().anyMatch(x -> x.post() && x.path().matcher(decoded).matches());
        if (!"GET".equals(method) && !postRead) {
            // D20, D25: nothing of another Alfred's is changed here, and nothing of this Alfred's is stored under its ids -
            // a note on its call or a comment on its card is a request to its owner (POST /links/requests)
            if (namesRemote(r, decoded) && !OWN_RELATION.matcher(decoded).matches()) {
                refuseWrite(response);
                return;
            }
            if ("POST".equals(method) && decoded.equals("/comments")) {
                byte[] bytes = request.getInputStream().readAllBytes();
                String callId = commentCallId(bytes);
                if (callId != null && RemoteRef.outer(callId).filter(x -> r.knows(x.slug())).isPresent()) {
                    refuseWrite(response);
                    return;
                }
                chain.doFilter(new CachedBody(request, bytes), response);
                return;
            }
            chain.doFilter(request, response);
            return;
        }
        if ("POST".equals(method)) {
            byte[] bytes = request.getInputStream().readAllBytes();
            body = new String(bytes, StandardCharsets.UTF_8);
            req = new CachedBody(request, bytes);
            bodyIds = LoopbackDispatcher.callIds(body);
            if (bodyIds.stream().noneMatch(x -> x.contains("@"))) {
                chain.doFilter(req, response);
                return;
            }
        }
        Optional<StreamRoutes.Match> match = StreamRoutes.match(request.getMethod(), decoded, params, bodyIds);
        if (match.isEmpty() || !match.get().route().relaysRefs()) {
            chain.doFilter(req, response);
            return;
        }
        Set<String> slugs = new LinkedHashSet<>();
        boolean local = false;
        for (StreamRoutes.Found f : match.get().found()) {
            List<String> values = f.ref().kind() == StreamRoutes.Kind.CALLS
                    ? Arrays.stream(f.value().split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList() : List.of(f.value());
            for (String v : values) {
                Optional<RemoteRef.Split> sp = RemoteRef.outer(v).filter(x -> r.knows(x.slug()));
                if (sp.isPresent()) {
                    slugs.add(sp.get().slug());
                } else {
                    local = true;
                }
            }
        }
        if (slugs.isEmpty()) {
            chain.doFilter(req, response);
            return;
        }
        if (BoardEditAccess.viaTunnel(request)) {
            RelayPipe.unavailable(response, "TUNNEL", "Other Alfreds' data is never shown through the shared tunnel link", null);
            return;
        }
        if (local || slugs.size() > 1) {
            response.setStatus(400);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"MIXED_ORIGINS\",\"message\":\"One read can only name things of one Alfred\"}");
            return;
        }
        String slug = slugs.iterator().next();
        Map<String, String> headers = new LinkedHashMap<>();
        String accept = request.getHeader("Accept");
        headers.put("Accept", accept == null ? "application/json" : accept);
        RelayRequest original = new RelayRequest(request.getMethod(), rawPath, query == null ? "" : query, headers, body, RelayContext.hops());
        RelayRequest onward = LoopbackDispatcher.stripped(original, match.get(), slug);
        onward = onward.withHops(RelayContext.hops());
        RelayPipe.pipe(r, slug, onward, response, new RefTagger(slug));
    }

    /**
     * The writes of this Alfred's own that name another Alfred's thing: a remote cycle related to (or removed from) a
     * board here or one of its cards, with the board's own flags for it (D25), and the links API itself.
     */
    static final java.util.regex.Pattern OWN_RELATION = java.util.regex.Pattern.compile(
            "^/board/(boards|cards)/[^/@]+/cycles/[^/]+(/flags)?$|^/links(/.*)?$");

    private static boolean namesRemote(RelayUseCase r, String decodedPath) {
        for (String seg : decodedPath.split("/")) {
            if (RemoteRef.outer(seg).filter(x -> r.knows(x.slug())).isPresent()) {
                return true;
            }
        }
        return false;
    }

    private static String commentCallId(byte[] body) {
        try {
            com.fasterxml.jackson.databind.JsonNode n = new com.fasterxml.jackson.databind.ObjectMapper().readTree(body);
            return n != null && n.hasNonNull("callId") ? n.path("callId").asText() : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static void refuseWrite(HttpServletResponse response) throws IOException {
        response.setStatus(409);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"REMOTE_WRITE\",\"message\":\"That belongs to another Alfred - it is changed only there; "
                + "a comment or a note on it is a request to its owner\"}");
    }

    /** The POST body read here, given again to whatever handles the request locally. */
    static final class CachedBody extends HttpServletRequestWrapper {

        private final byte[] body;

        CachedBody(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public boolean isFinished() {
                    return in.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    throw new UnsupportedOperationException();
                }

                @Override
                public int read() {
                    return in.read();
                }

                @Override
                public int read(byte[] b, int off, int len) {
                    return in.read(b, off, len);
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }
}
