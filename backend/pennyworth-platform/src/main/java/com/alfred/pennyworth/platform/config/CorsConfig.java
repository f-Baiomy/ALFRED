package com.alfred.pennyworth.platform.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Origins default to "*" (permissive) so the current single-team deployment keeps working out of
 * the box regardless of which port the frontend happens to run on, but a real deployment can
 * tighten this with one env var - no code change needed:
 *
 *   ALFRED_CORS_ALLOWED_ORIGINS=https://manor.example.com,https://manor-staging.example.com
 */
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"))
                .allowedMethods("*")
                .allowedHeaders("*");
    }
}
