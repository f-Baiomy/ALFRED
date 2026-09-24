package com.fathy.alfred.backend.resend.adapter.in.web.dto;

/**
 * POST /resend's optional {@code batch} - see contracts/rest-api.md. Its limits (id non-blank and
 * at most 64 characters, {@code 1 <= index <= total <= 1000}) are checked in ResendController,
 * since {@code index <= total} is a cross-field rule.
 */
public record ResendBatchDto(String id, Integer index, Integer total) {
}
