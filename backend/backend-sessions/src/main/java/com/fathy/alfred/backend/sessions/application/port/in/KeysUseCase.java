package com.fathy.alfred.backend.sessions.application.port.in;

import com.fathy.alfred.backend.sessions.domain.model.BrowserKey;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.Issued;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Who is who (specs/031). Alfred has no logins: a user is the email their helper registered with, and every browser that
 * writes as them was paired with that helper by a one-time code. The secret is shown once and kept only as a hash.
 */
public interface KeysUseCase {

    /** A helper on {@code machine} for {@code user}: a new key; the user's older helper on that machine is revoked. */
    default Issued registerHelper(String user, String machine, String claudeAccount, String ip) {
        return registerHelper(user, machine, claudeAccount, ip, null);
    }

    default Issued registerHelper(String user, String machine, String claudeAccount, String ip, String connectToken) {
        return registerHelper(user, machine, "", claudeAccount, ip, connectToken);
    }

    /**
     * A helper for {@code user} on {@code machine}, run by the OS user {@code osUser}: a new key; the user's older helper
     * of that same OS user on that machine is revoked (a re-install or a repair), never another OS user's helper on the PC.
     * A live {@code connectToken} ("Connect this PC") also pairs the browser that downloaded the file, which then collects
     * its key ({@link #collect}); when that browser was already someone's, the helper registers as that user whatever
     * Claude account the PC is signed in with - one person, several Claude accounts.
     */
    Issued registerHelper(String user, String machine, String osUser, String claudeAccount, String ip, String connectToken);

    /**
     * "Connect this PC" (one click, no code): a one-time token that goes into the file the browser downloads, and the
     * id + secret only that browser holds to collect its key once the helper on the PC has registered with the token.
     */
    default ConnectStart connectStart(String label) {
        return connectStart(label, null);
    }

    /** {@link #connectStart(String)} asked by a browser that is already {@code owner}'s: the PC connects as that user. */
    ConnectStart connectStart(String label, String owner);

    record ConnectStart(String connectId, String collectSecret, String token, Instant expiresAt) {
    }

    /** The browser's key once its PC has connected - once; empty while it has not (or for a wrong secret). */
    Optional<Issued> collect(String connectId, String collectSecret);

    /** The caller behind an {@code X-Alfred-Key} value, if the key is live. */
    Optional<Caller> authenticate(String rawKey);

    /** The helper's heartbeat: it is online, from {@code ip}, and {@code info} (JSON) is what it says about its PC. */
    default Helper heartbeat(Caller helper, String ip, String info) {
        return heartbeat(helper, ip, info, null);
    }

    /** {@link #heartbeat(Caller, String, String)} that also names the OS user, kept for a helper registered without one. */
    Helper heartbeat(Caller helper, String ip, String info, String osUser);

    /** A six-digit code that pairs one browser with this helper, valid two minutes. Helpers only. */
    PairCode pairCode(Caller helper);

    record PairCode(String code, Instant expiresAt) {
    }

    /** Pairs a browser by the code; empty when the code is wrong, used or expired (each code takes five tries). */
    Optional<Issued> pairBrowser(String code, String label);

    /** The caller's own PCs and browsers. */
    Devices devices(Caller caller);

    record Devices(List<Helper> helpers, List<BrowserKey> browsers) {
    }

    /** Revokes one of the caller's own keys. False when it is not theirs or not live. */
    boolean revokeOwn(Caller caller, String keyId);

    /** For the server admin (Settings ▸ Users): users, their PCs and when last seen - never settings or keys. */
    List<UserLine> users();

    record UserLine(String user, List<String> machines, int browsers, Instant lastSeen) {
    }

    /** The admin's revoke: the key stops working and the boards its user held through it are freed. */
    boolean adminRevoke(String keyId);

    /** The helpers of a user, online or not, to pick the PC a command goes to. */
    List<Helper> helpersOf(String user);
}
