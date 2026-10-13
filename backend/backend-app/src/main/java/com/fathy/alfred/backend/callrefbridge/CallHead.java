package com.fathy.alfred.backend.callrefbridge;

/**
 * What a call's list summary says of it - method, url and the status it answered with - and nothing of its headers or
 * bodies. {@code status} is null while the call is in flight or if it failed without a response.
 */
public record CallHead(String method, String url, Integer status) {
}
