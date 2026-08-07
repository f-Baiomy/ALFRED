package com.alfred.pennyworth.domain.model;

/** Best-effort metadata extracted from a call, for pre-filling the frontend's export-as-Markdown form. Any field the source data doesn't contain comes back null - the frontend leaves those inputs empty and editable rather than guessing. */
public record ExportMetadata(
        String supplierName,
        String credentialsUsed,
        String apiKey,
        String url
) {
}
