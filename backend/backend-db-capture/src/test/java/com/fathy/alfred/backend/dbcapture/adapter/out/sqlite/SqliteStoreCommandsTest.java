package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort.NewCommand;
import com.fathy.alfred.backend.dbcapture.application.service.StoreCommandsService;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreGroup;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreOrigin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Store commands in db-capture.db (specs/011-redis-capture T023) on a real SQLite file. */
class SqliteStoreCommandsTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository statements;
    private SqliteStoreCommandsRepository store;

    @BeforeEach
    void open() throws Exception {
        statements = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(statements, tempDir.resolve("db-capture.db").toString());
        statements.init();
        store = new SqliteStoreCommandsRepository(statements, new ObjectMapper().findAndRegisterModules());
    }

    @AfterEach
    void close() throws InterruptedException {
        statements.close();
        Thread.sleep(50);
    }

    static byte[] req(String... args) {
        StringBuilder s = new StringBuilder("*" + args.length + "\r\n");
        for (String a : args) {
            s.append('$').append(a.getBytes(StandardCharsets.UTF_8).length).append("\r\n").append(a).append("\r\n");
        }
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    static IncomingStoreCommand cmd(String sid, String callId, int seq, String at, String command, List<String> keys, byte[] args, byte[] reply,
                                    boolean chunked, String runTag) {
        return new IncomingStoreCommand("redis", sid, callId, runTag, seq, at, 400, command, keys, keys.size(), chunked ? null : args,
                chunked ? null : reply, com.fathy.alfred.backend.dbcapture.domain.Resp.type(reply), 2, null, args.length, reply.length, chunked,
                "lettuce 6.8.2", "conn-r-1", "redis:6379", 0, "default task-4", "a.B.c(B.java:1)", List.of(),
                new StoreOrigin("spring-cache", "fareRules", "@Cacheable", "FareRuleService.load(\"EK\")"), new StoreGroup("tx", "g1", 0, 2),
                null, null, null, null, 0, "GET fare:rule:* [k]");
    }

    static NewCommand derived(IncomingStoreCommand c) throws Exception {
        Method derive = StoreCommandsService.class.getDeclaredMethod("derive", String.class, IncomingStoreCommand.class);
        derive.setAccessible(true);
        return (NewCommand) derive.invoke(null, "odeysys", c);
    }

    @Test
    void savesListsSummarisesAndDeletesTogether() throws Exception {
        byte[] hit = "$3\r\n1.5\r\n".getBytes(StandardCharsets.UTF_8);
        byte[] miss = "$-1\r\n".getBytes(StandardCharsets.UTF_8);
        store.openCall("c1", "odeysys", "2026-10-06T21:36:41Z");
        IncomingStoreCommand a = cmd("a1", "c1", 1, "2026-10-06T21:36:41.012Z", "GET", List.of("fare:rule:EK"), req("GET", "fare:rule:EK"), hit, false, "run-1/s");
        IncomingStoreCommand b = cmd("a2", "c1", 2, "2026-10-06T21:36:41.014Z", "GET", List.of("fare:rule:QR"), req("GET", "fare:rule:QR"), miss, false, null);
        store.save(List.of(derived(a), derived(b)));
        store.save(List.of(derived(a))); // a retried batch stores nothing twice
        store.refreshSummary("c1");

        assertThat(store.count("c1")).isEqualTo(2);
        var rows = store.commands("c1", 0, 10);
        assertThat(rows).extracting(r -> r.outcome()).containsExactly("HIT", "MISS");
        assertThat(rows.get(0).origin().cache()).isEqualTo("fareRules");
        assertThat(rows.get(0).group().kind()).isEqualTo("tx");
        assertThat(rows.get(0).runTag()).isEqualTo("run-1/s");
        assertThat(rows.get(0).replyPreview()).isEqualTo("HIT 3 B");
        CallStoreSummary s = store.summaries(List.of("c1")).get("c1");
        assertThat(s.commands()).isEqualTo(2);
        assertThat(s.hits()).isEqualTo(1);
        assertThat(s.misses()).isEqualTo(1);
        assertThat(s.live()).isTrue();
        store.markComplete("c1", true);
        assertThat(store.summaries(List.of("c1")).get("c1").endedEarly()).isTrue();

        var detail = store.command(rows.get(0).id()).orElseThrow();
        assertThat(detail.reply()).isEqualTo(hit);
        assertThat(detail.args()).isEqualTo(req("GET", "fare:rule:EK"));
        assertThat(store.keysOfCall("c1")).hasSize(2);
        assertThat(store.bytes()).isGreaterThan(0);

        // deleting the call (the statements' path) removes its Redis commands too
        int deleted = statements.deleteForCalls(List.of("c1"));
        assertThat(deleted).isGreaterThan(0);
        assertThat(store.count("c1")).isZero();
        assertThat(store.summaries(List.of("c1"))).isEmpty();
        assertThat(store.keysOfCall("c1")).isEmpty();
    }

    @Test
    void aZeroCommandCallHasASummary() {
        store.openCall("c0", "odeysys", "2026-10-06T21:36:41Z");
        CallStoreSummary s = store.summaries(List.of("c0")).get("c0");
        assertThat(s.commands()).isZero();
        assertThat(s.live()).isTrue();
    }

    @Test
    void aChunkedCommandStaysHiddenUntilEveryPartArrived() throws Exception {
        byte[] big = new byte[700_000];
        Arrays.fill(big, (byte) 'x');
        byte[] args = req("SET", "upsell:a5b4f2f0", new String(big, StandardCharsets.ISO_8859_1));
        byte[] ok = "+OK\r\n".getBytes(StandardCharsets.UTF_8);
        IncomingStoreCommand chunked = cmd("big1", "c2", 1, "2026-10-06T21:36:41.012Z", "SET", List.of("upsell:a5b4f2f0"), args, ok, true, null);
        int part = 256 * 1024;
        int of = (args.length + part - 1) / part;
        // first part before the record, the rest after
        store.saveChunks(List.of(new IncomingStoreChunk("big1", "args", 0, of, Arrays.copyOfRange(args, 0, part))));
        store.save(List.of(derived(chunked)));
        assertThat(store.completeChunked("big1")).isEmpty();
        assertThat(store.count("c2")).isZero();
        for (int i = 1; i < of; i++) {
            store.saveChunks(List.of(new IncomingStoreChunk("big1", "args", i, of, Arrays.copyOfRange(args, i * part, Math.min(args.length, (i + 1) * part)))));
        }
        store.saveChunks(List.of(new IncomingStoreChunk("big1", "reply", 0, 1, ok)));
        IncomingStoreCommand full = store.completeChunked("big1").orElseThrow();
        assertThat(full.args()).isEqualTo(args);
        store.finishChunked("big1", derived(full));
        store.refreshSummary("c2");
        assertThat(store.count("c2")).isEqualTo(1);
        assertThat(store.command(store.commands("c2", 0, 1).get(0).id()).orElseThrow().args()).isEqualTo(args);
        assertThat(store.keysOfCall("c2")).hasSize(1);
    }

    @Test
    void incompleteCommandsArePurgedAndCountedAsNotKept() throws Exception {
        byte[] ok = "+OK\r\n".getBytes(StandardCharsets.UTF_8);
        IncomingStoreCommand chunked = cmd("lost1", "c3", 1, "2026-10-06T21:36:41.012Z", "SET", List.of("k"), req("SET", "k", "v"), ok, true, null);
        store.save(List.of(derived(chunked)));
        store.refreshSummary("c3");
        assertThat(store.purgeIncomplete(System.currentTimeMillis() + 1)).isEqualTo(1);
        assertThat(store.summaries(List.of("c3")).get("c3").dropped()).isEqualTo(1);
    }

    @Test
    void latestWriteAndHistoryAcrossCalls() throws Exception {
        byte[] ok = "+OK\r\n".getBytes(StandardCharsets.UTF_8);
        byte[] hit = "$1\r\nv\r\n".getBytes(StandardCharsets.UTF_8);
        store.save(List.of(derived(cmd("w1", "writer", 1, "2026-10-06T21:30:00.000Z", "SET", List.of("fare:rule:EK"), req("SET", "fare:rule:EK", "v", "EX", "600"), ok, false, null))));
        store.save(List.of(derived(cmd("r1", "reader", 1, "2026-10-06T21:36:00.000Z", "GET", List.of("fare:rule:EK"), req("GET", "fare:rule:EK"), hit, false, null))));
        var w = store.latestWrite("odeysys", "fare:rule:EK", com.fathy.alfred.backend.dbcapture.domain.StoreCommandFacts.atMs("2026-10-06T21:36:00.000Z"));
        assertThat(w).isPresent();
        assertThat(w.get().callId()).isEqualTo("writer");
        assertThat(w.get().ttlMs()).isEqualTo(600_000L);
        assertThat(store.keyHistory("odeysys", "fare:rule:EK", 10)).extracting(k -> k.callId()).containsExactly("reader", "writer");
        assertThat(store.oldestCallIds(10, Set.of("writer"))).doesNotContain("writer");
    }
}
