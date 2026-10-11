package com.fathy.alfred.backend.interception.adapter.in.web;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

class ClaudeRulesGuardTest {

    private final ClaudeRulesGuard guard = new ClaudeRulesGuard();

    private MockHttpServletResponse call(String method, String path, String actor) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        if (actor != null) {
            request.addHeader("X-Alfred-Actor", actor);
        }
        MockHttpServletResponse response = new MockHttpServletResponse();
        boolean passed = guard.preHandle(request, response, new Object());
        if (passed) {
            response.setStatus(200);
        }
        return response;
    }

    @Test
    void claudeMayReadEverythingAndProposeARule() throws Exception {
        assertThat(call("GET", "/interception/rules", "claude").getStatus()).isEqualTo(200);
        assertThat(call("GET", "/interception/action-types", "claude").getStatus()).isEqualTo(200);
        assertThat(call("POST", "/interception/rules", "claude").getStatus()).isEqualTo(200);
    }

    @Test
    void everyOtherWriteIsTheUsers() throws Exception {
        for (String[] write : new String[][]{
                {"POST", "/interception/rules/r1/enabled"}, {"POST", "/interception/enabled"}, {"PUT", "/interception/rules/r1"},
                {"DELETE", "/interception/rules/r1"}, {"POST", "/interception/rules/reorder"}, {"POST", "/interception/rules/import"},
                {"POST", "/interception/paused/p1/release"}}) {
            MockHttpServletResponse response = call(write[0], write[1], "Claude");
            assertThat(response.getStatus()).as(write[0] + " " + write[1]).isEqualTo(403);
            assertThat(response.getContentAsString()).contains("refused-for-claude");
        }
    }

    @Test
    void theUserIsNeverStopped() throws Exception {
        assertThat(call("POST", "/interception/rules/r1/enabled", null).getStatus()).isEqualTo(200);
        assertThat(call("DELETE", "/interception/rules/r1", "user").getStatus()).isEqualTo(200);
    }
}
