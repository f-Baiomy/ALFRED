package com.fathy.alfred.backend.triage.domain.model;

/**
 * A response that says it worked (status under 400) while its body says it did not - see
 * {@link com.fathy.alfred.backend.triage.domain.SoftFailures}.
 *
 * @param kind    soap-fault | xml-error | json-errors | json-success-false | json-error
 * @param code    the supplier's own code when it gives one ("322"), else null
 * @param message its message, shortened to 200 characters - never the whole body
 */
public record SoftFailure(String kind, String code, String message) {
}
