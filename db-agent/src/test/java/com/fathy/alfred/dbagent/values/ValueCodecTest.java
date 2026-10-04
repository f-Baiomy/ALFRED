package com.fathy.alfred.dbagent.values;

import com.fathy.alfred.dbagent.transport.Value;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.sql.Types;

import static org.assertj.core.api.Assertions.assertThat;

class ValueCodecTest {

    @Test
    void parametersKeepTheirExactText() {
        assertThat(ValueCodec.parameter("setBigDecimal", new Object[]{1, new BigDecimal("380.00")}).value).isEqualTo("380.00");
        assertThat(ValueCodec.parameter("setBigDecimal", new Object[]{1, new BigDecimal("1E+3")}).value).isEqualTo("1000");
        assertThat(ValueCodec.parameter("setLong", new Object[]{1, 1042L}).type).isEqualTo("BIGINT");
        Value ts = ValueCodec.parameter("setTimestamp", new Object[]{2, Timestamp.valueOf("2026-10-04 18:02:43.456")});
        assertThat(ts.type).isEqualTo("TIMESTAMP");
        assertThat(ts.value).isEqualTo("2026-10-04 18:02:43.456");
        assertThat(ValueCodec.parameter("setBytes", new Object[]{1, new byte[]{1, 2, 3}}).value).isEqualTo("AQID");
    }

    @Test
    void nullsAndObjects() {
        Value n = ValueCodec.parameter("setNull", new Object[]{1, Types.DECIMAL});
        assertThat(n.type).isEqualTo("DECIMAL");
        assertThat(n.value).isNull();
        assertThat(ValueCodec.parameter("setObject", new Object[]{1, "x", Types.NVARCHAR}).type).isEqualTo("NVARCHAR");
        assertThat(ValueCodec.parameter("setObject", new Object[]{1, 5}).type).isEqualTo("INTEGER");
    }

    @Test
    void streamsAreNeverConsumed() {
        ByteArrayInputStream stream = new ByteArrayInputStream(new byte[]{1, 2, 3});
        Value v = ValueCodec.parameter("setBinaryStream", new Object[]{1, stream});
        assertThat(v.opaque).isTrue();
        assertThat(stream.available()).isEqualTo(3);
    }

    @Test
    void unknownObjectsAreOpaque() {
        Value v = ValueCodec.column("STRUCTY", "getObject", new Object() {
            @Override
            public String toString() {
                return "custom";
            }
        });
        assertThat(v.opaque).isTrue();
        assertThat(v.value).isEqualTo("custom");
    }
}
