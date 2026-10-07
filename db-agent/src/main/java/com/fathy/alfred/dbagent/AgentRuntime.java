package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.bootstrap.TrustBridge;
import com.fathy.alfred.dbagent.capture.AgentFeatures;
import com.fathy.alfred.dbagent.capture.CaptureDispatcher;
import com.fathy.alfred.dbagent.proxy.ProxySwitch;
import com.fathy.alfred.dbagent.trust.AlfredCaTrust;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.BatchSender;
import com.fathy.alfred.dbagent.transport.StatementSink;

import java.lang.instrument.Instrumentation;
import java.util.UUID;

/**
 * The agent proper - only ever loaded after {@link AlfredDbAgent#injectBootstrap} (see that class for why).
 */
public final class AgentRuntime {

    public static final String FEATURES_PROPERTY = "alfred.agent.features";
    public static final String VERSION_PROPERTY = "alfred.agent.version";

    private static boolean captureStarted;
    /** The one sender, kept so a later attach with other arguments can redirect it (the agent cannot be loaded twice). */
    private static BatchSender sender;

    private AgentRuntime() {
    }

    /**
     * Called reflectively by {@link AlfredDbAgent} on EVERY load: the arguments carry the whole desired feature set, so
     * attaching again switches features on and off. Capture is installed the first time any of db/logs/redis is on and
     * then only gated; the proxy and the trust of Alfred's CA follow "proxy". The result is published as system
     * properties, which "alfred jvms" reads without loading anything.
     */
    public static synchronized void apply(String args, Instrumentation instrumentation) {
        AgentConfig config = AgentConfig.parse(args);
        AgentFeatures.db = config.has("db");
        AgentFeatures.logs = config.has("logs");
        AgentFeatures.redis = config.has("redis");
        if (config.captures() && !captureStarted) {
            start(config, instrumentation);
            captureStarted = true;
        } else if (config.captures() && sender != null) {
            sender.retarget(config.alfredUrl, config.secret);
        }
        if (config.has("proxy")) {
            ProxySwitch.on(config.proxy);
            trust(config, instrumentation);
        } else {
            ProxySwitch.off();
            TrustBridge.acceptor = null;
        }
        System.setProperty(FEATURES_PROPERTY, config.featureList());
        System.setProperty(VERSION_PROPERTY, AlfredDbAgent.VERSION);
        AgentLog.info("features: " + (config.featureList().isEmpty() ? "none" : config.featureList())
                + (config.has("proxy") ? " (outbound calls through " + config.proxy + ")" : ""));
    }

    private static void trust(AgentConfig config, Instrumentation instrumentation) {
        if (config.caFile == null) {
            return;
        }
        try {
            AlfredCaTrust trust = AlfredCaTrust.fromFile(config.caFile);
            TrustInstrumentation.install(instrumentation);
            TrustBridge.acceptor = trust;
        } catch (Exception e) {
            AgentLog.info("could not read Alfred's CA (" + e.getClass().getSimpleName() + ") - HTTPS through the proxy needs the CA in this JVM's trust store");
        }
    }

    private static void start(AgentConfig config, Instrumentation instrumentation) {
        AgentSettings settings = new AgentSettings();
        String agentId = config.project + "-" + UUID.randomUUID().toString().substring(0, 8);
        Holder holder = new Holder();
        BatchSender sender = new BatchSender(config.alfredUrl, config.secret, config.project, agentId, AlfredDbAgent.VERSION, settings,
                holder::flushStale);
        holder.dispatcher = install(instrumentation, sender, settings, agentId);
        CaptureDispatcher dispatcher = holder.dispatcher;
        sender.redisSeen(dispatcher::redisSeen);
        sender.start();
        AgentRuntime.sender = sender;
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
