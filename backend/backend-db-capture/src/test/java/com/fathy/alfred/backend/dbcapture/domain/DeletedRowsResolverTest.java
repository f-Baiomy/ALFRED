package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class DeletedRowsResolverTest {

    private static StatementOutcome rows(long n) {
        return new StatementOutcome(OutcomeKind.ROWS, List.of(new Column("id", "BIGINT")), n, false, false, null, null, null, null, null, null, null,
                null, null, null, null);
    }

    private static DeletedRowsResolver.Read select(int seq, String sql, String table, String param, long stored) {
        return new DeletedRowsResolver.Read(seq, StatementKind.SELECT, sql, table, List.of(TypedValue.of("BIGINT", param)), rows(stored), stored);
    }

    private static List<TypedValue> params(String... values) {
        return Arrays.stream(values).map(v -> TypedValue.of("BIGINT", v)).toList();
    }

    @Test
    void aDeleteTakesItsRowsFromTheLatestEarlierReadOfTheSameRows() {
        List<DeletedRowsResolver.Read> earlier = List.of(
                select(3, "SELECT id, sku, qty FROM cart_items WHERE user_id = ?", "cart_items", "1042", 3),
                select(5, "SELECT id FROM cart_items WHERE user_id = ?", "cart_items", "7", 1),
                select(8, "select id, sku FROM cart_items where user_id = ? ORDER BY id", "cart_items", "1042", 3));
        BeforeImage image = DeletedRowsResolver.resolve("DELETE FROM cart_items WHERE user_id = ?", "cart_items", params("1042"), earlier);
        assertThat(image.source()).isEqualTo(BeforeImage.EARLIER_READ);
        assertThat(image.earlierSeq()).isEqualTo(8);
        assertThat(image.rowCount()).isEqualTo(3);
    }

    @Test
    void anUpdateMatchesAReadWhoseConditionsItAlsoHas() {
        List<DeletedRowsResolver.Read> earlier = List.of(
                select(1, "SELECT balance, currency, version FROM wallet WHERE user_id = ? FOR UPDATE", "wallet", "1042", 1));
        BeforeImage image = DeletedRowsResolver.resolve("UPDATE wallet SET balance = ?, version = ? WHERE user_id = ? AND version = ?", "wallet",
                params("380.00", "42", "1042", "41"), earlier);
        assertThat(image).isNotNull();
        assertThat(image.earlierSeq()).isEqualTo(1);
    }

    @Test
    void nothingIsGuessed() {
        List<DeletedRowsResolver.Read> earlier = List.of(
                select(1, "SELECT id FROM cart_items WHERE user_id = ?", "cart_items", "7", 2),
                select(2, "SELECT id FROM orders WHERE user_id = ?", "orders", "1042", 2),
                select(3, "SELECT id FROM cart_items WHERE user_id = ? OR vip = 1", "cart_items", "1042", 2),
                select(4, "SELECT id FROM cart_items WHERE user_id = ?", "cart_items", "1042", 0));
        assertThat(DeletedRowsResolver.resolve("DELETE FROM cart_items WHERE user_id = ?", "cart_items", params("1042"), earlier)).isNull();
        assertThat(DeletedRowsResolver.resolve("DELETE FROM cart_items", "cart_items", params(), earlier)).isNull();
    }
}
