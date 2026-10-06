package org.jboss.logmanager;

import java.util.logging.Level;
import java.util.logging.LogRecord;

/** A stand-in for jboss-logmanager's ExtLogRecord (test sources only - never shaded): the getters the agent reads. */
public class ExtLogRecord extends LogRecord {

    private final String threadName = Thread.currentThread().getName();

    public ExtLogRecord(Level level, String msg, String loggerName) {
        super(level, msg);
        setLoggerName(loggerName);
    }

    public String getFormattedMessage() {
        return getMessage();
    }

    public String getThreadName() {
        return threadName;
    }
}
