package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Redis commands' own size cap (specs/011-redis-capture T021/T077, FR-036, SC-009). */
class DbCaptureRetentionRedisTest {

    @Test
    void overTheCapTheOldestCallsLoseTheirCommandsWholeAndCycleCallsAreKept() {
        DbCaptureStorePort statements = mock(DbCaptureStorePort.class);
        StoreCommandsPort commands = mock(StoreCommandsPort.class);
        RetainedCallIdsPort retained = mock(RetainedCallIdsPort.class);
        when(retained.retainedCallIds()).thenReturn(Set.of("in-a-cycle"));
        when(commands.bytes()).thenReturn(3_000L, 3_000L, 900L);
        when(commands.oldestCallIds(DbCaptureRetention.EVICT_BATCH, Set.of("in-a-cycle"))).thenReturn(List.of("old-1", "old-2"));
        DbCaptureRetention retention = new DbCaptureRetention(statements, Optional.of(retained), Optional.empty(), Long.MAX_VALUE);
        retention.setStoreCommands(commands, 1_000L);

        retention.enforce();

        verify(commands).purgeIncomplete(anyLong());
        verify(commands).deleteForCalls(List.of("old-1", "old-2"));
    }

    @Test
    void underTheCapNothingIsRemoved() {
        DbCaptureStorePort statements = mock(DbCaptureStorePort.class);
        StoreCommandsPort commands = mock(StoreCommandsPort.class);
        when(commands.bytes()).thenReturn(10L);
        DbCaptureRetention retention = new DbCaptureRetention(statements, Optional.empty(), Optional.empty(), Long.MAX_VALUE);
        retention.setStoreCommands(commands, 1_000L);
        retention.enforce();
        verify(commands, never()).deleteForCalls(org.mockito.ArgumentMatchers.anyCollection());
    }
}
