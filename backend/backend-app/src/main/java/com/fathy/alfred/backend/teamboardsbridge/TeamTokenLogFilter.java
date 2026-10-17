package com.fathy.alfred.backend.teamboardsbridge;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The viewer's tracker token (X-Alfred-Team-Token, specs/027 R10) is meant only for the /teamboards routes that reach the
 * provider. Every other route sees the request without it, so no handler, relay, log line or error report elsewhere can
 * read, forward or print it. The token is never logged here either.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TeamTokenLogFilter extends OncePerRequestFilter {

    public static final String TOKEN_HEADER = "X-Alfred-Team-Token";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (request.getHeader(TOKEN_HEADER) == null || path.startsWith("/teamboards/")) {
            chain.doFilter(request, response);
            return;
        }
        chain.doFilter(new WithoutToken(request), response);
    }

    /** The request with the token header gone. */
    static final class WithoutToken extends HttpServletRequestWrapper {
        WithoutToken(HttpServletRequest request) {
            super(request);
        }

        private static boolean isToken(String name) {
            return TOKEN_HEADER.equalsIgnoreCase(name);
        }

        @Override
        public String getHeader(String name) {
            return isToken(name) ? null : super.getHeader(name);
        }

        @Override
        public Enumeration<String> getHeaders(String name) {
            return isToken(name) ? Collections.emptyEnumeration() : super.getHeaders(name);
        }

        @Override
        public Enumeration<String> getHeaderNames() {
            List<String> names = Collections.list(super.getHeaderNames());
            names.removeIf(WithoutToken::isToken);
            return Collections.enumeration(names);
        }
    }
}
