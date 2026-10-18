package com.fathy.alfred.backend.sessions.application.port.out;

import com.fathy.alfred.backend.sessions.domain.model.AuditEntry;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.BrowserKey;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;
import com.fathy.alfred.backend.sessions.domain.model.Holder;
import com.fathy.alfred.backend.sessions.domain.model.PendingMessage;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** sessions.db (specs/031). */
public interface SessionsStorePort {

    // keys
    void addHelper(Helper helper, String hash);

    Optional<Helper> helper(String keyId);

    /** The stored hash of a live (not revoked) helper or browser key, with its kind: "helper" or "browser". */
    Optional<KeyHash> keyHash(String keyId);

    record KeyHash(String keyId, String kind, String hash) {
    }

    List<Helper> helpersOf(String user);

    List<Helper> allHelpers();

    void helperSeen(String keyId, Instant at, String ip, String info);

    /** Revokes the user's other live helpers on that machine (a re-install replaces the old key); returns their ids. */
    List<String> revokeHelpersOn(String user, String machine, String exceptKeyId, Instant at);

    void addBrowser(BrowserKey key, String hash);

    Optional<BrowserKey> browser(String keyId);

    List<BrowserKey> browsersOf(String user);

    void browserSeen(String keyId, Instant at);

    /** Revokes a helper or browser key; a helper's browsers go with it. False when no such live key. */
    boolean revoke(String keyId, Instant at);

    // holders
    Optional<Holder> holder(String boardId);

    List<Holder> holders(String project);

    List<Holder> heldBy(String user);

    void putHolder(Holder holder);

    boolean removeHolder(String boardId);

    // sessions
    void putSession(BoardSession session);

    Optional<BoardSession> session(String id);

    Optional<BoardSession> sessionByCli(String cliSessionId);

    List<BoardSession> sessions(String project, String boardId, int limit);

    /** Makes {@code id} the board's current session and clears the flag on the board's others. */
    void makeCurrent(String boardId, String id);

    // helper commands
    void putCommand(HelperCommand command);

    Optional<HelperCommand> command(String id);

    List<HelperCommand> commandsOf(String user, int limit);

    /** Marks up to {@code max} of the helper's queued commands TAKEN, oldest first, and returns them. */
    List<HelperCommand> takeCommands(String helperKeyId, int max, Instant at);

    // commenters' chat messages waiting for the holder
    long addPending(PendingMessage m);

    List<PendingMessage> pending(String boardId);

    Optional<PendingMessage> pendingMessage(long id);

    boolean removePending(long id);

    // settings and audit
    Optional<String> settings(String user);

    void putSettings(String user, String json, Instant at);

    long audit(AuditEntry entry);

    List<AuditEntry> audit(String boardId, int limit);
}
