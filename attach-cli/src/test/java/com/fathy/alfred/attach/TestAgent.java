package com.fathy.alfred.attach;

import java.lang.instrument.Instrumentation;

/** Stands in for alfred-agent.jar: publishes the features it was given, as the real agent does. */
public final class TestAgent {

    private TestAgent() {
    }

    public static void agentmain(String args, Instrumentation instrumentation) {
        String features = "";
        for (String part : args.split(";")) {
            if (part.startsWith("features=")) {
                features = part.substring("features=".length());
            }
        }
        System.setProperty("alfred.test.args", args);
        System.setProperty(AttachCli.FEATURES, features);
        System.setProperty(AttachCli.VERSION, "test");
    }
}
