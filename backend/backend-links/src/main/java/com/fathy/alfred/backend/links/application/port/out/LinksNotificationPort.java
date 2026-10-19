package com.fathy.alfred.backend.links.application.port.out;

/**
 * Tells this Alfred's open pages that something about links changed (/ws/links): a link, an offer, a stream, a request -
 * or a signal from a linked Alfred, so pages showing its data fetch again. No polling.
 */
public interface LinksNotificationPort {

    /** {@code type} is links-changed, offers-changed, pairings-changed, streams-changed, requests-changed, presence-changed, env-changed. */
    void changed(String type, String json);

    /** A linked Alfred's signal, for pages showing its data: {@code slug} is the link it came over. */
    void signal(String slug, String channel, String json);
}
