package com.fathy.alfred.backend.teamboards.core.application.port.out;

import java.util.Optional;

/**
 * Who is asking, when a user's paired browser or helper sent the request (specs/031): their tracker token is their own -
 * entered by them, used for their searches and writes only, never read by another user. Empty outside a request (background
 * work) or for an unpaired caller. Implemented by backend-app/teamboardsbridge from the request's X-Alfred-Key.
 */
public interface TeamCallerPort {

    Optional<String> user();
}
