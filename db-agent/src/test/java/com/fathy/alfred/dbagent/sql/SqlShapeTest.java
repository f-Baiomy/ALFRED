package com.fathy.alfred.dbagent.sql;

import com.fathy.alfred.dbagent.transport.Value;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.assertj.core.api.Assertions.assertThat;

class SqlShapeTest {

    @Test
    void kinds() {
        assertThat(SqlShape.kind("select * from users")).isEqualTo("SELECT");
        assertThat(SqlShape.kind("  /* hint */ SELECT 1")).isEqualTo("SELECT");
        assertThat(SqlShape.kind("-- note\nINSERT INTO payments VALUES (?)")).isEqualTo("INSERT");
        assertThat(SqlShape.kind("update wallet set balance = ?")).isEqualTo("UPDATE");
        assertThat(SqlShape.kind("DELETE FROM cart_items WHERE user_id = ?")).isEqualTo("DELETE");
        assertThat(SqlShape.kind("MERGE INTO t USING s ON (1=1)")).isEqualTo("MERGE");
        assertThat(SqlShape.kind("{call calc_fees(?, ?, ?)}")).isEqualTo("CALL");
        assertThat(SqlShape.kind("{? = call f(?)}")).isEqualTo("CALL");
        assertThat(SqlShape.kind("WITH x AS (SELECT 1 FROM dual) UPDATE t SET a = 1")).isEqualTo("UPDATE");
        assertThat(SqlShape.kind("WITH x AS (SELECT 1) SELECT * FROM x")).isEqualTo("SELECT");
        assertThat(SqlShape.kind("(SELECT 1) UNION (SELECT 2)")).isEqualTo("SELECT");
        assertThat(SqlShape.kind("CREATE TABLE t (a INT)")).isEqualTo("DDL");
    }

    @Test
    void tables() {
        assertThat(SqlShape.table("SELECT id FROM users WHERE id = ?")).isEqualTo("users");
        assertThat(SqlShape.table("INSERT INTO \"payments\" (a) VALUES (?)")).isEqualTo("payments");
        assertThat(SqlShape.table("UPDATE wallet SET balance = ?")).isEqualTo("wallet");
        assertThat(SqlShape.table("DELETE FROM app.rate_cache")).isEqualTo("app.rate_cache");
        assertThat(SqlShape.table("{call calc_fees(?, ?)}")).isEqualTo("calc_fees");
        assertThat(SqlShape.table("COMMIT")).isNull();
    }

    @Test
    void fingerprintIgnoresWhitespaceAndCaseButNotParameterTypes() {
        String a = SqlShape.fingerprint("SELECT a FROM t WHERE id = ?", Collections.singletonList(Value.of("BIGINT", "1")));
        String b = SqlShape.fingerprint("select  a\n from t where id = ?", Collections.singletonList(Value.of("BIGINT", "2")));
        String c = SqlShape.fingerprint("SELECT a FROM t WHERE id = ?", Collections.singletonList(Value.of("VARCHAR", "1")));
        assertThat(a).isEqualTo(b).hasSize(16);
        assertThat(a).isNotEqualTo(c);
        assertThat(SqlShape.fingerprint("SELECT 1", Arrays.asList())).isNotEqualTo(a);
    }
}
