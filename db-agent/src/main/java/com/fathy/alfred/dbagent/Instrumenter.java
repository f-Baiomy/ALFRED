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
import net.bytebuddy.pool.TypePool;
import net.bytebuddy.utility.JavaModule;

import java.lang.instrument.Instrumentation;
import java.util.List;
import java.util.Map;
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

    /** Classes per retransformClasses call when attaching to a running app. */
    static final int RETRANSFORM_BATCH = 50;

    private Instrumenter() {
    }

    static void install(Instrumentation instrumentation, Bridge.Dispatcher dispatcher) {
        Bridge.dispatcher = dispatcher;
        AgentBuilder builder = new AgentBuilder.Default()
                .disableClassFormatChanges()
                .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
                // Attached to a running server, every matching loaded class is retransformed. ByteBuddy's default is
                // ONE batch for all of them, and the JVM rejects a batch whole: one class it will not retransform (a
                // generated class, one another agent changed) and no JDBC or servlet class got its advice - with no
                // word, as the default redefinition listener says nothing. Small batches, split again on failure until
                // only the class that fails is left out, and a count of what was and was not instrumented.
                .with(AgentBuilder.RedefinitionStrategy.BatchAllocator.ForFixedSize.ofSize(RETRANSFORM_BATCH))
                // Classes loaded WHILE others are being retransformed (a driver's ResultSet, loaded to verify its
                // Statement) slip past the first pass - ByteBuddy will not transform from inside a transformation.
                // Reiterating discovers again until nothing new is found, so attaching to a running server misses none.
                .with(AgentBuilder.RedefinitionStrategy.DiscoveryStrategy.Reiterating.INSTANCE)
                .with(AgentBuilder.RedefinitionStrategy.Listener.BatchReallocator.splitting())
                .with(new RetransformReport())
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

    /**
     * Says what retransforming the already-loaded classes came to - one line, only when there were any (an attach to a
     * running app). A batch the JVM refused is split by {@code BatchReallocator} until the refused class is alone; the
     * classes left in {@code failures} at the end are the ones that run without capture.
     */
    static final class RetransformReport extends AgentBuilder.RedefinitionStrategy.Listener.Adapter {
        @Override
        public void onComplete(int amount, List<Class<?>> types, Map<List<Class<?>>, Throwable> failures) {
            if (types.isEmpty()) {
                return;
            }
            AgentLog.info(summary(types.size(), failures));
        }

        static String summary(int total, Map<List<Class<?>>, Throwable> failures) {
            int failed = 0;
            StringBuilder names = new StringBuilder();
            for (Map.Entry<List<Class<?>>, Throwable> e : failures.entrySet()) {
                failed += e.getKey().size();
                for (Class<?> type : e.getKey()) {
                    if (names.length() < 300) {
                        names.append(names.length() == 0 ? "" : ", ").append(type.getName())
                                .append(" (").append(e.getValue().getClass().getSimpleName()).append(')');
                    }
                }
            }
            String line = "instrumented " + (total - failed) + " of " + total + " already-loaded classes";
            return failed == 0 ? line : line + " - not instrumented, so not captured: " + names;
        }
    }

    /** Instrumentation failures are reported, never thrown - a class the agent cannot handle is simply not captured. */
    private static final class ErrorListener extends AgentBuilder.Listener.Adapter {
        private final UnreadableTypes unreadable = new UnreadableTypes();

        @Override
        public void onError(String typeName, ClassLoader classLoader, JavaModule module, boolean loaded, Throwable throwable) {
            if (UnreadableTypes.is(throwable)) {
                String line = unreadable.add(typeName, System.currentTimeMillis());
                if (line != null) {
                    AgentLog.info(line);
                }
                return;
            }
            AgentLog.warn("could not instrument " + typeName + " (" + throwable.getClass().getSimpleName() + ")");
        }
    }

    /**
     * Classes generated in memory (Drools rule consequences, other runtime compilers) have no class file a type pool can
     * read, so matching them against the JDBC/servlet supertypes fails with {@code NoSuchTypeException}. The class is
     * then defined unchanged - nothing is wrong with it or the application - but a rule base compiles hundreds, each
     * with its own name, and a WARN line per class flooded the console. One summary line instead, at most once a minute.
     */
    static final class UnreadableTypes {
        static final long QUIET_MILLIS = 60_000;

        private long printedAt;
        private int skipped;

        static boolean is(Throwable t) {
            for (Throwable c = t; c != null; c = c.getCause() == c ? null : c.getCause()) {
                if (c instanceof TypePool.Resolution.NoSuchTypeException) {
                    return true;
                }
            }
            return false;
        }

        /** The line to print for this class, or null while the last one is under a minute old (the class is counted). */
        synchronized String add(String typeName, long now) {
            skipped++;
            if (printedAt != 0 && now - printedAt < QUIET_MILLIS) {
                return null;
            }
            String line = "left " + skipped + (skipped == 1 ? " class" : " classes") + " uninstrumented whose supertypes"
                    + " cannot be read (generated in memory, e.g. " + typeName + ") - they run unchanged";
            printedAt = now;
            skipped = 0;
            return line;
        }
    }
}
