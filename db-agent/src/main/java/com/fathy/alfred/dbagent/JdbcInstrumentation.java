package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.AddBatchAdvice;
import com.fathy.alfred.dbagent.advice.AutoCommitAdvice;
import com.fathy.alfred.dbagent.advice.ConnectionCloseAdvice;
import com.fathy.alfred.dbagent.advice.DataSourceAdvice;
import com.fathy.alfred.dbagent.advice.JtaAdvice;
import com.fathy.alfred.dbagent.advice.ClearParametersAdvice;
import com.fathy.alfred.dbagent.advice.ExecuteAdvice;
import com.fathy.alfred.dbagent.advice.HttpClientAdvice;
import com.fathy.alfred.dbagent.advice.HttpUrlConnectionAdvice;
import com.fathy.alfred.dbagent.advice.OutParameterAdvice;
import com.fathy.alfred.dbagent.advice.ParameterAdvice;
import com.fathy.alfred.dbagent.advice.ResultSetCloseAdvice;
import com.fathy.alfred.dbagent.advice.ResultSetGetAdvice;
import com.fathy.alfred.dbagent.advice.ResultSetNextAdvice;
import com.fathy.alfred.dbagent.advice.ResultSetOpenedAdvice;
import com.fathy.alfred.dbagent.advice.StatementCloseAdvice;
import com.fathy.alfred.dbagent.advice.StatementCreatedAdvice;
import com.fathy.alfred.dbagent.advice.TransactionAdvice;
import com.fathy.alfred.dbagent.advice.UrlOpenConnectionAdvice;
import com.fathy.alfred.dbagent.advice.WasNullAdvice;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.matcher.ElementMatcher;

import static com.fathy.alfred.dbagent.Instrumenter.advise;
import static net.bytebuddy.matcher.ElementMatchers.hasSuperType;
import static net.bytebuddy.matcher.ElementMatchers.isInterface;
import static net.bytebuddy.matcher.ElementMatchers.isSubTypeOf;
import static net.bytebuddy.matcher.ElementMatchers.isPublic;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.returns;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

/**
 * JDBC by INTERFACE, so every driver and every pool wrapper is covered (Oracle, PostgreSQL, MySQL/MariaDB, SQL Server,
 * H2, IronJacamar's wrappers ...), plus the two outbound HTTP clients a Java EE application uses: the JDK's
 * HttpURLConnection and Apache HttpClient 4/5 (which RESTEasy's client also runs on).
 */
final class JdbcInstrumentation {

    private JdbcInstrumentation() {
    }

    private static ElementMatcher.Junction<TypeDescription> implementing(Class<?> jdbcInterface) {
        return isSubTypeOf(jdbcInterface).and(not(isInterface()));
    }

    private static ElementMatcher.Junction<MethodDescription> indexOrLabel() {
        return takesArgument(0, int.class).or(takesArgument(0, String.class));
    }

    static AgentBuilder add(AgentBuilder builder) {
        ElementMatcher.Junction<TypeDescription> connections = implementing(java.sql.Connection.class);
        ElementMatcher.Junction<TypeDescription> statements = implementing(java.sql.Statement.class);
        ElementMatcher.Junction<TypeDescription> prepared = implementing(java.sql.PreparedStatement.class);
        ElementMatcher.Junction<TypeDescription> callable = implementing(java.sql.CallableStatement.class);
        ElementMatcher.Junction<TypeDescription> resultSets = implementing(java.sql.ResultSet.class);

        builder = advise(builder, connections, StatementCreatedAdvice.class,
                namedOneOf("prepareStatement", "prepareCall", "createStatement").and(isPublic()));
        builder = advise(builder, connections, AutoCommitAdvice.class, named("setAutoCommit").and(takesArguments(boolean.class)));
        // Connection lifecycle: checkout, hand-back, and container-managed (JTA) commit - the per-transaction overhead
        // a statement list cannot show.
        builder = advise(builder, implementing(javax.sql.DataSource.class), DataSourceAdvice.class,
                named("getConnection").and(isPublic()).and(takesArguments(0).or(takesArguments(2))));
        builder = advise(builder, connections, ConnectionCloseAdvice.class, named("close").and(takesArguments(0)));
        builder = advise(builder, hasSuperType(namedOneOf("javax.transaction.Transaction", "javax.transaction.TransactionManager",
                        "javax.transaction.UserTransaction", "jakarta.transaction.Transaction", "jakarta.transaction.TransactionManager",
                        "jakarta.transaction.UserTransaction")).and(not(isInterface())),
                JtaAdvice.class, namedOneOf("commit", "rollback").and(takesArguments(0)).and(isPublic()));
        builder = advise(builder, connections, TransactionAdvice.class,
                namedOneOf("commit", "rollback", "setSavepoint").and(takesArguments(0).or(takesArguments(1))));

        builder = advise(builder, prepared, ParameterAdvice.class, isPublic().and(
                nameStartsWith("set").and(indexOrLabel()).and(takesArguments(2).or(takesArguments(3)).or(takesArguments(4))))
                .or(named("registerOutParameter")));
        builder = advise(builder, statements, AddBatchAdvice.class, named("addBatch"));
        builder = advise(builder, prepared, ClearParametersAdvice.class, named("clearParameters").and(takesArguments(0)));
        builder = advise(builder, statements, ExecuteAdvice.class, isPublic().and(namedOneOf("execute", "executeQuery", "executeUpdate",
                "executeLargeUpdate", "executeBatch", "executeLargeBatch")));
        builder = advise(builder, statements, ResultSetOpenedAdvice.class,
                namedOneOf("getResultSet", "getGeneratedKeys").and(takesArguments(0)));
        builder = advise(builder, callable, OutParameterAdvice.class, isPublic().and(nameStartsWith("get")).and(indexOrLabel())
                .and(takesArguments(1).or(takesArguments(2))).and(not(namedOneOf("getMoreResults"))).and(not(returns(void.class))));
        builder = advise(builder, statements, StatementCloseAdvice.class, named("close").and(takesArguments(0)));

        builder = advise(builder, resultSets, ResultSetNextAdvice.class, named("next").and(takesArguments(0)).and(returns(boolean.class)));
        builder = advise(builder, resultSets, ResultSetGetAdvice.class, isPublic().and(nameStartsWith("get")).and(indexOrLabel())
                .and(takesArguments(1).or(takesArguments(2))).and(not(returns(void.class))));
        builder = advise(builder, resultSets, WasNullAdvice.class, named("wasNull").and(takesArguments(0)));
        builder = advise(builder, resultSets, ResultSetCloseAdvice.class, named("close").and(takesArguments(0)));

        builder = advise(builder, named("java.net.URL"), UrlOpenConnectionAdvice.class,
                named("openConnection").and(takesArguments(0).or(takesArguments(1))));
        builder = advise(builder, named("sun.net.www.protocol.http.HttpURLConnection"), HttpUrlConnectionAdvice.class,
                namedOneOf("connect", "getOutputStream", "getInputStream").and(takesArguments(0)));
        builder = advise(builder, hasSuperType(namedOneOf("org.apache.http.impl.client.CloseableHttpClient",
                        "org.apache.hc.client5.http.impl.classic.CloseableHttpClient")).and(not(isInterface())),
                HttpClientAdvice.class, named("doExecute"));
        return builder;
    }
}
