package com.fathy.alfred.dbagent.transport;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class BatchWriterTest {

    @Test
    void escapesEverythingTheBackendParses() {
        assertThat(new JsonWriter().value("a\"b\\c\nd\u0001\u2028").toString()).isEqualTo("\"a\\\"b\\\\c\\nd\\u0001\\u2028\"");
    }

    @Test
    void writesCaughtLogLinesAndTheirDropCounts() {
        LogRecord l = new LogRecord();
        l.callId = "call-1";
        l.seq = 4;
        l.at = "2026-10-06T14:08:54.035Z";
        l.level = "WARN";
        l.logger = "com.app.Search";
        l.thread = "default task-4";
        l.message = "slow \"supplier\"";
        l.exceptionType = "java.lang.IllegalStateException";
        l.cut = true;
        Map<String, Long> dropped = new HashMap<>();
        dropped.put("call-1", 12L);

        String json = BatchWriter.write("a", "odeysys", Collections.<StatementRecord>emptyList(),
                Collections.singletonList(new MarkerRecord("call-1", 0, "CALL_OPEN", "t", null, null, "default task-4", true)),
                Collections.<String, Long>emptyMap(), Collections.singletonList(l), dropped);

        assertThat(json).contains("\"logs\":true")
                .contains("\"logs\":[{\"callId\":\"call-1\",\"seq\":4,\"at\":\"2026-10-06T14:08:54.035Z\",\"level\":\"WARN\"")
                .contains("\"message\":\"slow \\\"supplier\\\"\"").contains("\"exceptionType\":\"java.lang.IllegalStateException\"")
                .contains("\"cut\":true").contains("\"droppedLogs\":{\"call-1\":12}");
    }

    @Test
    void writesTheContractShape() {
        StatementRecord s = new StatementRecord();
        s.sid = "a:1";
        s.callId = "call-1";
        s.thread = "t";
        s.seq = 3;
        s.kind = "SELECT";
        s.sql = "SELECT balance FROM wallet WHERE user_id = ?";
        s.params = Collections.singletonList(Collections.singletonList(Value.of("BIGINT", "1042")));
        s.outcome = new Outcome("ROWS");
        s.outcome.columns = Collections.singletonList(new String[]{"balance", "DECIMAL"});
        s.outcome.rowsRead = 1L;
        s.rows = Collections.singletonList(Arrays.asList(Value.of("DECIMAL", "500.00"), null));
        Map<String, Long> dropped = new HashMap<>();
        dropped.put("call-1", 2L);
        String json = BatchWriter.write("a", "wallet-app", Collections.singletonList(s),
                Collections.singletonList(new MarkerRecord("call-1", 0, "CALL_OPEN", "t0", null, null, "default task-4")), dropped);
        Object parsed = MiniJson.parse(json);
        assertThat(parsed).isInstanceOf(Map.class);
        assertThat(json).contains("\"kind\":\"ROWS\"", "\"columns\":[{\"name\":\"balance\",\"type\":\"DECIMAL\"}]",
                "\"rows\":[[{\"type\":\"DECIMAL\",\"value\":\"500.00\"},null]]", "\"droppedByCall\":{\"call-1\":2}",
                "\"markers\":[{\"callId\":\"call-1\",\"seq\":0,\"type\":\"CALL_OPEN\",\"at\":\"t0\",\"thread\":\"default task-4\"}]");
    }

    @Test
    void writesTheOriginOfAnOrmStatement() {
        StatementRecord s = new StatementRecord();
        s.sid = "a:1";
        s.thread = "t";
        s.kind = "SELECT";
        s.sql = "select o.name from TT_ORG o where o.id=?";
        s.outcome = new Outcome("ROWS");
        s.origin = new OriginRecord();
        s.origin.id = "a:q1";
        s.origin.kind = "HQL";
        s.origin.text = "select o.name from Org o where o.id = :orgId";
        s.origin.method = "list";
        s.origin.params = Collections.singletonList(new String[]{":orgId", "948"});
        s.origin.maxResults = 50;
        String json = BatchWriter.write("a", null, Collections.singletonList(s), Collections.emptyList(), Collections.emptyMap());
        assertThat(MiniJson.parse(json)).isInstanceOf(Map.class);
        assertThat(json).contains("\"origin\":{\"id\":\"a:q1\",\"kind\":\"HQL\",\"text\":\"select o.name from Org o where o.id = :orgId\","
                + "\"method\":\"list\",\"params\":[{\"name\":\":orgId\",\"value\":\"948\"}],\"maxResults\":50}");
    }
}
