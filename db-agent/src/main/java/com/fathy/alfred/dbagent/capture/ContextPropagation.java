package com.fathy.alfred.dbagent.capture;

import java.util.concurrent.Callable;

/**
 * Work handed to another thread keeps the call it was handed over from (research D3): the Runnable/Callable is wrapped
 * at submission and the context is set around its run, then the previous one restored - pool threads are reused.
 * Nothing is wrapped when the submitting thread has no call and no log tag, so other traffic pays two ThreadLocal reads.
 */
public final class ContextPropagation {

    private static final ThreadLocal<CallContext> CURRENT = new ThreadLocal<>();

    private ContextPropagation() {
    }

    public static CallContext current() {
        return CURRENT.get();
    }

    static void set(CallContext context) {
        if (context == null) {
            CURRENT.remove();
        } else {
            CURRENT.set(context);
        }
    }

    public static Object wrapRunnable(Object task) {
        CallContext context = CURRENT.get();
        String logTag = LogTagger.current();
        if ((context == null && logTag == null) || !(task instanceof Runnable) || task instanceof Carrying) {
            return task;
        }
        return new CarryingRunnable((Runnable) task, context, logTag);
    }

    @SuppressWarnings("unchecked")
    public static Object wrapCallable(Object task) {
        CallContext context = CURRENT.get();
        String logTag = LogTagger.current();
        if ((context == null && logTag == null) || !(task instanceof Callable) || task instanceof Carrying) {
            return task;
        }
        return new CarryingCallable<>((Callable<Object>) task, context, logTag);
    }

    /** Marks a wrapper so it is never wrapped twice (an executor that delegates to another one). */
    interface Carrying {
    }

    static final class CarryingRunnable implements Runnable, Carrying {
        private final Runnable task;
        private final CallContext context;
        /** The call id the submitting thread's log lines carried - the task's lines carry it too. */
        private final String logTag;

        CarryingRunnable(Runnable task, CallContext context, String logTag) {
            this.task = task;
            this.context = context;
            this.logTag = logTag;
        }

        @Override
        public void run() {
            CallContext previous = CURRENT.get();
            set(context);
            Object logRestore = LogTagger.tag(logTag);
            try {
                task.run();
            } finally {
                LogTagger.restore(logRestore);
                set(previous);
            }
        }

        @Override
        public String toString() {
            return task.toString();
        }
    }

    static final class CarryingCallable<V> implements Callable<V>, Carrying {
        private final Callable<V> task;
        private final CallContext context;
        /** The call id the submitting thread's log lines carried - the task's lines carry it too. */
        private final String logTag;

        CarryingCallable(Callable<V> task, CallContext context, String logTag) {
            this.task = task;
            this.context = context;
            this.logTag = logTag;
        }

        @Override
        public V call() throws Exception {
            CallContext previous = CURRENT.get();
            set(context);
            Object logRestore = LogTagger.tag(logTag);
            try {
                return task.call();
            } finally {
                LogTagger.restore(logRestore);
                set(previous);
            }
        }

        @Override
        public String toString() {
            return task.toString();
        }
    }
}
