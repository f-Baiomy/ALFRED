package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.links.domain.Mac;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * How this Alfred answers a linked Alfred's read: through its own routes on 127.0.0.1, marked with a token that never
 * leaves this process (so nothing outside can claim to be a relayed read), with the link and hops it is for.
 */
@Component
public class Loopback {

    static final String TOKEN_HEADER = "X-Alfred-Relay";
    static final String LINK_HEADER = "X-Alfred-Relay-Link";
    static final String HOPS_HEADER = "X-Alfred-Relay-Hops";
    static final String READER_HEADER = "X-Alfred-Relay-Reader";

    private final String token = Mac.random(32);
    private volatile int port = 5000;

    @EventListener
    public void started(WebServerInitializedEvent event) {
        if (event.getApplicationContext().getServerNamespace() == null) {
            port = event.getWebServer().getPort();
        }
    }

    String token() {
        return token;
    }

    int port() {
        return port;
    }

    String base() {
        return "http://127.0.0.1:" + port;
    }
}
