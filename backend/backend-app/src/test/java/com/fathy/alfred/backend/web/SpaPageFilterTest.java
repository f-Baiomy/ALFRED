package com.fathy.alfred.backend.web;

import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

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
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/board/page/p-123", HTML)).isTrue();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/board/page/p-123", JSON)).isFalse();
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/board/pages", HTML)).isFalse();
    }

    @Test
    void theLibraryShelfAllowsAnyOriginAndServesModulesAsJavaScriptLikeTheFrontendsNginx() throws IOException {
        String frontendNginx = Files.readString(Path.of("..", "..", "frontend", "nginx.conf"));
        assertThat(frontendNginx).contains("location ^~ " + SpaPageFilter.LIB).contains("Access-Control-Allow-Origin \"*\"")
                .contains("text/javascript js mjs;");

        MockHttpServletResponse plain = new MockHttpServletResponse();
        SpaPageFilter.libResponse("/lib/d3/7/d3.min.js", plain);
        assertThat(plain.getHeader("Access-Control-Allow-Origin")).isEqualTo("*");

        MockHttpServletResponse module = new MockHttpServletResponse();
        HttpServletResponse wrapped = SpaPageFilter.libResponse("/lib/tailwind/4/index.mjs", module);
        wrapped.setContentType("application/octet-stream");
        assertThat(module.getContentType()).isEqualTo("text/javascript");
        assertThat(SpaPageFilter.forwardsToIndex("GET", "/lib/nothing/1/x.js", JSON)).isTrue();

        // Python for snippets: the wasm is streamed only as application/wasm, the packages are zips - as nginx serves them
        assertThat(frontendNginx).contains("application/wasm wasm;").contains("application/zip zip whl;");
        MockHttpServletResponse wasm = new MockHttpServletResponse();
        SpaPageFilter.libResponse("/lib/pyodide/0.27/pyodide.asm.wasm", wasm).setContentType("application/octet-stream");
        assertThat(wasm.getContentType()).isEqualTo("application/wasm");
        MockHttpServletResponse whl = new MockHttpServletResponse();
        SpaPageFilter.libResponse("/lib/pyodide/0.27/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl", whl).setContentType("application/octet-stream");
        assertThat(whl.getContentType()).isEqualTo("application/zip");
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
