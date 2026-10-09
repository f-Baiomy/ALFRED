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

    /** Set while the agent stands down because Alfred is unreachable: why and since when - "alfred jvms" shows it. */
    public static final String STANDBY_PROPERTY = "alfred.agent.standby";

    private static boolean captureStarted;
    /** The last attach's arguments and instrumentation - what {@link #resume} puts back after a stand-down. */
    private static AgentConfig desired;
    private static Instrumentation instrumentation;
    private static boolean standingDown;
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
        // An attach is Alfred asking (the supervisor, "alfred attach", proxy-on): Alfred is there, whatever the
        // sender last concluded - the new arguments are applied in full.
        standingDown = false;
        System.clearProperty(STANDBY_PROPERTY);
        desired = config;
        AgentRuntime.instrumentation = instrumentation;
        AgentFeatures.published = config.featureList();
        // Installed on the first load whatever the features: the hooks are gated by AgentFeatures, and a JVM loaded
        // with the proxy alone must still heartbeat (saying "features: proxy") and follow the reverse proxy that
        // delivers its calls - otherwise an Alfred with ◆ switched on sees an agent that is simply not there.
        if (!captureStarted) {
            start(config, instrumentation);
            captureStarted = true;
        } else if (sender != null) {
            sender.retarget(config.alfredUrl, config.secret);
        }
        switchOn(config, instrumentation);
        System.setProperty(FEATURES_PROPERTY, config.featureList());
        System.setProperty(VERSION_PROPERTY, AlfredDbAgent.VERSION);
        AgentLog.info("features: " + (config.featureList().isEmpty() ? "none" : config.featureList())
                + (config.has("proxy") ? " (outbound calls through " + config.proxy + ")" : ""));
    }

    /** The features of {@code config}, switched on and off as it says: capture gates, the proxy and the CA trust. */
    private static void switchOn(AgentConfig config, Instrumentation instrumentation) {
        AgentFeatures.db = config.has("db");
        AgentFeatures.logs = config.has("logs");
        AgentFeatures.redis = config.has("redis");
        if (config.has("proxy")) {
            ProxySwitch.on(config.proxy);
            trust(config, instrumentation);
        } else {
            ProxySwitch.off();
            TrustBridge.acceptor = null;
        }
    }

    /**
     * Alfred is gone (stopped, crashed, its container down - the sender's heartbeats stopped reaching it): everything
     * this agent switched on goes off together, so the application is never left sending its outbound calls to a proxy
     * nothing listens on. The app's own proxy settings come back, the CA is no longer trusted, nothing is captured.
     * The instrumentation stays loaded (a JVM cannot unload an agent) but is gated off. {@link #resume} undoes it.
     */
    public static synchronized void standDown(String why) {
        if (standingDown || desired == null) {
            return;
        }
        standingDown = true;
        // Said first: whoever reads the properties (an Alfred deciding whether this agent is still taken) never sees
        // the proxy off without the reason.
        System.setProperty(STANDBY_PROPERTY, why + " since " + new java.text.SimpleDateFormat("HH:mm").format(new java.util.Date()));
        AgentFeatures.db = false;
        AgentFeatures.logs = false;
        AgentFeatures.redis = false;
        ProxySwitch.off();
        TrustBridge.acceptor = null;
        AgentLog.info(why + " - outbound calls go direct, capture paused until Alfred is back");
    }

    /** Alfred answers again: the features of the last attach come back as they were. */
    public static synchronized void resume() {
        if (!standingDown) {
            return;
        }
        standingDown = false;
        System.clearProperty(STANDBY_PROPERTY);
        switchOn(desired, instrumentation);
        AgentLog.info("Alfred is back - " + (desired.featureList().isEmpty() ? "no features" : desired.featureList()) + " on again"
                + (desired.has("proxy") ? " (outbound calls through " + desired.proxy + ")" : ""));
    }

    public static synchronized boolean standingDown() {
        return standingDown;
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
        sender.presence(AgentRuntime::standDown, AgentRuntime::resume);
        sender.start();
        AgentRuntime.sender = sender;
        AgentLog.info("v" + AlfredDbAgent.VERSION + (config.captures() ? " capturing for project '" : " loaded for project '") + config.project
                + "', reporting to " + config.alfredUrl);
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
