package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.TrustManagerAdvice;
import com.fathy.alfred.dbagent.bootstrap.TrustBridge;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;

import java.lang.instrument.Instrumentation;

import static net.bytebuddy.matcher.ElementMatchers.isAbstract;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.not;

/**
 * Advises the JDK's own trust manager once per JVM (TrustManagerAdvice). The class is in java.base and already loaded
 * when the agent attaches, so it is retransformed; the advice reads {@link TrustBridge}, which is why that class is on
 * the bootstrap class path and java.base is given a read edge to it. Turning the feature off clears the bridge - the
 * advice stays and does nothing.
 */
final class TrustInstrumentation {

    private static boolean installed;

    private TrustInstrumentation() {
    }

    static synchronized void install(Instrumentation instrumentation) {
        if (installed) {
            return;
        }
        new AgentBuilder.Default()
                .disableClassFormatChanges()
                .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
                .with(new AgentBuilder.Listener.Adapter() {
                    @Override
                    public void onError(String typeName, ClassLoader classLoader, net.bytebuddy.utility.JavaModule module,
                                        boolean loaded, Throwable throwable) {
                        AgentLog.info("could not add Alfred's CA to " + typeName + " (" + throwable + ") - HTTPS through the proxy may be refused");
                    }
                })
                .ignore(nameStartsWith("net.bytebuddy.").or(nameStartsWith("com.fathy.alfred.dbagent.")))
                .assureReadEdgeTo(instrumentation, TrustBridge.class)
                .type(named("sun.security.ssl.X509TrustManagerImpl"))
                .transform((builder, type, loader, module, domain) ->
                        builder.visit(Advice.to(TrustManagerAdvice.class).on(named("checkServerTrusted").and(not(isAbstract())))))
                .installOn(instrumentation);
        installed = true;
    }
}
