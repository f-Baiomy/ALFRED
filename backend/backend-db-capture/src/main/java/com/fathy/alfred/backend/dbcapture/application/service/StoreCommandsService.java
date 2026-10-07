package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.GetStoreCommandsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.StoreSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.CallMetadataPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort.NewCommand;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort.StoredCommand;
import com.fathy.alfred.backend.dbcapture.domain.KeyMask;
import com.fathy.alfred.backend.dbcapture.domain.KeyPattern;
import com.fathy.alfred.backend.dbcapture.domain.RedisCli;
import com.fathy.alfred.backend.dbcapture.domain.Resp;
import com.fathy.alfred.backend.dbcapture.domain.StoreCommandFacts;
import com.fathy.alfred.backend.dbcapture.domain.StoreValueDecoder;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMetadata;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.DecodedValue;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyHistoryRow;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyPatternRow;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyWriter;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Redis commands of calls (specs/011-redis-capture): stored from the agents' batches (with what ALFRED derives - outcome,
 * preview, key rows), read for the window (masked keys masked, values decoded only when shown), "written by", the Keys
 * view, key history, redis-cli and the summaries the chips, the failures pill and endpoint health read.
 */
@Service
public class StoreCommandsService implements GetStoreCommandsUseCase, StoreSummariesUseCase {

    private static final Logger log = LoggerFactory.getLogger(StoreCommandsService.class);

    static final int MAX_PAGE = 500;
    static final int MAX_HISTORY = 200;
    static final int MAX_SUMMARY_IDS = 100;
    static final int MAX_FAILURE_IDS = 500;
    /** Commands read for redis-cli, exports and tracing of one call. */
    static final int MAX_WITH_BYTES = 20_000;
    static final String NO_WRITER = "written before Alfred captured any call that touched this key - no writer to show";

    private final StoreCommandsPort store;
    private final DbCaptureStorePort capture;
    private final DbCaptureNotificationPort notifications;
    private final Optional<CallMetadataPort> metadata;
    private final Clock clock;

