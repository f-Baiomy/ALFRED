package com.fathy.alfred.backend.teamboardsbridge;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * specs/027 SC-007: the viewer's tracker token reaches only the /teamboards routes. Everything else - the MCP relay,
 * the board, every log or error path - sees the request without it. (That teamboards.db never holds it is
 * TeamServiceTest's "the token is never stored".)
 */
class TeamTokenNeverStoredTest {

    private static final String TOKEN = "pat-very-secret-1234567890";

    private static HttpServletRequest pass(String path) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path);
        request.addHeader(TeamTokenLogFilter.TOKEN_HEADER, TOKEN);
        request.addHeader("Accept", "application/json");
        AtomicReference<HttpServletRequest> seen = new AtomicReference<>();
        new TeamTokenLogFilter().doFilter(request, new MockHttpServletResponse(),
                new MockFilterChain(new jakarta.servlet.http.HttpServlet() {
                    @Override
                    protected void service(HttpServletRequest req, jakarta.servlet.http.HttpServletResponse res) {
                        seen.set(req);
                    }
                }));
        return seen.get();
    }

    @Test
    void theTeamboardsRoutesGetTheToken() throws Exception {
        assertThat(pass("/teamboards/connections/c1/refresh").getHeader(TeamTokenLogFilter.TOKEN_HEADER)).isEqualTo(TOKEN);
    }

    @Test
    void everyOtherRouteSeesNoToken() throws Exception {
        for (String path : new String[] {"/mcp", "/board/cards", "/calls", "/teamboardsx/y", "/settings"}) {
            HttpServletRequest seen = pass(path);
            assertThat(seen.getHeader(TeamTokenLogFilter.TOKEN_HEADER)).as(path).isNull();
            assertThat(seen.getHeader("x-alfred-team-token")).as(path).isNull();
            assertThat(Collections.list(seen.getHeaders(TeamTokenLogFilter.TOKEN_HEADER))).as(path).isEmpty();
            assertThat(Collections.list(seen.getHeaderNames())).as(path)
                    .noneMatch(n -> n.equalsIgnoreCase(TeamTokenLogFilter.TOKEN_HEADER)).contains("Accept");
        }
    }
}
