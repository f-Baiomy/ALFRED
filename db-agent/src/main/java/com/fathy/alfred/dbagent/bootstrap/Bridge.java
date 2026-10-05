package com.fathy.alfred.dbagent.bootstrap;

/**
 * The only agent class the instrumented code ever references. It is put on the BOOTSTRAP class path before anything
 * is instrumented, so it is visible from every class loader - including WildFly's JBoss Modules, whose module
 * loaders cannot see the system class path the agent jar itself is on (see JBossModulesAdvice for the one place
 * that needs an extra nudge). Advice inlined into JDBC drivers, servlets and HTTP clients reads
 * {@link #dispatcher}; everything else lives in the agent's own loader, behind {@link Dispatcher}.
 *
 * <p>Only JDK types cross this boundary, for the same reason.
 */
public final class Bridge {

    /** Null until the agent finished starting - advice treats null as "do nothing". */
    public static volatile Dispatcher dispatcher;

    private Bridge() {
    }

    /** Everything the inlined advice can ask of the agent. Every method must be safe to call from any thread and must
     *  never throw into the application. */
    public interface Dispatcher {

        /** A servlet request starts; returns a token for {@link #servletExit}, or null when this request is not captured. */
        Object servletEnter(Object request);

        void servletExit(Object token, Throwable thrown);

        /** Wraps work handed to another thread so it keeps the submitting thread's call (or returns it unchanged). */
        Object wrapRunnable(Object runnable);

        Object wrapCallable(Object callable);

        // ---------------------------------------------------------------- JDBC

        /** prepareStatement/prepareCall/createStatement returned {@code statement} on {@code connection}. */
        void statementCreated(Object connection, Object statement, String sql);

        /** A set*, setNull, setObject or registerOutParameter call on a statement. */
        void parameter(Object statement, String method, Object[] args);

        void addBatch(Object statement, Object[] args);

        void clearParameters(Object statement);

        /** An execute* starts; returns a token for {@link #executeExit} (non-null whenever exit must run). */
        Object executeEnter(Object statement, String method, Object[] args);

        void executeExit(Object token, Object result, Throwable thrown);

        /** getResultSet/getGeneratedKeys returned {@code resultSet} for {@code statement}. */
        void resultSetOpened(Object statement, Object resultSet, String method);

        /** A get* on a CallableStatement after execute - an OUT parameter's value. */
        void outParameterRead(Object statement, Object[] args, Object value);

        void statementClosed(Object statement);

        void resultSetNext(Object resultSet, boolean hasRow);

        void resultSetGet(Object resultSet, String method, Object[] args, Object value);

        void resultSetWasNull(Object resultSet, boolean wasNull);

        void resultSetClosed(Object resultSet);

        void autoCommit(Object connection, boolean autoCommit);

        /** commit/rollback/setSavepoint/rollback(Savepoint) - token pattern like execute. */
        Object transactionEnter(Object connection, String method, Object[] args);

        void transactionExit(Object token, Throwable thrown);

        // ---------------------------------------------------------------- Hibernate / JPA (where a statement came from)

        /** A query's list/getResultList/uniqueResult/executeUpdate/... starts; token for {@link #originExit}. */
        default Object queryEnter(Object query, String method) {
            return null;
        }

        /** setParameter/setParameterList/typed setters, setFirstResult/setMaxResults on a query. */
        default void queryParameter(Object query, String method, Object[] args) {
        }

        /** createNamedQuery/getNamedQuery returned {@code query} for {@code name}. */
        default void queryNamed(Object query, String name) {
        }

        /** A Hibernate event that makes SQL on its own starts (collection initialise, entity load, flush, a flush
         *  action) - {@code type} is the instrumented class, {@code self}/{@code args} its receiver and arguments. */
        default Object hibernateEventEnter(String type, Object self, Object[] args) {
            return null;
        }

        default void originExit(Object token) {
        }

        // ---------------------------------------------------------------- outbound HTTP

        /** The X-Alfred-Parent value for an outbound request made now, or null outside a captured call. Records the
         *  HTTP_OUT marker at the same sequence number. */
        String outboundHeader(String method, String url);

        /** {@link #outboundHeader} once per connection/request object: every later call for the same object returns the
         *  same value and records no further marker (a connection's hooks run on connect, getOutputStream and every
         *  getInputStream - one per response header read on HTTPS). */
        default String outboundHeaderFor(Object connection, String method, String url) {
            return outboundHeader(method, url);
        }

        /** Tags an Apache HttpClient request object (4.x or 5.x) - reflection, so no client is a dependency. */
        void tagHttpClientRequest(Object request);
    }
}
