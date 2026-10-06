package org.jboss.logmanager;

/**
 * A stand-in for jboss-logmanager's Logger (test sources only): logRaw is where WildFly sends every event. It also
 * hands the record to a plain JUL logger, the way a bridge would - the agent must still catch the event once.
 */
public class Logger {

    private final java.util.logging.Logger handlers = java.util.logging.Logger.getLogger("org.jboss.logmanager.fake");

    public void logRaw(ExtLogRecord record) {
        handlers.log(record);
    }
}
