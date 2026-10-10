package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.server.adapter.in.web.EditAccessInterceptor;
import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.ObjectProvider;

import java.util.Collections;
import java.util.Locale;

/**
 * Who may edit the board (FR-049, research R10): the same rule as server settings, except that Docker - which refuses
 * every settings write because its settings live in .env - lets board edits through, since cards are data, not
 * settings. The Cloudflare tunnel is read-only either way. Built by BoardWebConfig rather than scanned, so a web-slice
 * test that loads the MVC configuration gets it too.
 */
public class BoardEditAccess {

    /** What the board page needs to know: may this viewer edit, and if not, why and how to. */
    public record Decision(boolean editable, String reason, String howToEdit) {
    }

    private final ObjectProvider<EditAccessUseCase> editAccess;

    public BoardEditAccess(ObjectProvider<EditAccessUseCase> editAccess) {
        this.editAccess = editAccess;
    }

    public Decision decide(HttpServletRequest request) {
        EditAccessUseCase rule = editAccess.getIfAvailable();
        if (rule == null) {
            return new Decision(true, "LOCAL", "");
        }
        EditAccess access = EditAccessInterceptor.check(request, rule);
        if (access.allowed()) {
            return new Decision(true, access.reason().name(), "");
        }
        if (access.reason() == EditAccess.Reason.DOCKER_MODE && !viaTunnel(request)) {
            return new Decision(true, access.reason().name(), "");
        }
        boolean tunnel = viaTunnel(request);
        return new Decision(false, tunnel ? EditAccess.Reason.TUNNEL.name() : access.reason().name(),
                tunnel ? "The shared tunnel link is view-only. Open Alfred on its own machine to change the board." : access.howToEdit());
    }

    static boolean viaTunnel(HttpServletRequest request) {
        return Collections.list(request.getHeaderNames()).stream()
                .anyMatch(h -> AccessRule.TUNNEL_HEADERS.contains(h.toLowerCase(Locale.ROOT)));
    }
}
