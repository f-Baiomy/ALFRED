package com.fathy.alfred.backend.linksbridge;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The read allowlist covers the whole backend (R2): every GET route of every controller is either streamable
 * ({@link StreamRoutes#ROUTES}) or deliberately never streamed ({@link StreamRoutes#NEVER}). A new GET route fails here
 * until someone decides which - so nothing is streamed by accident, and nothing a stream needs is silently missing.
 */
class StreamRoutesTest {

    @Test
    void everyGetRouteIsStreamedOrNeverStreamed() throws Exception {
        List<String> routes = getRoutes();
        assertThat(routes).as("controllers found").hasSizeGreaterThan(100);
        TreeSet<String> undecided = new TreeSet<>();
        for (String route : routes) {
            String sample = sample(route);
            boolean streamed = StreamRoutes.match("GET", sample, Map.of(), null).isPresent();
            if (!streamed && !StreamRoutes.never(sample)) {
                undecided.add(route + "   (as " + sample + ")");
            }
        }
        assertThat(undecided).as("GET routes neither in StreamRoutes.ROUTES nor in StreamRoutes.NEVER").isEmpty();
    }

    @Test
    void neverWinsOverARouteThatWouldTakeTheNameAsAnId() {
        for (String p : List.of("/internal-calls/baseline", "/calls/baseline", "/internal-calls/services", "/internal-calls/feature-enabled")) {
            assertThat(StreamRoutes.match("GET", p, Map.of(), null)).as(p).isEmpty();
        }
        assertThat(StreamRoutes.match("GET", "/internal-calls/k1@stg-83/detail", Map.of(), null)).isPresent();
        assertThat(StreamRoutes.match("GET", "/links/data/cycle", Map.of("cycleId", List.of("c1")), null)).isPresent();
        assertThat(StreamRoutes.match("GET", "/links/streams", Map.of(), null)).isEmpty();
    }

    @Test
    void settingsInterceptionTeamAndServerAreNeverStreamed() {
        for (String p : List.of("/settings", "/settings/storage", "/interception/rules", "/teamboards/items", "/server/status",
                "/relive-cycles", "/logs/sources", "/links", "/links/streams", "/board/sessions", "/board/helpers")) {
            assertThat(StreamRoutes.match("GET", p, Map.of(), null)).as(p).isEmpty();
            assertThat(StreamRoutes.never(p)).as(p).isTrue();
        }
    }

    @Test
    void aRefIsFoundInThePathOrTheQuery() {
        var m = StreamRoutes.match("GET", "/session-cycles/c1@stg-83/calls/k9/detail", Map.of(), null).orElseThrow();
        assertThat(m.of(StreamRoutes.Kind.CYCLE).orElseThrow().value()).isEqualTo("c1@stg-83");
        assertThat(m.of(StreamRoutes.Kind.CALL).orElseThrow().value()).isEqualTo("k9");
        var cards = StreamRoutes.match("GET", "/board/cards", Map.of("project", List.of("odeysys")), null).orElseThrow();
        assertThat(cards.of(StreamRoutes.Kind.BOARD_OR_PROJECT).orElseThrow().value()).isEqualTo("default:odeysys");
        var post = StreamRoutes.match("POST", "/triage/problem-calls", Map.of(), List.of("a@x", "b@x")).orElseThrow();
        assertThat(post.of(StreamRoutes.Kind.CALLS).orElseThrow().value()).isEqualTo("a@x,b@x");
    }

    @Test
    void anEncodedAtSignIsDecodedButAnEncodedSlashStaysInItsSegment() {
        assertThat(StreamRoutes.decodePath("/session-cycles/c1%40stg-83/calls")).isEqualTo("/session-cycles/c1@stg-83/calls");
        assertThat(StreamRoutes.decodePath("/board/files/a%2Fb")).isEqualTo("/board/files/a%2Fb");
    }

    @Test
    void writesAreNeverMatched() {
        for (String method : List.of("PUT", "PATCH", "DELETE")) {
            assertThat(StreamRoutes.match(method, "/session-cycles/c1@x", Map.of(), null)).isEmpty();
        }
    }

    /** {@code /session-cycles/{id}/calls} -> {@code /session-cycles/x1/calls}; a catch-all becomes two segments. */
    private static String sample(String route) {
        String s = route.replaceAll("\\{\\*[^}]+}", "a/b").replace("/**", "/a/b");
        s = s.replaceAll("\\{[^}:]+:[^}]*}", "x1").replaceAll("\\{[^}]+}", "x1");
        s = s.replaceAll("/+", "/");
        return s.length() > 1 && s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static List<String> getRoutes() throws ClassNotFoundException {
        var scanner = new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        List<String> out = new ArrayList<>();
        for (var bd : scanner.findCandidateComponents("com.fathy.alfred.backend")) {
            Class<?> c = Class.forName(bd.getBeanClassName());
            RequestMapping base = AnnotatedElementUtils.findMergedAnnotation(c, RequestMapping.class);
            String[] prefixes = base == null || base.path().length == 0 ? new String[]{""} : base.path();
            for (Method m : c.getDeclaredMethods()) {
                RequestMapping rm = AnnotatedElementUtils.findMergedAnnotation(m, RequestMapping.class);
                if (rm == null) {
                    continue;
                }
                boolean get = AnnotatedElementUtils.hasAnnotation(m, GetMapping.class) || rm.method().length == 0
                        || List.of(rm.method()).contains(RequestMethod.GET);
                if (!get) {
                    continue;
                }
                String[] paths = rm.path().length == 0 ? new String[]{""} : rm.path();
                for (String prefix : prefixes) {
                    for (String p : paths) {
                        String full = (prefix + (p.isEmpty() || p.startsWith("/") ? p : "/" + p));
                        out.add(full.isEmpty() ? "/" : full);
                    }
                }
            }
        }
        return out;
    }
}
