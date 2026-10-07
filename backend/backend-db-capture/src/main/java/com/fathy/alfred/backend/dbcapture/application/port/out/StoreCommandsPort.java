package com.fathy.alfred.backend.dbcapture.application.port.out;

import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Store commands - Redis first (specs/011-redis-capture, data-model.md) - kept in db-capture.db beside the statements:
 * one row per command without bytes ({@code store_commands}), the bytes apart ({@code store_command_data}, read only
 * for a command's detail and exports), one row per key touched ({@code store_keys}) and a summary per call. Every
 * list read is windowed and indexed.
 */
public interface StoreCommandsPort {

    /** A command ready to store: the agent's record with what ALFRED derived from it. */
    record NewCommand(IncomingStoreCommand command, String project, String keyPattern, String rw, String outcome,
                      String replyPreview, String argsText, List<StoredKey> keys) {
    }

    /** Stores commands (ignoring sids already stored). A chunked command stays hidden until its parts are all stored. */
    void save(List<NewCommand> commands);

    /** Stores parts of big commands (they may arrive before or after their command's record). */
    void saveChunks(List<IncomingStoreChunk> chunks);

    /** A chunked command whose record and every part are stored - with its bytes assembled; empty until then. */
    Optional<IncomingStoreCommand> completeChunked(String sid);

    /** Makes a chunked command visible with what was derived from its assembled bytes (outcome, preview, keys). */
    void finishChunked(String sid, NewCommand derived);

    /** The call recorded its Redis commands (CALL_OPEN said so): a zero summary exists from now on. */
    void openCall(String callId, String project, String firstSeen);

    void addDropped(Map<String, Long> droppedByCall);

    /** Recounts a call's summary from its stored commands. */
    void refreshSummary(String callId);

    void markComplete(String callId, boolean endedEarly);

    int count(String callId);

    List<StoreCommandSummary> commands(String callId, int offset, int limit);

    /** One command with its bytes ([0] args, [1] reply, [2] before), by id. */
    Optional<StoredCommand> command(long id);

    /** Every command of a call with its bytes, in order, at most {@code limit} - exports and tracing. */
    List<StoredCommand> commandsWithBytes(String callId, int limit);

    record StoredCommand(StoreCommandSummary row, String project, String callId, byte[] args, byte[] reply, byte[] before,
                         String server, int db, String thread, List<String> callers, String fingerprint, int resp, String beforeType) {
    }

    Map<String, CallStoreSummary> summaries(Collection<String> callIds);

    /** Of these calls, the ones with at least one failed command. */
    List<String> failedCallIds(Collection<String> callIds);

    /** The keys a call touched, in order. */
    List<StoredKey> keysOfCall(String callId);

    /** The last write of {@code key} in the project strictly before {@code beforeAtMs}. */
    Optional<StoredKey> latestWrite(String project, String key, long beforeAtMs);

    /** A key's reads and writes across calls, newest first. */
    List<StoredKey> keyHistory(String project, String key, int limit);

    /** The project a call's commands came from. */
    Optional<String> projectOf(String callId);

    /** Removes every command, byte, key row and summary of these calls. */
    int deleteForCalls(Collection<String> callIds);

    void deleteAll();

    /** Bytes the commands hold (args + reply + before), for their size cap. */
    long bytes();

    /** Oldest-first call ids with commands, skipping {@code keep}. */
    List<String> oldestCallIds(int limit, Set<String> keep);

    /** Removes chunked commands still incomplete after {@code olderThanMs} (their call counts them as not kept). */
    int purgeIncomplete(long olderThanMs);
}
