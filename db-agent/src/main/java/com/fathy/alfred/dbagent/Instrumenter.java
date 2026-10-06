package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.CallableArgumentAdvice;
import com.fathy.alfred.dbagent.advice.JBossModulesAdvice;
import com.fathy.alfred.dbagent.advice.RunnableArgumentAdvice;
import com.fathy.alfred.dbagent.advice.ServletAdvice;
import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.dynamic.DynamicType;
import net.bytebuddy.matcher.ElementMatcher;
import net.bytebuddy.utility.JavaModule;

import java.lang.instrument.Instrumentation;
import java.util.concurrent.Callable;

import static net.bytebuddy.matcher.ElementMatchers.isAbstract;
import static net.bytebuddy.matcher.ElementMatchers.isSynthetic;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

/**
 * Which classes get which advice. Everything is {@code Advice} inlined into existing method bodies - no new fields,
 * no new methods, no wrapper objects handed to the application - so it retransforms classes that were loaded before
 * the agent attached, and {@code unwrap()}/{@code instanceof} on vendor types keep working (research D1).
 *
 * <p>The default ignore list is replaced so JDK classes (the thread pools) can be instrumented; the read edge to the
 * bootstrap {@link Bridge} is added for Java 9+ modules.
 */
final class Instrumenter {

    private Instrumenter() {
    }

    static void install(Instrumentation instrumentation, Bridge.Dispatcher dispatcher) {
        Bridge.dispatcher = dispatcher;
        AgentBuilder builder = new AgentBuilder.Default()
                .disableClassFormatChanges()
                .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
                // Classes loaded WHILE others are being retransformed (a driver's ResultSet, loaded to verify its
                // Statement) slip past the first pass - ByteBuddy will not transform from inside a transformation.
                // Reiterating discovers again until nothing new is found, so attaching to a running server misses none.
                .with(AgentBuilder.RedefinitionStrategy.DiscoveryStrategy.Reiterating.INSTANCE)
                .with(new ErrorListener())
                .ignore(nameStartsWith("net.bytebuddy.").or(nameStartsWith("com.fathy.alfred.dbagent.")).or(isSynthetic()))
                .assureReadEdgeTo(instrumentation, Bridge.class);

        builder = advise(builder, namedOneOf("javax.servlet.http.HttpServlet", "jakarta.servlet.http.HttpServlet"),
                ServletAdvice.class, named("service").and(takesArguments(2))
                        .and(takesArgument(0, namedOneOf("javax.servlet.http.HttpServletRequest", "jakarta.servlet.http.HttpServletRequest"))));

        builder = advise(builder, named("java.util.concurrent.ThreadPoolExecutor").or(named("java.util.concurrent.ForkJoinPool")),
                RunnableArgumentAdvice.class, namedOneOf("execute", "submit").and(takesArgument(0, Runnable.class)));
        builder = advise(builder, named("java.util.concurrent.ForkJoinPool"),
                CallableArgumentAdvice.class, named("submit").and(takesArgument(0, Callable.class)));
        builder = advise(builder, named("java.util.concurrent.ScheduledThreadPoolExecutor"),
                RunnableArgumentAdvice.class, named("schedule").and(takesArgument(0, Runnable.class)));
        builder = advise(builder, named("java.util.concurrent.ScheduledThreadPoolExecutor"),
                CallableArgumentAdvice.class, named("schedule").and(takesArgument(0, Callable.class)));

        builder = advise(builder, named("org.jboss.modules.Module"), JBossModulesAdvice.class,
                named("loadModuleClass").and(takesArgument(0, String.class)));

        builder = JdbcInstrumentation.add(builder);
        builder = LogInstrumentation.add(builder);
        builder = HibernateInstrumentation.add(builder);
        builder = RedisInstrumentation.add(builder);
        builder.installOn(instrumentation);
    }

    static AgentBuilder advise(AgentBuilder builder, ElementMatcher<? super TypeDescription> types, Class<?> advice,
                               ElementMatcher<? super MethodDescription> methods) {
        return builder.type(types).transform((DynamicType.Builder<?> b, TypeDescription type, ClassLoader loader, JavaModule module,
                                               java.security.ProtectionDomain domain) -> b.visit(Advice.to(advice).on(not(isAbstract()).and(methods))));
    }

    /** Instrumentation failures are reported, never thrown - a class the agent cannot handle is simply not captured. */
    private static final class ErrorListener extends AgentBuilder.Listener.Adapter {
        @Override
        public void onError(String typeName, ClassLoader classLoader, JavaModule module, boolean loaded, Throwable throwable) {
            AgentLog.warn("could not instrument " + typeName + " (" + throwable.getClass().getSimpleName() + ")");
        }
    }
}
