package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.links.domain.Mac;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;

/**
 * A relayed read arrives here on 127.0.0.1 with this process's own token: it is a read only (never a write, whatever it
 * says), and while it is answered {@link RelayContext} holds the link and hops it is for. A request claiming to be
 * relayed without the token is refused - nothing outside this process can borrow a stream's rights.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class RelayLoopbackFilter extends OncePerRequestFilter {

    /** Absent only in a sliced test context, where nothing is ever relayed: every claimed relay is refused then. */
    private final ObjectProvider<Loopback> loopback;

    public RelayLoopbackFilter(ObjectProvider<Loopback> loopback) {
        this.loopback = loopback;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String token = request.getHeader(Loopback.TOKEN_HEADER);
        if (token == null) {
            chain.doFilter(request, response);
            return;
        }
        String peer = request.getRemoteAddr();
        boolean loop = "127.0.0.1".equals(peer) || "0:0:0:0:0:0:0:1".equals(peer) || "::1".equals(peer);
        Loopback own = loopback.getIfAvailable();
        if (!loop || own == null || !Mac.same(token, own.token())) {
            response.sendError(HttpServletResponse.SC_FORBIDDEN, "Not a relayed read");
            return;
        }
        String method = request.getMethod();
        String path = request.getRequestURI().substring(request.getContextPath().length());
        boolean read = "GET".equals(method)
                || "POST".equals(method) && StreamRoutes.ROUTES.stream().anyMatch(r -> r.post() && r.path().matcher(StreamRoutes.decodePath(path)).matches());
        if (!read) {
            response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED, "A stream answers reads only");
            return;
        }
        String hops = request.getHeader(Loopback.HOPS_HEADER);
        List<String> hopList = hops == null || hops.isBlank() ? List.of() : Arrays.stream(hops.split(",")).map(String::trim).toList();
        RelayContext.set(new RelayContext.Current(request.getHeader(Loopback.LINK_HEADER), hopList, request.getHeader(Loopback.READER_HEADER)));
        try {
            chain.doFilter(request, response);
        } finally {
            RelayContext.clear();
        }
    }
}
