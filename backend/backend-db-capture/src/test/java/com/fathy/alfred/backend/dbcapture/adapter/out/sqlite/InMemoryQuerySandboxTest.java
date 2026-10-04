package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class InMemoryQuerySandboxTest {

    private final InMemoryQuerySandbox sandbox = new InMemoryQuerySandbox();
    private static final List<String> COLUMNS = List.of("id", "amount", "kind");

    private static List<List<Object>> rows() {
        List<List<Object>> rows = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            rows.add(List.of((long) i, i * 10.5, i % 3 == 0 ? "TOPUP" : "PAY"));
        }
        return rows;
    }

    private RecordedQueryResult run(String sql) {
        return sandbox.run("result", COLUMNS, rows(), sql, List.of(), 0, 100);
    }

    @Test
    void filtersSortsGroupsAndPagesNumerically() {
        RecordedQueryResult r = run("SELECT * FROM result WHERE amount > 500 AND kind = 'PAY' ORDER BY amount DESC");
        assertThat(r.error()).isNull();
        assertThat(r.total()).isEqualTo(168); // ids 48..299 (amount > 500) that are not multiples of 3
        assertThat(r.rows().get(0)).containsExactly("299", "3139.5", "PAY");

        RecordedQueryResult grouped = run("SELECT kind, COUNT(*) AS n_rows, SUM(amount) FROM result GROUP BY kind ORDER BY kind");
        assertThat(grouped.columns()).containsExactly("kind", "n_rows", "SUM(amount)");
        assertThat(grouped.rows()).extracting(row -> row.get(0) + "=" + row.get(1)).containsExactly("PAY=200", "TOPUP=100");

        RecordedQueryResult page = sandbox.run("result", COLUMNS, rows(), "SELECT id FROM result ORDER BY id LIMIT 250", List.of(), 200, 100);
        assertThat(page.total()).isEqualTo(250);
        assertThat(page.rows()).hasSize(50);
        assertThat(page.rows().get(0)).containsExactly("200");
    }

    @Test
    void rejectsAnythingButOneSelect() {
        assertThat(run("DELETE FROM result").error()).contains("Only a SELECT");
        assertThat(run("PRAGMA table_info(result)").error()).contains("Only a SELECT");
        assertThat(run("ATTACH DATABASE '/dbcapturedb/db-capture.db' AS x").error()).contains("Only a SELECT");
        assertThat(run("SELECT 1; DROP TABLE result").error()).contains("One statement");
        assertThat(run("SELECT 'a;b' AS x FROM result LIMIT 1;").error()).isNull();
        assertThat(run("WITH x AS (SELECT * FROM result) SELECT COUNT(*) FROM x").rows().get(0)).containsExactly("300");
    }

    @Test
    void seesNothingButItsOwnTable_andExplainsMistakes() {
        assertThat(run("SELECT * FROM statements").error()).contains("no such table");
        assertThat(run("SELECT name FROM sqlite_master WHERE type = 'table'").rows()).extracting(r -> r.get(0)).containsExactly("result");
        assertThat(run("SELECT balance FROM result").error()).isEqualTo("No column \"balance\". Columns: id, amount, kind");
        assertThat(run("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c").error())
                .contains("longer than 3 s");
    }

    @Test
    void returnsTheSelectedStatementNumbersAcrossAllPages() {
        List<List<Object>> statements = new ArrayList<>();
        for (int i = 1; i <= 150; i++) {
            statements.add(List.of(i, i % 2 == 0 ? "UPDATE" : "SELECT"));
        }
        RecordedQueryResult r = sandbox.run("statements", List.of("n", "verb"), statements, "SELECT n FROM statements WHERE verb = 'UPDATE'",
                List.of(), 0, 10);
        assertThat(r.rows()).hasSize(10);
        assertThat(r.statementSeqs()).hasSize(75).startsWith(2, 4, 6);
    }
}
