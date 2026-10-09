package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Guards every write under /server/** (FR-050..052): the server decides, not the UI. Reads stay open to anyone who can
 * open the UI. /server/supervisor-events is excluded - it is checked by the webhook secret instead. A refused write
 * becomes 403 through {@link ServerExceptionHandler}, with the reason and how to reach Alfred with edit rights.
 */
public class EditAccessInterceptor implements HandlerInterceptor {

    private final Supplier<EditAccessUseCase> editAccess;

    public EditAccessInterceptor(Supplier<EditAccessUseCase> editAccess) {
        this.editAccess = editAccess;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String method = request.getMethod();
        if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
            return true;
        }
        EditAccess access = check(request, editAccess.get());
        if (!access.allowed() && dockerAttach(request, access)) {
            return true;
        }
        if (!access.allowed()) {
            throw new EditNotAllowedException(access);
        }
        return true;
    }

    /**
     * Docker refuses every server write because its settings live in .env and apply with restart.py. Attaching the
     * agent changes no setting - it asks the agent host on the machine, like the ◆ switch and the capture settings,
     * which Docker does not guard either - so it is let through, except from the Cloudflare tunnel.
     */
    static boolean dockerAttach(HttpServletRequest request, EditAccess access) {
        if (access.reason() != EditAccess.Reason.DOCKER_MODE || !"/server/agents/attach".equals(request.getRequestURI())) {
            return false;
        }
        return Collections.list(request.getHeaderNames()).stream()
                .noneMatch(h -> com.fathy.alfred.backend.server.domain.model.AccessRule.TUNNEL_HEADERS.contains(h.toLowerCase(java.util.Locale.ROOT)));
    }

    /** The TCP peer (getRemoteAddr - never X-Forwarded-For) and the request's header names. */
    public static EditAccess check(HttpServletRequest request, EditAccessUseCase editAccess) {
        Set<String> headerNames = new HashSet<>(Collections.list(request.getHeaderNames()));
        return editAccess.access(request.getRemoteAddr(), headerNames);
    }

    /** A write refused by the access rule. */
    public static class EditNotAllowedException extends RuntimeException {
        private final EditAccess access;

        public EditNotAllowedException(EditAccess access) {
            super("Server settings can't be changed from here: " + access.reason());
            this.access = access;
        }

        public EditAccess access() {
            return access;
        }
    }
}
