package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * One project reverse-proxy fronts, joined with its live logging on/off state. Callers reach the
 * project on {@code listenPort} (Alfred's own port for it) and Alfred forwards to
 * {@code upstreamPort} (the project's own, unchanged port). Both are {@code null} for the
 * reserved "unknown" entry, which only ever catches a flow arriving on an unconfigured port.
 * {@code enabled} is independent per name; forwarding is never affected by it either way. The
 * wire shape matches exactly, so this is returned directly from the controller rather than
 * duplicated into a separate DTO.
 */
public record InternalCallService(String name, Integer listenPort, Integer upstreamPort, boolean enabled) {
}
