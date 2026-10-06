package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.capture.CaptureDispatcher;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.BatchSender;
import com.fathy.alfred.dbagent.transport.StatementSink;

import java.lang.instrument.Instrumentation;
import java.util.UUID;

/**
 * The agent proper - only ever loaded after {@link AlfredDbAgent#injectBootstrap} (see that class for why).
 */
public final class AgentRuntime {

    private AgentRuntime() {
    }

    /** Called reflectively by {@link AlfredDbAgent}. */
    public static void start(String args, Instrumentation instrumentation) {
        AgentConfig config = AgentConfig.parse(args);
        AgentSettings settings = new AgentSettings();
        String agentId = config.project + "-" + UUID.randomUUID().toString().substring(0, 8);
        Holder holder = new Holder();
        BatchSender sender = new BatchSender(config.alfredUrl, config.secret, config.project, agentId, AlfredDbAgent.VERSION, settings,
                holder::flushStale);
        holder.dispatcher = install(instrumentation, sender, settings, agentId);
        CaptureDispatcher dispatcher = holder.dispatcher;
        sender.redisSeen(dispatcher::redisSeen);
        sender.start();
        AgentLog.info("v" + AlfredDbAgent.VERSION + " capturing database statements for project '" + config.project + "', reporting to " + config.alfredUrl);
    }

    /** Installs the instrumentation with a given sink - the agent's own start path, and the tests'. */
    public static CaptureDispatcher install(Instrumentation instrumentation, StatementSink sink, AgentSettings settings, String agentId) {
        CaptureDispatcher dispatcher = new CaptureDispatcher(sink, settings, agentId);
        Instrumenter.install(instrumentation, dispatcher);
        return dispatcher;
    }

    /** Lets the sender reach the dispatcher created after it. */
    private static final class Holder {
        volatile CaptureDispatcher dispatcher;

        void flushStale() {
            CaptureDispatcher d = dispatcher;
            if (d != null) {
                d.flushStale();
            }
        }
    }
}
