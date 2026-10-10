package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The storage budget's one share for everything captured with calls: past it the oldest calls lose ALL their capture
 * at once (statements, rows, log lines and Redis commands - one deleteForCalls) and are marked, never part of it.
 */
class DbCaptureRetentionCombinedTest {

    @Test
    void overTheShareTheOldestCallsLoseTheirWholeCaptureAndAreMarked() {
        DbCaptureStorePort statements = mock(DbCaptureStorePort.class);
        StoreCommandsPort commands = mock(StoreCommandsPort.class);
        RetainedCallIdsPort retained = mock(RetainedCallIdsPort.class);
        when(retained.retainedCallIds()).thenReturn(Set.of("in-a-cycle"));
        // statements 700 + Redis 600 = 1300 > 1000; after the first batch 400 + 300 = 700
        when(statements.totalBytes()).thenReturn(700L, 700L, 400L);
        when(commands.bytes()).thenReturn(600L, 600L, 300L);
        when(statements.oldestCallIds(DbCaptureRetention.EVICT_BATCH, Set.of("in-a-cycle"))).thenReturn(List.of("old-1", "old-2"));
        DbCaptureRetention retention = new DbCaptureRetention(statements, Optional.of(retained), Optional.empty(), Long.MAX_VALUE);
        retention.setStoreCommands(commands, Long.MAX_VALUE);

        retention.setCombinedMaxBytes(1_000L);

        verify(statements).deleteForCalls(List.of("old-1", "old-2"));
        verify(statements).markTrimmed(eq(List.of("old-1", "old-2")), anyString());
        // never Redis alone: that would leave a call with its statements but without its commands
        verify(commands, never()).deleteForCalls(anyCollection());
    }

    @Test
    void aCallWithOnlyRedisCommandsIsFoundThroughTheCommands() {
        DbCaptureStorePort statements = mock(DbCaptureStorePort.class);
        StoreCommandsPort commands = mock(StoreCommandsPort.class);
        when(statements.totalBytes()).thenReturn(0L);
        when(commands.bytes()).thenReturn(2_000L, 2_000L, 10L);
        when(statements.oldestCallIds(DbCaptureRetention.EVICT_BATCH, Set.of())).thenReturn(List.of());
        when(commands.oldestCallIds(DbCaptureRetention.EVICT_BATCH, Set.of())).thenReturn(List.of("redis-only"));
        DbCaptureRetention retention = new DbCaptureRetention(statements, Optional.empty(), Optional.empty(), Long.MAX_VALUE);
        retention.setStoreCommands(commands, Long.MAX_VALUE);

        retention.setCombinedMaxBytes(1_000L);

        verify(statements).deleteForCalls(List.of("redis-only"));
        verify(statements).markTrimmed(eq(List.of("redis-only")), anyString());
    }

    @Test
    void offTheTwoSeparateCapsApplyAsBefore() {
        DbCaptureStorePort statements = mock(DbCaptureStorePort.class);
        StoreCommandsPort commands = mock(StoreCommandsPort.class);
        when(statements.totalBytes()).thenReturn(10L);
        when(commands.bytes()).thenReturn(10L);
        DbCaptureRetention retention = new DbCaptureRetention(statements, Optional.empty(), Optional.empty(), 1_000L);
        retention.setStoreCommands(commands, 1_000L);

        retention.setCombinedMaxBytes(0L);
        retention.enforce();

        verify(commands).purgeIncomplete(anyLong());
        verify(statements, never()).markTrimmed(anyCollection(), anyString());
    }

    @Test
    void aNegativeShareIsRefused() {
        DbCaptureRetention retention = new DbCaptureRetention(mock(DbCaptureStorePort.class), Optional.empty(), Optional.empty(), 1L);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> retention.setCombinedMaxBytes(-1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(retention).isNotNull();
    }
}
