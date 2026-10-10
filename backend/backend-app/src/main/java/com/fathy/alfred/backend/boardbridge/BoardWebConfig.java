package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Puts the board's edit rule in front of every /board write, and tells the page whether it may edit (GET /board/access). */
@Configuration
@RestController
public class BoardWebConfig implements WebMvcConfigurer {

    private final BoardEditAccess access;

    public BoardWebConfig(ObjectProvider<EditAccessUseCase> editAccess) {
        this.access = new BoardEditAccess(editAccess);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new BoardEditAccessInterceptor(access)).addPathPatterns("/board/**");
    }

    @GetMapping("/board/access")
    public BoardEditAccess.Decision boardAccess(HttpServletRequest request) {
        return access.decide(request);
    }
}
