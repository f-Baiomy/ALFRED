package com.fathy.alfred.backend.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The native install has no app-gateway: the backend serves the Angular build itself (classpath:/static) on the one
 * UI port (specs/012-server-program research R5). This filter makes the same routing decision gateway/nginx.conf makes
 * for Docker:
 * <ul>
 *   <li>a path under one of the backend's API prefixes goes to the API...</li>
 *   <li>...except a browser page load (Accept: text/html) of an SPA page that shares a prefix with the API
 *       (/profiles, /interception, /settings, /logs/**) - nginx's $spa_page - which gets index.html, so a reload of
 *       that page shows the page and not backend JSON;</li>
 *   <li>a static file that exists is served as it is;</li>
 *   <li>anything else is an Angular route: index.html.</li>
 * </ul>
 * The two lists below MUST match gateway/nginx.conf; SpaPageFilterTest parses that file and fails if they differ, so a
 * new API prefix cannot be added to one install path and forgotten in the other (CLAUDE.md).
 */
@Component
@ConditionalOnProperty(name = "ALFRED_RUNTIME", havingValue = "native")
public class SpaPageFilter extends OncePerRequestFilter {

    /** gateway/nginx.conf's API location regex, in the same order. */
    static final List<String> API_PREFIXES = List.of(
            "calls", "internal-calls", "call-overlaps", "comments", "session-cycles", "profiles", "interception",
            "redactions", "settings", "database", "health", "resend", "scenarios", "relive-cycles", "logs",
            "db-capture", "triage", "board", "call-logs", "server", "mcp", "mcp-exports");

    /** gateway/nginx.conf's $spa_page map: SPA pages that share an API prefix, matched on the path. */
    static final List<String> SPA_PAGE_PATTERNS = List.of(
            "^/(profiles|interception|settings|board)/?$",
            "^/logs(/.*)?$");

    private static final Pattern API = Pattern.compile("^/(" + String.join("|", API_PREFIXES) + ")(/|$)");
    private static final List<Pattern> SPA_PAGES = SPA_PAGE_PATTERNS.stream().map(Pattern::compile).toList();
    private static final String INDEX = "/index.html";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (forwardsToIndex(request.getMethod(), path, request.getHeader("Accept"))) {
            request.getRequestDispatcher(INDEX).forward(request, response);
            return;
        }
        chain.doFilter(request, response);
    }

    static boolean forwardsToIndex(String method, String path, String accept) {
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            return false;
        }
        if (path.startsWith("/ws/") || path.equals(INDEX)) {
            return false;
        }
        if (API.matcher(path).find()) {
            return accept != null && accept.contains("text/html") && SPA_PAGES.stream().anyMatch(p -> p.matcher(path).matches());
        }
        return !staticFileExists(path);
    }

    private static boolean staticFileExists(String path) {
        if (path.equals("/") || path.isEmpty()) {
            return false;
        }
        return new ClassPathResource("static" + path).exists();
    }
}
