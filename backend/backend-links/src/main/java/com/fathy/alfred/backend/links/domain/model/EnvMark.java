package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * An environment Alfred's own mark on one of the host board's requirements (D36), kept on the environment Alfred and
 * read by the host. {@code mark} is PASS, FAIL or CANT_TELL like the board's own; {@code history} is JSON.
 */
public record EnvMark(String hostLinkId, String boardId, String fileName, String itemKey, String mark, String evidence, String actor,
                      Instant at, String history) {
}
