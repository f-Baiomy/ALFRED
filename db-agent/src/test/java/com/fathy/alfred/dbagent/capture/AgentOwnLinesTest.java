package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.transport.LogRecord;
import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Level;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * WildFly logs System.err as ERROR, so the agent's own console lines came back through its log hooks and were stored as
 * application ERROR lines of the running call - triage then called a call that succeeded a hidden failure.
 */
class AgentOwnLinesTest {

    private final List<LogRecord> caught = new ArrayList<>();
    private final LogCatcher catcher = new LogCatcher(new StatementSink() {
        @Override
        public void statement(StatementRecord record) {
        }

        @Override
        public void marker(MarkerRecord marker) {
        }

        @Override
        public void log(LogRecord record) {
            caught.add(record);
        }
    });

    @Test
    void aLineLoggedWhileTheAgentPrintsIsNotCaught() {
        PrintStream original = System.err;
        // Stands in for the server's stdio handler: System.err goes into logging, on the printing thread.
        System.setErr(new PrintStream(new OutputStream() {
            @Override
            public void write(int b) {
            }

            @Override
            public void write(byte[] b, int off, int len) {
                catcher.caught("jul", new java.util.logging.LogRecord(Level.SEVERE, new String(b, off, len)), null, true);
            }
        }, true));
        try {
            AgentLog.info("hello");
        } finally {
            System.setErr(original);
        }
        assertThat(caught).isEmpty();
        assertThat(AgentLog.printing()).isFalse();
    }

    @Test
    void aLineCarryingTheAgentPrefixIsNotCaughtEvenFromAnotherAgentCopy() {
        catcher.caught("jul", new java.util.logging.LogRecord(Level.SEVERE, "[alfred-agent] WARN could not instrument X"), null, true);
        assertThat(caught).isEmpty();
    }

    @Test
    void theApplicationsOwnLinesAreStillCaught() {
        catcher.caught("jul", new java.util.logging.LogRecord(Level.SEVERE, "booking failed"), null, true);
        assertThat(caught).extracting(r -> r.message).containsExactly("booking failed");
    }
}
