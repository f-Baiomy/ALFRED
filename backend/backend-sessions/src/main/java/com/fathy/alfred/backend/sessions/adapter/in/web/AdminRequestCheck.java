package com.fathy.alfred.backend.sessions.adapter.in.web;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Is this request the server admin's (specs/031)? backend-app answers with the server settings' own edit rule - whoever may
 * change the server's settings may revoke a user's key or force a board free. Without that bean only a direct request from
 * this machine (loopback, nothing forwarded) is the admin.
 */
public interface AdminRequestCheck {

    boolean admin(HttpServletRequest request);
}
