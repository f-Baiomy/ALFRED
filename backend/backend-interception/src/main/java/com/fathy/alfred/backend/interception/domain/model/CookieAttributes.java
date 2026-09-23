package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The attributes SET_RESPONSE_COOKIE writes after {@code name=value} on the Set-Cookie line. Every
 * one is optional; {@code maxAge = 0} expires the cookie, which is how "log the user out" is
 * expressed without a separate action.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CookieAttributes(String path, String domain, Integer maxAge, Boolean secure, Boolean httpOnly,
                               String sameSite) {
}
