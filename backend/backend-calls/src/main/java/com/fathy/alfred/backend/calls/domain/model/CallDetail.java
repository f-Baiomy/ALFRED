package com.fathy.alfred.backend.calls.domain.model;

/** The part of a CallRecord a list view omits - full request/response headers and bodies, fetched only once a call is actually expanded. */
public record CallDetail(RequestData request, ResponseData response) {

    public static CallDetail of(CallRecord call) {
        return new CallDetail(call.request(), call.response());
    }

    /**
     * Narrows this detail to a single part, for a client that expanded one block and has no use for
     * the other three (see GET /calls/{id}/detail's {@code part} param). Purely a projection of what
     * was already read: every adapter loads the whole record either way, so this saves transfer
     * size - which is the part that actually hurts, since one response body routinely dwarfs all
     * the headers put together - not backend work.
     *
     * An unrecognised or blank part returns the whole detail, so a client that doesn't know about
     * this parameter (or gets it wrong) degrades to the pre-existing behaviour rather than an error.
     * The response's status is kept on both response parts: it costs nothing and it's what tells a
     * caller the response half exists at all.
     */
    public CallDetail part(String part) {
        if (part == null) {
            return this;
        }
        return switch (part) {
            case "request-headers" -> new CallDetail(request == null ? null : new RequestData(request.headers(), null), null);
            case "request-body" -> new CallDetail(request == null ? null : new RequestData(null, request.body()), null);
            case "response-headers" -> new CallDetail(null, response == null ? null : new ResponseData(response.status(), response.headers(), null));
            case "response-body" -> new CallDetail(null, response == null ? null : new ResponseData(response.status(), null, response.body()));
            default -> this;
        };
    }
}
