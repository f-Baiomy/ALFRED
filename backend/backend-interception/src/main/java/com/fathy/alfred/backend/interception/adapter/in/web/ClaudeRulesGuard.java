package com.fathy.alfred.backend.interception.adapter.in.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.IOException;
import java.util.Locale;

/**
 * What Claude (X-Alfred-Actor: claude, sent by the MCP) may do to interception: read anything, and PROPOSE a rule
 * (POST /interception/rules, saved off; and POST /interception/answers/from-call for an answer it uses). Switching rules or interception on and off, editing, deleting, reordering,
 * importing, stored answers and paused calls are the user's - refused here with 403, whatever a request asks.
 */
@Configuration
public class ClaudeRulesGuard implements WebMvcConfigurer, HandlerInterceptor {

    static final String ACTOR_HEADER = "X-Alfred-Actor";
    static final String REFUSED = "Claude only proposes interception rules (create_rule, saved off). Switching rules or interception on "
            + "and off, editing, deleting, reordering, importing, stored answers and paused calls are the user's.";

    static boolean isClaude(String actor) {
        return actor != null && actor.strip().toLowerCase(Locale.ROOT).equals("claude");
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/interception/**");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
        if (!isClaude(request.getHeader(ACTOR_HEADER)) || HttpMethod.GET.matches(request.getMethod())) {
            return true;
        }
        String path = request.getRequestURI().substring(request.getContextPath().length());
        // A proposal, and the stored answer a proposed ANSWER_WITH_RECORDED_CALL rule needs (secrets always stripped).
        if (HttpMethod.POST.matches(request.getMethod()) && (path.equals("/interception/rules") || path.equals("/interception/answers/from-call"))) {
            return true;
        }
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("{\"error\":\"refused-for-claude\",\"message\":\"" + REFUSED + "\"}");
        return false;
    }
}
