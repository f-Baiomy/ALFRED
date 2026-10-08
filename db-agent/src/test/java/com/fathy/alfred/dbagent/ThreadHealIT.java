package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.capture.CaptureDispatcher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.UUID;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * A hook that failed between its enter and its exit (an agent jar replaced under the JVM gave NoClassDefFoundError
 * there, 2026-10-08) left its per-thread depth above 0, and a pooled server thread then skipped every statement for
 * the rest of its life. The next inbound call on that thread sets the depths back: one bad moment costs one call.
 */
class ThreadHealIT {

    private String url;

    @BeforeEach
    void setUp() throws Exception {
        AgentTestSupport.reset();
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE heal (id INT)");
        }
        AgentTestSupport.reset();
    }

    @Test
    void aThreadLeftInsideAnUnfinishedHookCapturesAgainFromItsNextCall() throws Exception {
        stuck("executeDepth");
        stuck("agentWork");
        inCall("heal-1", () -> {
            try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM heal")) {
                ps.executeQuery().close();
            }
        }, true);
        assertThat(SINK.statements()).extracting(r -> r.sql).contains("SELECT COUNT(*) FROM heal");
    }

    /** What an exit advice that never ran leaves behind on this thread. */
    private static void stuck(String depth) throws Exception {
        Field field = CaptureDispatcher.class.getDeclaredField(depth);
        field.setAccessible(true);
        ((int[]) ((ThreadLocal<?>) field.get(AgentTestSupport.DISPATCHER)).get())[0] = 1;
    }
}
