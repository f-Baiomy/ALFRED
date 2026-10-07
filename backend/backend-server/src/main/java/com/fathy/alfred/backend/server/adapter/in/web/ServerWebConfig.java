package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Puts {@link EditAccessInterceptor} in front of every /server/** request except the supervisor's webhook. */
@Configuration
public class ServerWebConfig implements WebMvcConfigurer {

    private final ObjectProvider<EditAccessUseCase> editAccess;

    public ServerWebConfig(ObjectProvider<EditAccessUseCase> editAccess) {
        this.editAccess = editAccess;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new EditAccessInterceptor(editAccess::getObject))
                .addPathPatterns("/server/**")
                .excludePathPatterns("/server/supervisor-events");
    }
}
