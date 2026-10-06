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

        /** setAutoCommit(false) returned after {@code nanos} - the transaction's begin. */
        default void autoCommitDone(Object connection, long nanos) {
        }

        /** DataSource.getConnection starts; token for {@link #acquireExit} (null when nested inside another one). */
        default Object acquireEnter() {
            return null;
        }

        default void acquireExit(Object token, Object connection) {
        }

        /** Connection.close starts; token for {@link #closeExit}. */
        default Object closeEnter(Object connection) {
            return null;
        }

        default void closeExit(Object token) {
        }

        /** A JTA commit/rollback starts (Transaction, TransactionManager, UserTransaction); token for {@link #jtaExit}. */
        default Object jtaEnter(String method) {
            return null;
        }

        default void jtaExit(Object token, Throwable thrown) {
        }

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

        /** URL.openConnection returned an HttpURLConnection: tag it now, while it cannot be connected yet. */
        default void outboundOpened(Object connection) {
        }

        /** {@link #outboundHeader} once per connection/request object: every later call for the same object returns the
         *  same value and records no further marker (a connection's hooks run on connect, getOutputStream and every
         *  getInputStream - one per response header read on HTTPS). */
        default String outboundHeaderFor(Object connection, String method, String url) {
            return outboundHeader(method, url);
        }

        /** Tags an Apache HttpClient request object (4.x or 5.x) - reflection, so no client is a dependency. */
        void tagHttpClientRequest(Object request);

        // ---------------------------------------------------------------- logging (specs/009-agent-log-capture)

        /** A logging framework dispatches {@code event} (declaring type {@code type}); token for {@link #logExit}. */
        default Object logEnter(String type, Object self, Object event) {
            return null;
        }

        default void logExit(Object token) {
        }

        // ---------------------------------------------------------------- Redis (specs/011-redis-capture)
        // Clients are reached by name and reflection only: {@code client} is "lettuce", "jedis" or "redisson".

        /** A Lettuce command is handed to its endpoint, or a Redisson CommandData is created - on the sending side. */
        default void redisCommandCreated(String client, Object command, Object endpoint) {
        }

        /** A client starts writing {@code msg} (one command or a collection) into {@code buffer}; token for {@link #redisEncodeExit}. */
        default Object redisEncodeEnter(String client, Object channelContext, Object msg, Object buffer) {
            return null;
        }

        default void redisEncodeExit(Object token) {
        }

        /** A client starts decoding the reply of {@code command} from {@code buffer}; token for {@link #redisDecodeExit}. */
        default Object redisDecodeEnter(String client, Object command, Object buffer) {
            return null;
        }

        /** {@code done}: the reply is complete (Lettuce returns false while more bytes are needed). */
        default void redisDecodeExit(Object token, boolean done, Throwable thrown) {
        }

        /** Jedis Connection.sendCommand starts - {@code command} is a ProtocolCommand or CommandArguments, {@code args}
         *  the byte[] arguments when given separately; token for {@link #redisJedisSendExit}. */
        default Object redisJedisSend(Object connection, Object command, Object args) {
            return null;
        }

        default void redisJedisSendExit(Object token, Throwable thrown) {
        }

        /** Jedis starts reading one reply on {@code connection}; token for {@link #redisJedisReply}. */
        default Object redisJedisReadEnter(Object connection) {
            return null;
        }

        /** The reply was read: {@code result}, or {@code thrown} (an error reply raises in Jedis). */
        default void redisJedisReply(Object token, Object result, Throwable thrown) {
        }

        /** Jedis RedisInputStream is about to refill its buffer - the bytes read so far must be kept first. */
        default void redisJedisFill(Object stream) {
        }

        /** Lettuce auto-flush switched (false = the application pipelines until flushCommands). */
        default void redisAutoFlush(Object endpoint, boolean on) {
        }

        /** Lettuce flushCommands: a pipeline ends. */
        default void redisFlush(Object endpoint) {
        }

        /** A Redisson RedisExecutor was created (on the caller's thread) / starts / ends sending. */
        default void redisExecutorCreated(Object executor) {
        }

        default Object redisExecutorSendEnter(Object executor, Object connection) {
            return null;
        }

        default void redisExecutorSendExit(Object token) {
        }

        /** Spring Cache: {@code kind} "aspect" (CacheAspectSupport.execute: args[2] the Method, args[3] its arguments) or
         *  the RedisCache method name ("lookup", "put", …) with {@code self} the cache; token for {@link #redisOriginExit}. */
        default Object redisOriginEnter(String kind, Object self, Object[] args) {
            return null;
        }

        default void redisOriginExit(Object token) {
        }

        /** A Redis connection pool hands out a connection (JedisPool.getResource, commons-pool2 borrowObject). */
        default Object redisPoolEnter(Object pool) {
            return null;
        }

        default void redisPoolExit(Object token, Object resource) {
        }
    }
}
