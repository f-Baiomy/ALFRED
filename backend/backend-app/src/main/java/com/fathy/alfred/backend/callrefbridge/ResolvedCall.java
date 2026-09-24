package com.fathy.alfred.backend.callrefbridge;

import java.util.Map;

/**
 * A slice-neutral view of one logged call, live or captured in a session cycle, either direction -
 * what CallRefResolver hands the bridges so each one projects only the half its port needs
 * (interceptionbridge the response, resendbridge the request).
 *
 * @param direction      "outbound" or "inbound".
 * @param cycleId        the session cycle it was captured in, or null for a live call.
 * @param method         from the call's list summary; null if the summary lookup did not find it.
 * @param url            from the call's list summary; null if the summary lookup did not find it.
 * @param serviceName    the internal project name (inbound), or null for an outbound call.
 * @param timestamp      from the call's list summary; null if the summary lookup did not find it.
 * @param requestHeaders never null; empty when the call recorded no request.
 * @param responseStatus null while the call is still in flight, or if it failed without a response.
 * @param responseHeaders never null; empty when the call has no response.
 */
public record ResolvedCall(String direction, String id, String cycleId, String method, String url,
                           String serviceName, String timestamp,
                           Map<String, String> requestHeaders, String requestBody,
                           Integer responseStatus, Map<String, String> responseHeaders, String responseBody) {

    public ResolvedCall {
        // Not copied: a logged header map may hold null names/values, which Map.copyOf rejects -
        // each bridge decides how to treat those, exactly as it did before this resolver existed.
        requestHeaders = requestHeaders == null ? Map.of() : requestHeaders;
        responseHeaders = responseHeaders == null ? Map.of() : responseHeaders;
    }
}
