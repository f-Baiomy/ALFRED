package com.fathy.alfred.backend.web;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The native install's routing (SpaPageFilter) and the Docker install's (gateway/nginx.conf) must make the same
 * decision for every path: this reads the nginx file and compares (analysis D2 / research R5).
 */
class SpaPageFilterTest {

    private static final Path NGINX = Path.of("..", "..", "gateway", "nginx.conf");
    private static final String HTML = "text/html,application/xhtml+xml";
    private static final String JSON = "application/json, text/plain, */*";

    @Test
    void theApiPrefixesAreExactlyTheGatewaysRegex() throws IOException {
        Matcher location = Pattern.compile("location ~ \\^/\\(([^)]+)\\)\\(/\\|\\$\\)").matcher(Files.readString(NGINX));
        assertThat(location.find()).as("API location regex in gateway/nginx.conf").isTrue();
        assertThat(Arrays.asList(location.group(1).split("\\|"))).containsExactlyElementsOf(SpaPageFilter.API_PREFIXES);
    }

    @Test
    void theSpaPagesAreExactlyTheGatewaysSpaPageMap() throws IOException {
        String nginx = Files.readString(NGINX);
        String map = nginx.substring(nginx.indexOf("$spa_page {"), nginx.indexOf('}', nginx.indexOf("$spa_page {")));
        List<String> paths = new ArrayList<>();
        Matcher entry = Pattern.compile("\"~(\\^[^\"]*?)\\\\\\|\\.\\*text/html\"").matcher(map);
        while (entry.find()) {
            paths.add(entry.group(1) + "$");
        }
        assertThat(paths).containsExactlyElementsOf(SpaPageFilter.SPA_PAGE_PATTERNS);
    }

    @Test
    void apiCallsGoToTheApiAndPageLoadsOfSharedPrefixesGetTheSpa() {
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/calls", JSON)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/calls", HTML)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/settings", JSON)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/settings", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/settings/variables", HTML)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/logs/sources/x", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/logs/sources/x", JSON)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("POST", "/settings", HTML)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/server/settings", JSON)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("POST", "/mcp", JSON)).isFalse();
    }

    @Test
    void unknownDeepLinksGetTheSpaAndTheSocketIsLeftAlone() {
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/session-cyclesX/abc", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/relive/abc", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/ws/calls", HTML)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/index.html", HTML)).isFalse();
    }
}
