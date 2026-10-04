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
                Collections.singletonList(new MarkerRecord("call-1", 0, "CALL_OPEN", "t0", null, null)), dropped);
        Object parsed = MiniJson.parse(json);
        assertThat(parsed).isInstanceOf(Map.class);
        assertThat(json).contains("\"kind\":\"ROWS\"", "\"columns\":[{\"name\":\"balance\",\"type\":\"DECIMAL\"}]",
                "\"rows\":[[{\"type\":\"DECIMAL\",\"value\":\"500.00\"},null]]", "\"droppedByCall\":{\"call-1\":2}",
                "\"markers\":[{\"callId\":\"call-1\",\"seq\":0,\"type\":\"CALL_OPEN\",\"at\":\"t0\"}]");
    }
}
