package com.fathy.alfred.backend.teamboardsbridge;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.boardbridge.BoardEditAccess;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * The token lives in the backend's memory (specs/028 R1), so a live tracker read made through the shared tunnel link
 * would read with the owner's token for whoever holds the link. Live reads (search, query, items, attachments, a person,
 * Mine) are refused through the tunnel; what Alfred keeps (connections, lists, a board's Related items) stays readable.
 * Writes are refused there already by the edit rule; the service hook is the one route the tunnel forwards.
 */
@Configuration
public class TeamTunnelGuard implements WebMvcConfigurer, HandlerInterceptor {

    private final ObjectMapper json = new ObjectMapper();

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/teamboards/connections/*/search", "/teamboards/connections/*/query",
                "/teamboards/connections/*/items/**", "/teamboards/connections/*/items", "/teamboards/connections/*/people/*",
                "/teamboards/connections/*/people", "/teamboards/connections/*/lists", "/teamboards/connections/*/lists/refresh",
                "/teamboards/connections/*/mine", "/teamboards/items/*/*/seed", "/teamboards/items/*/*/target",
                "/teamboards/writes/*/check"); // specs/034: the live check of a bundle reads the tracker too
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
        if (!BoardEditAccess.viaTunnel(request)) {
            return true;
        }
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(json.writeValueAsString(Map.of("error", "TUNNEL",
                "message", "Live reads from the tracker use the owner's token, so the shared tunnel link cannot make them")));
        return false;
    }
}
