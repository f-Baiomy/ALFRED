package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.boardbridge.BoardEditAccess;
import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
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
import java.util.Set;

/**
 * Links are LAN only, never the tunnel (D3): every /links route and both link sockets are refused through it, reads
 * included. Changing links, streams, requests and environments follows the board's edit rule (cards are data; so are
 * these). The two routes another Alfred calls while pairing, and its hello, are open to the LAN - the offer proves
 * itself with its nonce, and nothing comes of it until someone here accepts.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class LinksAccessFilter extends OncePerRequestFilter {

    static final Set<String> OPEN = Set.of("/links/hello", "/links/pair/offers");

    private final BoardEditAccess access;

    public LinksAccessFilter(ObjectProvider<EditAccessUseCase> editAccess) {
        this.access = new BoardEditAccess(editAccess);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return !(path.equals("/links") || path.startsWith("/links/") || path.equals("/ws/links") || path.startsWith("/ws/links/"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (BoardEditAccess.viaTunnel(request)) {
            deny(response, "TUNNEL", "Links between Alfreds work on the LAN only - never through the shared tunnel link");
            return;
        }
        String path = request.getRequestURI().substring(request.getContextPath().length());
        String method = request.getMethod();
        boolean write = !"GET".equals(method) && !"HEAD".equals(method) && !"OPTIONS".equals(method);
        boolean peerCall = OPEN.contains(path) || path.matches("/links/pair/offers/[^/]+/wait");
        boolean relayed = request.getHeader(Loopback.TOKEN_HEADER) != null; // checked by RelayLoopbackFilter
        if (write && !peerCall && !relayed && !path.startsWith("/ws/")) {
            BoardEditAccess.Decision d = access.decide(request);
            if (!d.editable()) {
                deny(response, "READ_ONLY", d.howToEdit() == null || d.howToEdit().isBlank()
                        ? "This page cannot change links" : d.howToEdit());
                return;
            }
        }
        chain.doFilter(request, response);
    }

    private static void deny(HttpServletResponse response, String code, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write("{\"error\":\"" + code + "\",\"message\":\"" + message.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}");
    }
}
