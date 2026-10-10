package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** FR-049: the board follows the settings access rule, except that Docker lets board edits through; the tunnel never. */
class BoardEditAccessInterceptorTest {

    @SuppressWarnings("unchecked")
    private static BoardEditAccessInterceptor interceptor(EditAccess decision) {
        EditAccessUseCase rule = mock(EditAccessUseCase.class);
        when(rule.access(anyString(), any())).thenReturn(decision);
        ObjectProvider<EditAccessUseCase> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(rule);
        return new BoardEditAccessInterceptor(new BoardEditAccess(provider));
    }

    private static boolean allows(BoardEditAccessInterceptor interceptor, MockHttpServletRequest request, MockHttpServletResponse response)
            throws Exception {
        return interceptor.preHandle(request, response, new Object());
    }

    @Test
    void readsAlwaysPass() throws Exception {
        BoardEditAccessInterceptor refusing = interceptor(new EditAccess(false, EditAccess.Reason.NOT_LISTED, "8.8.8.8", "no"));

        assertThat(allows(refusing, new MockHttpServletRequest("GET", "/board/cards"), new MockHttpServletResponse())).isTrue();
    }

    @Test
    void aLocalWritePasses() throws Exception {
        BoardEditAccessInterceptor local = interceptor(new EditAccess(true, EditAccess.Reason.LOCAL, "127.0.0.1", ""));

        assertThat(allows(local, new MockHttpServletRequest("POST", "/board/cards"), new MockHttpServletResponse())).isTrue();
    }

    @Test
    void dockerLetsBoardWritesThrough() throws Exception {
        BoardEditAccessInterceptor docker = interceptor(new EditAccess(false, EditAccess.Reason.DOCKER_MODE, "172.18.0.5", "restart.py"));

        assertThat(allows(docker, new MockHttpServletRequest("PATCH", "/board/cards/x"), new MockHttpServletResponse())).isTrue();
    }

    @Test
    void theTunnelIsViewOnlyEvenInDocker() throws Exception {
        BoardEditAccessInterceptor docker = interceptor(new EditAccess(false, EditAccess.Reason.DOCKER_MODE, "172.18.0.5", "restart.py"));
        MockHttpServletRequest viaTunnel = new MockHttpServletRequest("POST", "/board/cards");
        viaTunnel.addHeader("Cf-Ray", "abc");
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertThat(allows(docker, viaTunnel, response)).isFalse();
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentAsString()).contains("edit-not-allowed").contains("TUNNEL");
    }

    @Test
    void aWriteFromAnAddressNotListedIsRefused() throws Exception {
        BoardEditAccessInterceptor refusing = interceptor(new EditAccess(false, EditAccess.Reason.NOT_LISTED, "8.8.8.8", "Open Alfred..."));
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertThat(allows(refusing, new MockHttpServletRequest("DELETE", "/board/cards/x"), response)).isFalse();
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentAsString()).contains("Open Alfred...");
    }
}
