package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.CallMetadataPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import com.fathy.alfred.backend.dbcapture.domain.StoreCommandFacts;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMetadata;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Ingest and reads of Redis commands against fake ports (specs/011-redis-capture T038, T059, T069). */
class StoreCommandsServiceTest {

    private StoreCommandsPort store;
    private DbCaptureStorePort capture;
    private DbCaptureNotificationPort notifications;
    private CallMetadataPort metadata;
    private StoreCommandsService service;

    @BeforeEach
    void setUp() {
        store = mock(StoreCommandsPort.class);
        capture = mock(DbCaptureStorePort.class);
        notifications = mock(DbCaptureNotificationPort.class);
        metadata = mock(CallMetadataPort.class);
        when(capture.settings(anyString())).thenReturn(DbCaptureSettings.defaults());
        service = new StoreCommandsService(store, capture, notifications, Optional.of(metadata), Optional.empty());
    }

    static byte[] req(String... args) {
        StringBuilder s = new StringBuilder("*" + args.length + "\r\n");
        for (String a : args) {
            s.append('$').append(a.length()).append("\r\n").append(a).append("\r\n");
        }
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    static IncomingStoreCommand cmd(String sid, String command, List<String> keys, byte[] args, byte[] reply, boolean chunked) {
        return new IncomingStoreCommand("redis", sid, "c1", null, 1, "2026-10-06T21:36:41.084Z", 300, command, keys, keys.size(), args, reply,
                com.fathy.alfred.backend.dbcapture.domain.Resp.type(reply), 2, null, args == null ? 0 : args.length, reply == null ? 0 : reply.length,
                chunked, "lettuce", "conn-r-1", "redis:6379", 0, "t", null, null, null, null, null, null, null, null, 0, "fp");
    }

    @Test
    void ingestOpensCallsStoresCommandsKeepsBadOnesAsFailedAndFinishesChunkedOnes() {
        byte[] hit = "$1\r\nv\r\n".getBytes(StandardCharsets.UTF_8);
        IncomingStoreCommand ok = cmd("s1", "GET", List.of("k"), req("GET", "k"), hit, false);
        IncomingStoreCommand bad = cmd("s2", "GET", List.of("k2"), null, null, false);
        IncomingStoreCommand big = cmd("s3", "SET", List.of("big"), null, null, true);
        when(store.completeChunked("s3")).thenReturn(Optional.of(cmd("s3", "SET", List.of("big"), req("SET", "big", "x"), "+OK\r\n".getBytes(), false)));
        CallMarker open = new CallMarker("c1", 0, MarkerType.CALL_OPEN, "2026-10-06T21:36:41Z", null, null, "t", null, null, true);
        IngestBatch batch = new IngestBatch("a1", "odeysys", List.of(), List.of(open), Map.of(), List.of(), Map.of(),
                List.of(new IngestBatch.RedisIn(ok, null), new IngestBatch.RedisIn(bad, "invalid record: Illegal base64"),
                        new IngestBatch.RedisIn(big, null)),
                List.of(new IncomingStoreChunk("s3", "args", 0, 1, new byte[]{1})), Map.of("c9", 2L));

        var changed = service.ingest(batch);

        verify(store).openCall("c1", "odeysys", "2026-10-06T21:36:41Z");
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<StoreCommandsPort.NewCommand>> saved = ArgumentCaptor.forClass(List.class);
        verify(store).save(saved.capture());
        assertThat(saved.getValue()).extracting(n -> n.outcome()).containsExactly("HIT", "FAILED", "FAILED");
        assertThat(saved.getValue().get(1).command().error()).startsWith("invalid record");
        verify(store).finishChunked(eq("s3"), any());
        verify(store).addDropped(Map.of("c9", 2L));
        verify(store).refreshSummary("c1");
        verify(store).refreshSummary("c9");
        assertThat(changed).contains("c1", "c9");
        verify(notifications).storeCommandsAppended(any());
    }

    static StoreCommandSummary row(long id, int seq, String command, List<String> keys, String outcome, String at) {
        return new StoreCommandSummary(id, "redis", seq, at, 400, command, keys, keys.size(), keys.isEmpty() ? null : keys.get(0),
                StoreCommandFacts.rw(command), outcome, "BULK", "HIT 1.4 KB", "v", null, null, null, "a.B(B.java:1)", "lettuce", "conn-r-1",
                null, 100, 1412, false, null, null);
    }

    @Test
    void maskedKeysAreMaskedInRowsAndDetailButNeverChangedInStorage() {
        when(capture.settings("odeysys")).thenReturn(DbCaptureSettings.defaults().withRedis(new RedisSettings(List.of("session:*"), "DECODED", false, 10, false)));
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        StoreCommandSummary session = row(1, 1, "GET", List.of("session:odeysys:9f2a"), "HIT", "2026-10-06T21:36:41.012Z");
        when(store.commands("c1", 0, 500)).thenReturn(List.of(session));
        when(store.count("c1")).thenReturn(1);
        var page = service.commands("c1", 0, 9999);
        assertThat(page.commands().get(0).replyPreview()).isEqualTo("‹masked · 1,412 B›");

        byte[] reply = "$6\r\nsecret\r\n".getBytes(StandardCharsets.UTF_8);
        when(store.command(1)).thenReturn(Optional.of(new StoreCommandsPort.StoredCommand(session, "odeysys", "c1", req("GET", "session:odeysys:9f2a"),
                reply, null, "redis:6379", 0, "t", List.of(), "fp", 2, null)));
        StoreCommand d = service.command(1, true).orElseThrow();
        assertThat(d.reply().masked()).isTrue();
        assertThat(d.reply().text()).isNull();
        assertThat(d.reply().rawBase64()).isNull();
    }

    @Test
    void aHitNamesTheCallThatWroteItsKeyAndWhetherTheValueIsTheSame() {
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        StoreCommandSummary get = row(5, 12, "GET", List.of("fare:rule:EK"), "HIT", "2026-10-06T21:36:41.000Z");
        byte[] reply = "$2\r\n{}\r\n".getBytes(StandardCharsets.UTF_8);
        when(store.command(5)).thenReturn(Optional.of(new StoreCommandsPort.StoredCommand(get, "odeysys", "c1", req("GET", "fare:rule:EK"), reply,
                null, "redis:6379", 0, "t", List.of(), "fp", 2, null)));
        long writeAt = StoreCommandFacts.atMs("2026-10-06T21:32:41.000Z");
        when(store.latestWrite(eq("odeysys"), eq("fare:rule:EK"), anyLong())).thenReturn(Optional.of(
                new StoredKey("odeysys", "fare:rule:EK", "b71e09d2", 7, "w", writeAt, StoreCommandFacts.sha256("{}".getBytes()), 600_000L)));
        when(store.commands(eq("b71e09d2"), anyInt(), anyInt())).thenReturn(List.of(row(9, 7, "SET", List.of("fare:rule:EK"), "OK", "2026-10-06T21:32:41.000Z")));
        when(metadata.metadata(any())).thenReturn(Map.of("b71e09d2", new CallMetadata("POST", "/odeysysadmin/Booking2/flight-search/search", 200)));

        StoreCommand d = service.command(5, false).orElseThrow();
        assertThat(d.writtenBy().callId()).isEqualTo("b71e09d2");
        assertThat(d.writtenBy().command()).isEqualTo("SET");
        assertThat(d.writtenBy().method()).isEqualTo("POST");
        assertThat(d.writtenBy().agoMillis()).isEqualTo(240_000L);
        assertThat(d.writtenBy().sameValue()).isTrue();
        assertThat(d.reply().text()).contains("{ }");
    }

    @Test
    void aHitWithoutARecordedWriterSaysSo() {
        StoreCommandSummary get = row(6, 1, "GET", List.of("user:790:prefs"), "HIT", "2026-10-06T21:36:41.000Z");
        when(store.command(6)).thenReturn(Optional.of(new StoreCommandsPort.StoredCommand(get, "odeysys", "c1", req("GET", "user:790:prefs"),
                "$1\r\nx\r\n".getBytes(), null, null, 0, "t", List.of(), "fp", 2, null)));
        when(store.latestWrite(any(), any(), anyLong())).thenReturn(Optional.empty());
        assertThat(service.command(6, false).orElseThrow().writtenBy().none()).isEqualTo(StoreCommandsService.NO_WRITER);
    }

    @Test
    void coldMissesAreMarkedOnThePage() {
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        StoreCommandSummary miss = row(7, 3, "GET", List.of("fare:rule:CX"), "MISS", "2026-10-06T21:36:41.000Z");
        when(store.commands("c1", 0, 500)).thenReturn(List.of(miss));
        long readAt = StoreCommandFacts.atMs(miss.at());
        when(store.latestWrite("odeysys", "fare:rule:CX", readAt))
                .thenReturn(Optional.of(new StoredKey("odeysys", "fare:rule:CX", "old", 1, "w", readAt - 700_000, "h", 600_000L)));
        assertThat(service.commands("c1", 0, 500).cold()).containsExactly(3);
    }

    @Test
    void keysViewGroupsPatternsSlowestFirst() {
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        when(store.commands(eq("c1"), eq(0), anyInt())).thenReturn(List.of(
                row(1, 1, "GET", List.of("fare:rule:EK"), "HIT", "2026-10-06T21:36:41.000Z"),
                row(2, 2, "GET", List.of("fare:rule:QR"), "HIT", "2026-10-06T21:36:41.001Z"),
                row(3, 3, "GET", List.of("fare:rule:EY"), "MISS", "2026-10-06T21:36:41.002Z"),
                row(4, 4, "SET", List.of("upsell:a5b4f2f0"), "OK", "2026-10-06T21:36:41.003Z")));
        when(store.latestWrite(any(), any(), anyLong())).thenReturn(Optional.empty());
        var keys = service.keys("c1");
        assertThat(keys).extracting(k -> k.pattern()).containsExactly("fare:rule:*", "upsell:*");
        assertThat(keys.get(0).hits()).isEqualTo(2);
        assertThat(keys.get(0).misses()).isEqualTo(1);
        assertThat(keys.get(1).lastWriter()).isEqualTo("this call #4");
    }

    @Test
    void limitsAreClampedAndOversizedIdListsRefused() {
        service.commands("c1", -5, 100_000);
        verify(store).commands("c1", 0, StoreCommandsService.MAX_PAGE);
        assertThatThrownBy(() -> service.storeSummaries(java.util.Collections.nCopies(101, "x"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.keyHistory("odeysys", " ", 10)).isInstanceOf(IllegalArgumentException.class);
        service.keyHistory("odeysys", "k", 100_000);
        verify(store).keyHistory("odeysys", "k", StoreCommandsService.MAX_HISTORY);
    }

    @Test
    void anExportedCommandReadsBackByteForByteAndMaskedOnesCarryNoBytes() {
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        byte[] big = new byte[2_000_000];
        java.util.Arrays.fill(big, (byte) 'v');
        byte[] reply = ("$" + big.length + "\r\n" + new String(big, StandardCharsets.ISO_8859_1) + "\r\n").getBytes(StandardCharsets.ISO_8859_1);
        StoreCommandSummary get = row(1, 4, "GET", List.of("upsell:a5b4f2f0"), "HIT", "2026-10-06T21:36:41.000Z");
        when(store.commandsWithBytes("c1", StoreCommandsService.MAX_WITH_BYTES)).thenReturn(List.of(new StoreCommandsPort.StoredCommand(get, "odeysys",
                "c1", req("GET", "upsell:a5b4f2f0"), reply, null, "redis:6379", 0, "t", List.of(), "GET upsell:* [k]", 2, null)));
        when(store.latestWrite(any(), any(), anyLong())).thenReturn(Optional.empty());

        var exported = service.export("c1");
        assertThat(exported).singleElement().satisfies(e -> {
            assertThat(e.masked()).isFalse();
            assertThat(e.replyBytes()).isEqualTo(reply.length);
            assertThat(e.replyText()).hasSize(big.length); // never truncated
        });
        IncomingStoreCommand back = StoreCommandsService.imported("c1", exported.get(0)).command();
        assertThat(back.reply()).isEqualTo(reply);
        assertThat(back.args()).isEqualTo(req("GET", "upsell:a5b4f2f0"));
        assertThat(back.sid()).isEqualTo("import:c1:r:4");

        when(capture.settings("odeysys")).thenReturn(DbCaptureSettings.defaults().withRedis(new RedisSettings(List.of("upsell:*"), "DECODED", false, 10, false)));
        var masked = service.export("c1").get(0);
        assertThat(masked.masked()).isTrue();
        assertThat(masked.reply()).isNull();
        assertThat(masked.replyText()).startsWith("\u2039masked");
    }

    @Test
    void traceFindsAValueInKeysArgumentsAndJsonReplies() {
        when(store.projectOf("c1")).thenReturn(Optional.of("odeysys"));
        StoreCommandSummary set = row(1, 27, "SET", List.of("upsell:a5b4f2f0"), "OK", "2026-10-06T21:36:41.000Z");
        when(store.commandsWithBytes("c1", StoreCommandsService.MAX_WITH_BYTES)).thenReturn(List.of(new StoreCommandsPort.StoredCommand(set, "odeysys",
                "c1", req("SET", "upsell:a5b4f2f0", "{\"searchId\":\"a5b4f2f0\"}"), "+OK\r\n".getBytes(), null, null, 0, "t", List.of(), "fp", 2, null)));
        var hits = service.trace("c1", "a5b4f2f0", 100);
        assertThat(hits).extracting(h -> h.where()).containsExactly("REDIS_KEY", "REDIS_ARG");
        assertThat(hits.get(1).column()).isEqualTo("$.searchId");
    }
}
