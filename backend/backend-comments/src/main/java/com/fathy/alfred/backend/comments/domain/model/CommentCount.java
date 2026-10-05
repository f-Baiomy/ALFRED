package com.fathy.alfred.backend.comments.domain.model;

import java.util.Map;

/**
 * How many comments one call has, and on which part: {@code byBlock} is keyed by the comment's
 * block (call, request-headers, request-body, response-headers, response-body). What the list's
 * comment badge and the block chips show, without loading a single comment's text.
 */
public record CommentCount(int total, Map<String, Integer> byBlock) {
}
