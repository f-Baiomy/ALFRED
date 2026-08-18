package com.fathy.alfred.backend.internalcalls.domain.model;

/** The part of a CallRecord a list view omits - full request/response headers and bodies, fetched only once a call is actually expanded. */
public record CallDetail(RequestData request, ResponseData response) {

    public static CallDetail of(CallRecord call) {
        return new CallDetail(call.request(), call.response());
    }
}
