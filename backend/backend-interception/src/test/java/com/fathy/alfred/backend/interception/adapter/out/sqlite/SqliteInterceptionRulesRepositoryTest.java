package com.fathy.alfred.backend.interception.adapter.out.sqlite;

import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.fathy.alfred.backend.interception.domain.model.SourceCallRef;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SqliteInterceptionRulesRepositoryTest {

    @TempDir
    Path tempDir;

    private SqliteInterceptionRulesRepository repository;

    @BeforeEach
    void setUp() {
        repository = open(tempDir.resolve("interception.db"));
    }

    @AfterEach
    void tearDown() {
        repository.close();
    }

    private static SqliteInterceptionRulesRepository open(Path file) {
        SqliteInterceptionRulesRepository repo = new SqliteInterceptionRulesRepository();
        ReflectionTestUtils.setField(repo, "dbFile", file.toString());
        repo.init();
        return repo;
    }

    private static InterceptionRule rule(String id, SourceCallRef source) {
        RuleAction delay = new ObjectMapper().convertValue(Map.of("type", ActionType.DELAY_REQUEST.name(), "durationMs", 5), RuleAction.class);
        return new InterceptionRule(id, "Rule " + id, null, true, 10, false, RuleMatch.empty(), List.of(delay), source, "t", "t");
    }

    @Test
    void aSaveThatFailsPartWayLeavesEveryRuleThatWasThere() {
        repository.saveAll(List.of(rule("a", null), rule("b", null), rule("c", null)));

        // Two rules with one id: the second insert fails on the primary key. Before the save was a
        // single transaction, the delete had already committed and only "x" survived.
        assertThatThrownBy(() -> repository.saveAll(List.of(rule("x", null), rule("x", null))))
                .isInstanceOf(RuntimeException.class);

        assertThat(repository.findAll()).extracting(InterceptionRule::id).containsExactly("a", "b", "c");
    }

    @Test
    void theCallARuleWasMadeFromIsKept() {
        SourceCallRef source = new SourceCallRef("inbound", "call-7", "cycle-2", "POST localhost/app/cart", "odeysys");
        repository.saveAll(List.of(rule("a", source), rule("b", null)));

        List<InterceptionRule> rules = repository.findAll();
        assertThat(rules.get(0).sourceCall()).isEqualTo(source);
        assertThat(rules.get(1).sourceCall()).isNull();
    }

    @Test
    void aDatabaseFromBeforeTheSourceCallColumnGainsIt() throws Exception {
        Path old = tempDir.resolve("old.db");
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + old);
             Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE interception_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                    enabled INTEGER NOT NULL, priority INTEGER NOT NULL, stop_processing INTEGER NOT NULL,
                    match_json TEXT NOT NULL, actions_json TEXT NOT NULL, created_at TEXT, updated_at TEXT)""");
            statement.execute("INSERT INTO interception_rules VALUES ('old', 'Old rule', NULL, 1, 10, 0, '{}', "
                    + "'[{\"type\":\"DELAY_REQUEST\",\"durationMs\":5}]', 't', 't')");
        }
        SqliteInterceptionRulesRepository upgraded = open(old);
        try {
            assertThat(upgraded.findAll()).extracting(InterceptionRule::name).containsExactly("Old rule");
            assertThat(upgraded.findAll().get(0).sourceCall()).isNull();
        } finally {
            upgraded.close();
        }
    }
}
