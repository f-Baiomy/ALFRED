package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.LogEventAdvice;
import net.bytebuddy.agent.builder.AgentBuilder;

import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

/**
 * The logging hooks (specs/009-agent-log-capture, research R1) - one per framework, where an event has passed the
 * application's own level check and is about to reach its handlers/appenders. slf4j and jboss-logging need none of
 * their own: they forward to one of these.
 */
final class LogInstrumentation {

    private LogInstrumentation() {
    }

    static AgentBuilder add(AgentBuilder builder) {
        // WildFly: every logging API (JUL, slf4j, jboss-logging, log4j through the bridges) ends here
        builder = Instrumenter.advise(builder, named("org.jboss.logmanager.Logger"), LogEventAdvice.class,
                named("logRaw").and(takesArguments(1)));
        builder = Instrumenter.advise(builder, named("java.util.logging.Logger"), LogEventAdvice.class,
                named("log").and(takesArguments(1)).and(takesArgument(0, named("java.util.logging.LogRecord"))));
        builder = Instrumenter.advise(builder, named("ch.qos.logback.classic.Logger"), LogEventAdvice.class,
                named("callAppenders").and(takesArguments(1)));
        builder = Instrumenter.advise(builder, named("org.apache.logging.log4j.core.config.LoggerConfig"), LogEventAdvice.class,
                named("log").and(takesArgument(0, named("org.apache.logging.log4j.core.LogEvent"))));
        builder = Instrumenter.advise(builder, named("org.apache.log4j.Category"), LogEventAdvice.class,
                named("callAppenders").and(takesArguments(1)));
        return builder;
    }
}
