package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The application call chain: a statement names the services that asked for it, not only the generic DAO every query
 * goes through (the OdeySys export: GenericDAOImpl.fetchWithSlaveHQL ×757 and nothing above it).
 */
class CallerChainIT {

    private static String url;

    /** The generic DAO - every query goes through here. */
    static final class GenericDao {
        static void select() throws Exception {
            try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT 2 FROM DUAL")) {
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                }
            }
        }
    }

    static final class OrganizationService {
        static void credential() throws Exception {
            GenericDao.select();
        }
    }

    static final class AgencyService {
        static void setDetails() throws Exception {
            OrganizationService.credential();
        }
    }

    @BeforeEach
    void setUp() {
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        AgentTestSupport.reset();
    }

    @AfterEach
    void tearDown() {
        AgentTestSupport.reset();
    }

    private static StatementRecord run(String callId) throws Exception {
        inCall(callId, AgentService::setDetails, true);
        List<StatementRecord> list = SINK.statementsOf(callId);
        assertThat(list).hasSize(1);
        return list.get(0);
    }

    /** One more level, so the chain has something to show past the pass-through class. */
    static final class AgentService {
        static void setDetails() throws Exception {
            AgencyService.setDetails();
        }
    }

    @Test
    void recordsTheFirstApplicationFramesInnermostFirst() throws Exception {
        StatementRecord s = run("chain-1");
        assertThat(s.codeLocation).startsWith("CallerChainIT$GenericDao.select(CallerChainIT.java:");
        assertThat(s.callers).hasSize(AgentSettings.DEFAULT_CALLER_FRAMES);
        assertThat(s.callers.get(0)).startsWith("CallerChainIT$GenericDao.select(");
        assertThat(s.callers.get(1)).startsWith("CallerChainIT$OrganizationService.credential(");
        assertThat(s.callers.get(2)).startsWith("CallerChainIT$AgencyService.setDetails(");
    }

    @Test
    void skipsThePassThroughClassesTheProjectNamed() throws Exception {
        SETTINGS.apply(AgentSettings.DEFAULT_ROWS_PER_RESULT, Collections.emptySet(), false, false, Collections.singletonList("SELECT 1"),
                Collections.singletonList("com.fathy.alfred.dbagent.CallerChainIT$GenericDao"), 2, false);
        StatementRecord s = run("chain-2");
        assertThat(s.codeLocation).startsWith("CallerChainIT$GenericDao.select("); // the first application frame, as before
        assertThat(s.callers).hasSize(2);
        assertThat(s.callers.get(0)).startsWith("CallerChainIT$OrganizationService.credential(");
        assertThat(s.callers.get(1)).startsWith("CallerChainIT$AgencyService.setDetails(");
    }
}
