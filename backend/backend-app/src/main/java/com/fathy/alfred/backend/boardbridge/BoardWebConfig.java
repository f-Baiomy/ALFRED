package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.BoardOfUseCase;
import com.fathy.alfred.backend.server.adapter.in.web.EditAccessInterceptor;
import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.sessions.adapter.in.web.AdminRequestCheck;
import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.SessionsUseCase;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Puts the board's edit rule in front of every /board and /teamboards write, and tells the page whether it may edit (GET
 * /board/access). Behind it, the board lock (specs/031) - when the sessions slice is in the build.
 */
@Configuration
@RestController
public class BoardWebConfig implements WebMvcConfigurer {

    private final BoardEditAccess access;
    private final ObjectProvider<EditAccessUseCase> editAccess;
    private final ObjectProvider<BoardOfUseCase> boardOf;
    private final ObjectProvider<KeysUseCase> keys;
    private final ObjectProvider<HoldersUseCase> holders;
    private final ObjectProvider<SessionsUseCase> sessions;

    public BoardWebConfig(ObjectProvider<EditAccessUseCase> editAccess, ObjectProvider<BoardOfUseCase> boardOf, ObjectProvider<KeysUseCase> keys,
                          ObjectProvider<HoldersUseCase> holders, ObjectProvider<SessionsUseCase> sessions) {
        this.access = new BoardEditAccess(editAccess);
        this.editAccess = editAccess;
        this.boardOf = boardOf;
        this.keys = keys;
        this.holders = holders;
        this.sessions = sessions;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // specs/027: the Team tab's writes (connections, mappings, starts) follow the same rule - never the tunnel. The one
        // exception (specs/028 FR-082) is the tracker's service hook, which proves itself with its own secret.
        registry.addInterceptor(new BoardEditAccessInterceptor(access)).addPathPatterns("/board/**", "/teamboards/**")
                .excludePathPatterns("/teamboards/hooks/**");
        BoardOfUseCase of = boardOf.getIfAvailable();
        KeysUseCase k = keys.getIfAvailable();
        HoldersUseCase h = holders.getIfAvailable();
        SessionsUseCase s = sessions.getIfAvailable();
        if (of != null && k != null && h != null && s != null) {
            registry.addInterceptor(new BoardLockInterceptor(new BoardWriteTargets(of), k, h, s)).addPathPatterns("/board/**");
        }
    }

    @Bean
    public FilterRegistrationBean<BoardBodyCachingFilter> boardBodyCachingFilter() {
        FilterRegistrationBean<BoardBodyCachingFilter> bean = new FilterRegistrationBean<>(new BoardBodyCachingFilter());
        bean.addUrlPatterns("/board/*");
        return bean;
    }

    /** The server admin of specs/031 is whoever may change the server's settings - never the tunnel. */
    @Bean
    public AdminRequestCheck boardAdminCheck() {
        return request -> {
            EditAccessUseCase rule = editAccess.getIfAvailable();
            return rule != null && !BoardEditAccess.viaTunnel(request) && EditAccessInterceptor.check(request, rule).allowed();
        };
    }

    @GetMapping("/board/access")
    public BoardEditAccess.Decision boardAccess(HttpServletRequest request) {
        return access.decide(request);
    }
}
