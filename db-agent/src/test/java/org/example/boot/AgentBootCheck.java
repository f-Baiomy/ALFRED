package org.example.boot;

import com.fathy.alfred.dbagent.AgentRuntime;
import com.fathy.alfred.dbagent.AlfredDbAgent;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;
import net.bytebuddy.agent.ByteBuddyAgent;

/**
 * Run in a fresh JVM by AgentBootIT: installs the agent the way it starts inside an application server, THEN names a
 * LogManager the way WildFly's jboss-modules does (a system property set after startup). If the agent touched
 * java.util.logging while installing, the JVM already chose the default LogManager and WildFly refuses to boot
 * (WFLYLOG0078). Prints the LogManager class the JVM ended up with.
 */
public final class AgentBootCheck {

    private AgentBootCheck() {
    }

    public static void main(String[] args) throws Exception {
        java.lang.instrument.Instrumentation instrumentation = ByteBuddyAgent.install();
        AlfredDbAgent.injectBootstrap(instrumentation);
        AgentRuntime.install(instrumentation, new StatementSink() {
            @Override
            public void statement(StatementRecord record) {
            }

            @Override
            public void marker(MarkerRecord marker) {
            }
        }, new AgentSettings(), "boot-check");
        System.setProperty("java.util.logging.manager", BootLogManager.class.getName());
        System.out.println("LOG_MANAGER=" + java.util.logging.LogManager.getLogManager().getClass().getName());
    }

    /** Stands in for org.jboss.logmanager.LogManager. */
    public static final class BootLogManager extends java.util.logging.LogManager {
    }
}