    public StoreCommandsService(StoreCommandsPort store, DbCaptureStorePort capture, DbCaptureNotificationPort notifications,
                                Optional<CallMetadataPort> metadata, Optional<Clock> clock) {
        this.store = store;
        this.capture = capture;
        this.notifications = notifications;
        this.metadata = metadata;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    // ================================================================== ingest

    /** Stores a batch's Redis part; returns the calls whose commands changed. */
    public Set<String> ingest(IngestBatch batch) {
        String project = batch.project();
        Set<String> changed = new LinkedHashSet<>();
        for (CallMarker m : batch.markers() == null ? List.<CallMarker>of() : batch.markers()) {
            if (m.type() == MarkerType.CALL_OPEN && Boolean.TRUE.equals(m.redis())) {
                store.openCall(m.callId(), project, m.at() == null ? clock.instant().toString() : m.at());
                changed.add(m.callId());
            }
        }
        List<NewCommand> commands = new ArrayList<>();
        Set<String> chunkedSids = new LinkedHashSet<>();
        for (IngestBatch.RedisIn in : batch.redis() == null ? List.<IngestBatch.RedisIn>of() : batch.redis()) {
            IncomingStoreCommand c = in.command();
            if (c == null || c.sid() == null || c.callId() == null || c.command() == null) {
                log.warn("Skipped a Redis record without sid, call or command from project {}", project);
                continue;
            }
            if (in.invalid() != null) {
                log.warn("Stored an unreadable Redis record of call {} seq {} as failed: {}", c.callId(), c.seq(), in.invalid());
                c = withError(c, in.invalid());
            }
            commands.add(derive(project, c));
            changed.add(c.callId());
            if (c.chunked()) {
                chunkedSids.add(c.sid());
            }
        }
        store.save(commands);
        List<IncomingStoreChunk> chunks = batch.redisChunks() == null ? List.of() : batch.redisChunks();
        store.saveChunks(chunks);
        chunks.forEach(ch -> chunkedSids.add(ch.sid()));
        for (String sid : chunkedSids) {
            store.completeChunked(sid).ifPresent(full -> {
                store.finishChunked(sid, derive(project, full));
                changed.add(full.callId());
            });
        }
        Map<String, Long> dropped = batch.droppedRedis() == null ? Map.of() : batch.droppedRedis();
        store.addDropped(dropped);
        changed.addAll(dropped.keySet());
        changed.forEach(store::refreshSummary);
        if (!changed.isEmpty()) {
            notifications.storeCommandsAppended(changed);
        }
        return changed;
    }

    private static IncomingStoreCommand withError(IncomingStoreCommand c, String error) {
        return new IncomingStoreCommand(c.store(), c.sid(), c.callId(), c.runTag(), c.seq(), c.at(), c.micros(), c.command(), c.keys(),
                c.keysTotal(), c.args(), c.reply(), "NONE", c.resp(), error, c.argsBytes(), c.replyBytes(), false, c.client(), c.connection(),
                c.server(), c.db(), c.thread(), c.code(), c.callers(), c.origin(), c.group(), c.poolWaitMicros(), c.before(), c.beforeType(),
                c.beforeNote(), c.beforeBytes(), c.fingerprint());
    }

    /** What ALFRED derives from a command whose bytes it has (a chunked one gets its derivation once assembled). */
    static NewCommand derive(String project, IncomingStoreCommand c) {
        byte[] reply = c.reply();
        String outcome = StoreCommandFacts.outcome(c, reply);
        String rw = StoreCommandFacts.rw(c.command());
        List<byte[]> args = c.args() == null ? List.of() : Resp.args(c.args());
        String pattern = c.keys().isEmpty() ? null : KeyPattern.of(c.keys().get(0));
        List<StoredKey> keys = c.chunked() ? List.of() : StoreCommandFacts.keys(project, c, c.args(), reply, outcome);
        return new NewCommand(c, project, pattern, rw, outcome, StoreCommandFacts.replyPreview(outcome, reply, c.error()),
                StoreCommandFacts.argsText(c.command(), args, c.keys().size()), keys);
    }

    /** The call ended: its summary is no longer live (specs/011-redis-capture FR-013). */
    public void callCompleted(String callId, boolean endedEarly) {
        if (store.summaries(List.of(callId)).isEmpty()) {
            return; // nothing recorded for it - no Redis chip to update
        }
        store.markComplete(callId, endedEarly);
        notifications.storeCommandsAppended(List.of(callId));
    }

    // ================================================================== reads

    @Override
    public StoreCommandsPage commands(String callId, int offset, int limit) {
        int size = Math.max(1, Math.min(MAX_PAGE, limit));
        int from = Math.max(0, offset);
        List<StoreCommandSummary> rows = store.commands(callId, from, size);
        String project = store.projectOf(callId).orElse(null);
        KeyMask mask = mask(project);
        List<StoreCommandSummary> shown = rows.stream().map(r -> masked(r, mask)).toList();
        List<Integer> cold = new ArrayList<>();
        for (StoreCommandSummary r : rows) {
            if ("MISS".equals(r.outcome()) && !r.keys().isEmpty() && cold(project, r.keys().get(0), StoreCommandFacts.atMs(r.at()))) {
                cold.add(r.seq());
            }
        }
        CallStoreSummary summary = store.summaries(List.of(callId)).get(callId);
        return new StoreCommandsPage(store.count(callId), shown, cold, summary == null ? 0 : summary.dropped(), summary);
    }

    /** A miss on a key a recorded call wrote earlier with a TTL that had run out by the read ("cache cold"). */
    private boolean cold(String project, String key, long readAt) {
        Optional<StoredKey> last = store.latestWrite(project, key, readAt);
        return last.isPresent() && last.get().ttlMs() != null && last.get().ttlMs() > 0 && last.get().atMs() + last.get().ttlMs() <= readAt;
    }

    private static StoreCommandSummary masked(StoreCommandSummary r, KeyMask mask) {
        if (!mask.masks(r.keys())) {
            return r;
        }
        return new StoreCommandSummary(r.id(), r.store(), r.seq(), r.at(), r.micros(), r.command(), r.keys(), r.keysTotal(), r.keyPattern(),
                r.rw(), r.outcome(), r.replyType(), "HIT".equals(r.outcome()) || "OK".equals(r.outcome()) ? KeyMask.placeholder(r.replyBytes()) : r.replyPreview(),
                r.argsText() == null || r.argsText().isEmpty() ? r.argsText() : "‹masked›", r.error(), r.origin(), r.group(), r.code(),
                r.client(), r.connection(), r.poolWaitMicros(), r.bytes(), r.replyBytes(), r.hasBefore(), r.beforeNote(), r.runTag());
    }

    @Override
    public Optional<StoreCommand> command(long id, boolean raw) {
        return store.command(id).map(c -> detail(c, raw));
    }

    private StoreCommand detail(StoredCommand c, boolean raw) {
        KeyMask mask = mask(c.project());
        StoreCommandSummary row = c.row();
        boolean masked = mask.masks(row.keys());
        List<byte[]> args = c.args() == null ? List.of() : Resp.args(c.args());
        List<String> argText = new ArrayList<>(args.size());
        int keyCount = row.keys().size();
        int nameWords = row.command().contains(" ") ? 2 : 1;
        for (int i = 0; i < args.size(); i++) {
            argText.add(masked && i >= nameWords + keyCount ? "‹masked›" : Resp.escaped(args.get(i)));
        }
        DecodedValue reply = masked ? DecodedValue.masked(c.reply() == null ? 0 : c.reply().length) : StoreValueDecoder.decodeReply(c.reply());
        DecodedValue before = c.before() == null ? null
                : masked ? DecodedValue.masked(c.before().length) : StoreValueDecoder.decodeReply(c.before());
        DecodedValue value = null;
        byte[] written = writtenValue(row.command(), args);
        if (written != null) {
            value = masked ? DecodedValue.masked(written.length) : StoreValueDecoder.decode(written);
        }
        if (raw && !masked) {
            reply = reply == null ? null : reply.withRaw(c.reply() == null ? null : Base64.getEncoder().encodeToString(c.reply()));
            before = before == null ? null : before.withRaw(Base64.getEncoder().encodeToString(c.before()));
            value = value == null ? null : value.withRaw(Base64.getEncoder().encodeToString(written));
        }
        KeyWriter writer = "HIT".equals(row.outcome()) && !row.keys().isEmpty() ? writtenBy(c) : null;
        return new StoreCommand(masked(row, mask), argText, reply, before, value, writer, c.server(), c.db(), c.thread(), c.callers(),
                c.fingerprint(), c.resp(), raw && !masked && c.args() != null ? Base64.getEncoder().encodeToString(c.args()) : null);
    }

    /** The value a string write stores (SET-like commands) - shown decoded in the detail. */
    private static byte[] writtenValue(String command, List<byte[]> args) {
        String cmd = command == null ? "" : command.toUpperCase(Locale.ROOT);
        int at = switch (cmd) {
            case "SET", "SETNX", "GETSET", "APPEND", "PUBLISH", "LPUSH", "RPUSH", "SADD" -> 2;
            case "SETEX", "PSETEX", "HSET", "HSETNX" -> 3;
            default -> -1;
        };
        return at > 0 && at < args.size() ? args.get(at) : null;
    }

    private KeyWriter writtenBy(StoredCommand c) {
        String key = c.row().keys().get(0);
        long readAt = StoreCommandFacts.atMs(c.row().at());
        Optional<StoredKey> write = store.latestWrite(c.project(), key, readAt);
        if (write.isEmpty()) {
            return KeyWriter.none(NO_WRITER);
        }
        StoredKey w = write.get();
        CallMetadata meta = metadata(Set.of(w.callId())).get(w.callId());
        String readHash = c.reply() == null ? null : StoreCommandFacts.sha256(Resp.valueBytes(c.reply()));
        Boolean same = w.valueHash() == null || readHash == null ? null : w.valueHash().equals(readHash);
        String writeCommand = store.commands(w.callId(), 0, MAX_PAGE).stream().filter(r -> r.seq() == w.seq()).map(StoreCommandSummary::command)
                .findFirst().orElse(null);
        return new KeyWriter(w.callId(), w.seq(), writeCommand, meta == null ? null : meta.method(), meta == null ? null : meta.path(),
                meta == null ? null : meta.status(), Math.max(0, readAt - w.atMs()), same, null);
    }

    @Override
    public List<KeyPatternRow> keys(String callId) {
        List<StoredKey> keys = store.keysOfCall(callId);
        List<StoreCommandSummary> rows = store.commands(callId, 0, MAX_WITH_BYTES);
        Map<Integer, StoreCommandSummary> bySeq = new HashMap<>();
        rows.forEach(r -> bySeq.put(r.seq(), r));
        Set<String> allKeys = new LinkedHashSet<>();
        keys.forEach(k -> allKeys.add(k.key()));
        rows.forEach(r -> allKeys.addAll(r.keys()));
        Map<String, String> patterns = KeyPattern.ofAll(allKeys);
        String project = store.projectOf(callId).orElse(null);
        long firstAt = rows.isEmpty() ? Long.MAX_VALUE : StoreCommandFacts.atMs(rows.get(0).at());

        Map<String, int[]> counts = new LinkedHashMap<>(); // commands, reads, writes, hits, misses, failed
        Map<String, long[]> micros = new HashMap<>();
        Map<String, Set<Integer>> writesInCall = new HashMap<>();
        Map<String, String> sampleKey = new HashMap<>();
        for (StoreCommandSummary r : rows) {
            String key = r.keys().isEmpty() ? r.command() : r.keys().get(0);
            String p = r.keys().isEmpty() ? "(" + r.command().toLowerCase(Locale.ROOT) + ")" : patterns.getOrDefault(key, key);
            sampleKey.putIfAbsent(p, key);
            int[] c = counts.computeIfAbsent(p, x -> new int[6]);
            c[0]++;
            if ("r".equals(r.rw())) {
                c[1]++;
            }
            if ("w".equals(r.rw())) {
                c[2]++;
                writesInCall.computeIfAbsent(p, x -> new LinkedHashSet<>()).add(r.seq());
            }
            if ("HIT".equals(r.outcome())) {
                c[3]++;
            }
            if ("MISS".equals(r.outcome())) {
                c[4]++;
            }
            if ("FAILED".equals(r.outcome())) {
                c[5]++;
            }
            micros.computeIfAbsent(p, x -> new long[1])[0] += r.micros();
        }
        List<KeyPatternRow> out = new ArrayList<>();
        for (Map.Entry<String, int[]> e : counts.entrySet()) {
            String p = e.getKey();
            int[] c = e.getValue();
            out.add(new KeyPatternRow(p, c[0], c[1], c[2], c[3], c[4], c[5], micros.get(p)[0],
                    lastWriter(project, sampleKey.get(p), firstAt, writesInCall.get(p), c[1] > 0 && c[3] > 0)));
        }
        out.sort((a, b) -> Long.compare(b.micros(), a.micros()));
        return out;
    }

    private String lastWriter(String project, String key, long firstAt, Set<Integer> writesHere, boolean readHit) {
        StringBuilder s = new StringBuilder();
        if (writesHere != null && !writesHere.isEmpty()) {
            s.append("this call #").append(String.join(", #", writesHere.stream().map(String::valueOf).toList()));
        }
        if (key != null && firstAt != Long.MAX_VALUE) {
            Optional<StoredKey> before = store.latestWrite(project, key, firstAt);
            if (before.isPresent()) {
                StoredKey w = before.get();
                CallMetadata meta = metadata(Set.of(w.callId())).get(w.callId());
                if (s.length() > 0) {
                    s.append(" · ");
                }
                s.append(meta == null ? "call" : meta.method() + " " + shortPath(meta.path())).append(' ')
                        .append(w.callId(), 0, Math.min(8, w.callId().length())).append("… ").append(ago(firstAt - w.atMs())).append(" before");
            } else if (s.length() == 0 && readHit) {
                s.append("before capture started");
            }
        }
        return s.length() == 0 ? null : s.toString();
    }

    private static String shortPath(String path) {
        if (path == null) {
            return "";
        }
        String p = path.replaceFirst("^https?://[^/]+", "");
        String[] parts = p.split("/");
        return parts.length > 3 ? "…/" + parts[parts.length - 1] : p;
    }

    static String ago(long ms) {
        if (ms < 60_000) {
            return Math.max(0, ms / 1000) + " s";
        }
        if (ms < 3_600_000) {
            return ms / 60_000 + " min";
        }
        if (ms < 86_400_000) {
            return ms / 3_600_000 + " h";
        }
        return ms / 86_400_000 + " d";
    }

    @Override
    public List<KeyHistoryRow> keyHistory(String project, String key, int limit) {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("key is required");
        }
        int size = Math.max(1, Math.min(MAX_HISTORY, limit));
        List<StoredKey> rows = store.keyHistory(project, key, size);
        Set<String> calls = new HashSet<>();
        rows.forEach(r -> calls.add(r.callId()));
        Map<String, CallMetadata> meta = metadata(calls);
        List<KeyHistoryRow> out = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            StoredKey r = rows.get(i);
            String previousHash = null;
            for (int j = i + 1; j < rows.size() && previousHash == null; j++) {
                previousHash = rows.get(j).valueHash();
            }
            Boolean same = r.valueHash() == null || previousHash == null ? null : r.valueHash().equals(previousHash);
            StoreCommandSummary cmd = store.commands(r.callId(), Math.max(0, r.seq() - 1), MAX_PAGE).stream().filter(x -> x.seq() == r.seq())
                    .findFirst().orElse(null);
            CallMetadata m = meta.get(r.callId());
            out.add(new KeyHistoryRow(r.callId(), r.seq(), r.op(), cmd == null ? null : cmd.command(), Instant.ofEpochMilli(r.atMs()).toString(),
                    cmd == null ? null : cmd.outcome(), m == null ? null : m.method(), m == null ? null : m.path(), m == null ? null : m.status(), same));
        }
        return out;
    }

    @Override
    public String redisCli(String callId, Collection<Integer> seqs) {
        Set<Integer> wanted = seqs == null ? Set.of() : new HashSet<>(seqs);
        List<StoredCommand> commands = store.commandsWithBytes(callId, MAX_WITH_BYTES);
        KeyMask mask = mask(store.projectOf(callId).orElse(null));
        StringBuilder out = new StringBuilder("# Redis commands of call ").append(callId).append(" (ALFRED)\n");
        for (StoredCommand c : commands) {
            if (!wanted.isEmpty() && !wanted.contains(c.row().seq())) {
                continue;
            }
            List<byte[]> args = c.args() == null ? List.of() : Resp.args(c.args());
            if (args.isEmpty()) {
                out.append("# #").append(c.row().seq()).append(' ').append(c.row().command()).append(" - arguments not recorded\n");
                continue;
            }
            out.append(RedisCli.line(args, mask.masks(c.row().keys()), c.row().keys().size())).append('\n');
        }
        return out.toString();
    }

    /** Per call: [failed Redis commands, cold misses] - the signals triage keeps (specs/011-redis-capture FR-033). */
    public Map<String, int[]> signals(Collection<String> callIds) {
        Map<String, int[]> out = new LinkedHashMap<>();
        List<String> ids = new ArrayList<>(callIds);
        for (int i = 0; i < ids.size(); i += 400) {
            store.summaries(ids.subList(i, Math.min(ids.size(), i + 400))).forEach((id, s) -> {
                int cold = 0;
                if (s.misses() > 0) {
                    String project = s.project();
                    for (StoreCommandSummary r : store.commands(id, 0, MAX_WITH_BYTES)) {
                        if ("MISS".equals(r.outcome()) && !r.keys().isEmpty() && cold(project, r.keys().get(0), StoreCommandFacts.atMs(r.at()))) {
                            cold++;
                        }
                    }
                }
                out.put(id, new int[]{s.failed(), cold});
            });
        }
        return out;
    }

    // ================================================================== export, import, trace

    /** Every command of a call for an export - bytes base64 (none for masked keys) and decoded text; nothing cut. */
    public List<com.fathy.alfred.backend.dbcapture.domain.model.ExportedStoreCommand> export(String callId) {
        KeyMask mask = mask(store.projectOf(callId).orElse(null));
        List<com.fathy.alfred.backend.dbcapture.domain.model.ExportedStoreCommand> out = new ArrayList<>();
        Base64.Encoder b64 = Base64.getEncoder();
        for (StoredCommand c : store.commandsWithBytes(callId, MAX_WITH_BYTES)) {
            StoreCommandSummary r = c.row();
            boolean masked = mask.masks(r.keys());
            StoreCommand d = detail(c, false);
            out.add(new com.fathy.alfred.backend.dbcapture.domain.model.ExportedStoreCommand(r.store(), r.seq(), r.at(), r.micros(), r.command(),
                    r.keys(), r.keysTotal(), r.rw(), r.outcome(), r.replyType(), c.resp(), r.error(),
                    masked || c.args() == null ? null : b64.encodeToString(c.args()), masked || c.reply() == null ? null : b64.encodeToString(c.reply()),
                    masked || c.before() == null ? null : b64.encodeToString(c.before()), r.beforeNote(),
                    c.args() == null ? 0 : c.args().length, c.reply() == null ? 0 : c.reply().length, c.before() == null ? 0 : c.before().length,
                    masked, r.client(), r.connection(), c.server(), c.db(), c.thread(), r.code(), c.callers(), r.origin(), r.group(),
                    r.poolWaitMicros(), c.fingerprint(), r.runTag(), d.args(), d.reply() == null ? null : d.reply().format(),
                    d.reply() == null ? null : d.reply().masked() ? KeyMask.placeholder(d.reply().bytes()) : d.reply().text(),
                    d.value() == null ? null : d.value().format(),
                    d.value() == null ? null : d.value().masked() ? KeyMask.placeholder(d.value().bytes()) : d.value().text(),
                    d.before() == null ? null : d.before().masked() ? KeyMask.placeholder(d.before().bytes()) : d.before().text()));
        }
        return out;
    }

    public Optional<CallStoreSummary> summary(String callId) {
        return Optional.ofNullable(store.summaries(List.of(callId)).get(callId));
    }

    /** An exported command read back as the agent would have sent it (sid "import:call:r:seq" - a second import stores nothing). */
    public static IngestBatch.RedisIn imported(String callId, com.fathy.alfred.backend.dbcapture.domain.model.ExportedStoreCommand e) {
        Base64.Decoder b64 = Base64.getDecoder();
        try {
            byte[] args = e.args() == null ? null : b64.decode(e.args());
            byte[] reply = e.reply() == null ? null : b64.decode(e.reply());
            byte[] before = e.before() == null ? null : b64.decode(e.before());
            return new IngestBatch.RedisIn(new IncomingStoreCommand(e.store() == null ? "redis" : e.store(), "import:" + callId + ":r:" + e.seq(), callId,
                    e.runTag(), e.seq(), e.at(), e.micros(), e.command(), e.keys(), e.keysTotal(), args, reply,
                    e.replyType() == null ? com.fathy.alfred.backend.dbcapture.domain.Resp.type(reply) : e.replyType(), e.resp() == 0 ? 2 : e.resp(),
                    e.error(), e.argsBytes(), e.replyBytes(), false, e.client(), e.connection(), e.server(), e.db(), e.thread(), e.code(),
                    e.callers(), e.origin(), e.group(), e.poolWaitMicros(), before, null, e.beforeNote(), e.beforeBytes(), e.fingerprint()), null);
        } catch (IllegalArgumentException bad) {
            return new IngestBatch.RedisIn(null, "invalid record: " + bad.getMessage());
        }
    }

    /** Where a value appears in a call's Redis commands - keys, arguments, replies, before values (masked values are not searched). */
    public List<com.fathy.alfred.backend.dbcapture.domain.model.TraceHit> trace(String callId, String value, int max) {
        List<com.fathy.alfred.backend.dbcapture.domain.model.TraceHit> hits = new ArrayList<>();
        if (value == null || value.isEmpty()) {
            return hits;
        }
        KeyMask mask = mask(store.projectOf(callId).orElse(null));
        for (StoredCommand c : store.commandsWithBytes(callId, MAX_WITH_BYTES)) {
            StoreCommandSummary r = c.row();
            for (int i = 0; i < r.keys().size(); i++) {
                if (r.keys().get(i).contains(value)) {
                    hits.add(new com.fathy.alfred.backend.dbcapture.domain.model.TraceHit(r.seq(), "REDIS_KEY", i, r.keys().get(i)));
                }
            }
            if (!mask.masks(r.keys())) {
                List<byte[]> args = c.args() == null ? List.of() : Resp.args(c.args());
                int first = (r.command().contains(" ") ? 2 : 1) + r.keys().size();
                for (int i = first; i < args.size(); i++) {
                    String text = textOf(args.get(i));
                    if (text != null && text.contains(value)) {
                        hits.add(new com.fathy.alfred.backend.dbcapture.domain.model.TraceHit(r.seq(), "REDIS_ARG", i, jsonPath(text, value)));
                    }
                }
                String reply = c.reply() == null ? null : textOf(Resp.valueBytes(c.reply()));
                if (reply != null && reply.contains(value)) {
                    hits.add(new com.fathy.alfred.backend.dbcapture.domain.model.TraceHit(r.seq(), "REDIS_REPLY", 0, jsonPath(reply, value)));
                }
                String before = c.before() == null ? null : textOf(Resp.valueBytes(c.before()));
                if (before != null && before.contains(value)) {
                    hits.add(new com.fathy.alfred.backend.dbcapture.domain.model.TraceHit(r.seq(), "REDIS_BEFORE", 0, null));
                }
            }
            if (hits.size() >= max) {
                break;
            }
        }
        return hits;
    }

    /** A value's text as a person would search it: decoded (unpacked, JDK/JSON read) when possible. */
    private static String textOf(byte[] b) {
        if (b == null) {
            return null;
        }
        DecodedValue d = StoreValueDecoder.decode(b);
        return d == null ? null : d.text();
    }

    /** The JSON path of the first field whose value contains {@code value}, e.g. {@code $.searchId} - null for non-JSON. */
    static String jsonPath(String text, String value) {
        String t = text.strip();
        if (!(t.startsWith("{") || t.startsWith("["))) {
            return null;
        }
        try {
            return find(new com.fasterxml.jackson.databind.ObjectMapper().readTree(t), value, "$");
        } catch (java.io.IOException e) {
            return null;
        }
    }

    private static String find(com.fasterxml.jackson.databind.JsonNode n, String value, String path) {
        if (n.isValueNode()) {
            return n.asText().contains(value) ? path : null;
        }
        if (n.isArray()) {
            for (int i = 0; i < n.size(); i++) {
                String p = find(n.get(i), value, path + "[" + i + "]");
                if (p != null) {
                    return p;
                }
            }
            return null;
        }
        var fields = n.fields();
        while (fields.hasNext()) {
            var f = fields.next();
            String p = find(f.getValue(), value, path + "." + f.getKey());
            if (p != null) {
                return p;
            }
        }
        return null;
    }

    // ================================================================== summaries

    @Override
    public Map<String, CallStoreSummary> storeSummaries(Collection<String> callIds) {
        if (callIds.size() > MAX_SUMMARY_IDS) {
            throw new IllegalArgumentException("at most " + MAX_SUMMARY_IDS + " call ids per request");
        }
        return store.summaries(callIds);
    }

    @Override
    public List<String> redisFailedCallIds(Collection<String> callIds) {
        if (callIds.size() > MAX_FAILURE_IDS) {
            throw new IllegalArgumentException("at most " + MAX_FAILURE_IDS + " call ids per request");
        }
        return store.failedCallIds(callIds);
    }

    /** Endpoint health / cycle comparison: totals over the calls, read in pages; detail per command for at most 500 calls. */
    @Override
    public Aggregate aggregate(Collection<String> callIds) {
        Map<String, CallStoreSummary> all = new LinkedHashMap<>();
        List<String> ids = new ArrayList<>(callIds);
        for (int i = 0; i < ids.size(); i += 400) {
            all.putAll(store.summaries(ids.subList(i, Math.min(ids.size(), i + 400))));
        }
        long commands = 0;
        long reads = 0;
        long hits = 0;
        long misses = 0;
        long micros = 0;
        int failedCalls = 0;
        for (CallStoreSummary s : all.values()) {
            commands += s.commands();
            reads += s.reads();
            hits += s.hits();
            misses += s.misses();
            micros += s.micros();
            failedCalls += s.failed() > 0 ? 1 : 0;
        }
        long missToDb = 0;
        Map<String, Long> byCommand = new LinkedHashMap<>();
        int detailed = 0;
        for (String id : all.keySet()) {
            if (detailed++ >= 500) {
                break;
            }
            List<StoreCommandSummary> rows = store.commands(id, 0, MAX_WITH_BYTES);
            Map<String, String> patterns = KeyPattern.ofAll(rows.stream().flatMap(r -> r.keys().stream()).toList());
            Set<String> written = new HashSet<>();
            for (int i = rows.size() - 1; i >= 0; i--) {
                StoreCommandSummary r = rows.get(i);
                String key = r.keys().isEmpty() ? null : r.keys().get(0);
                if ("w".equals(r.rw()) && key != null) {
                    written.add(key);
                }
                if ("MISS".equals(r.outcome()) && key != null && written.contains(key)) {
                    missToDb++; // missed, then filled later in the same call - the work behind the miss ran in between
                }
                String label = r.command() + (key == null ? "" : " " + patterns.getOrDefault(key, key));
                byCommand.merge(label, 1L, Long::sum);
            }
        }
        return new Aggregate(callIds.size(), all.size(), commands, reads, hits, misses, failedCalls, micros, missToDb, byCommand);
    }

    // ================================================================== helpers

    private KeyMask mask(String project) {
        if (project == null) {
            return KeyMask.NONE;
        }
        RedisSettings r = capture.settings(project).redis();
        return r.maskPatterns().isEmpty() ? KeyMask.NONE : new KeyMask(r.maskPatterns());
    }

    private Map<String, CallMetadata> metadata(Set<String> callIds) {
        if (callIds.isEmpty() || metadata.isEmpty()) {
            return Map.of();
        }
        try {
            return metadata.get().metadata(callIds);
        } catch (RuntimeException e) {
            log.warn("Could not read the calls of {} key writers: {}", callIds.size(), e.getMessage());
            return Map.of();
        }
    }
}
