package com.fathy.alfred.backend.links.domain.model;

/** This Alfred as others see it: a stable id, the name it announces on the LAN, and whether it announces at all (D33). */
public record Self(String alfredId, String name, boolean announce, String version) {
}
