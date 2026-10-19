package com.fathy.alfred.backend.links.application.port.in;

/**
 * A read could not be sent: the link is unknown, removed or offline (D21 - a state, said as such), or the other Alfred
 * refused it. {@code code} is what the page shows: OFFLINE, UNKNOWN_LINK, NOT_STREAMED, TOO_FAR, LOOP, UNSUPPORTED, BUSY.
 */
public class LinkUnavailableException extends RuntimeException {

    private final String code;
    private final String slug;

    public LinkUnavailableException(String code, String slug, String message) {
        super(message);
        this.code = code;
        this.slug = slug;
    }

    public String code() {
        return code;
    }

    public String slug() {
        return slug;
    }
}
