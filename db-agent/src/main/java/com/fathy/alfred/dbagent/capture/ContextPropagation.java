package com.fathy.alfred.dbagent.capture;

import java.util.concurrent.Callable;

/**
 * Work handed to another thread keeps the call it was handed over from (research D3): the Runnable/Callable is wrapped
 * at submission and the context is set around its run, then the previous one restored - pool threads are reused.
 * Nothing is wrapped when the submitting thread has no call, so uncaptured traffic pays one ThreadLocal read.
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
        if (context == null || !(task instanceof Runnable) || task instanceof Carrying) {
            return task;
        }
        return new CarryingRunnable((Runnable) task, context);
    }

    @SuppressWarnings("unchecked")
    public static Object wrapCallable(Object task) {
        CallContext context = CURRENT.get();
        if (context == null || !(task instanceof Callable) || task instanceof Carrying) {
            return task;
        }
        return new CarryingCallable<>((Callable<Object>) task, context);
    }

    /** Marks a wrapper so it is never wrapped twice (an executor that delegates to another one). */
    interface Carrying {
    }

    static final class CarryingRunnable implements Runnable, Carrying {
        private final Runnable task;
        private final CallContext context;

        CarryingRunnable(Runnable task, CallContext context) {
            this.task = task;
            this.context = context;
        }

        @Override
        public void run() {
            CallContext previous = CURRENT.get();
            set(context);
            try {
                task.run();
            } finally {
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

        CarryingCallable(Callable<V> task, CallContext context) {
            this.task = task;
            this.context = context;
        }

        @Override
        public V call() throws Exception {
            CallContext previous = CURRENT.get();
            set(context);
            try {
                return task.call();
            } finally {
                set(previous);
            }
        }

        @Override
        public String toString() {
            return task.toString();
        }
    }
}
