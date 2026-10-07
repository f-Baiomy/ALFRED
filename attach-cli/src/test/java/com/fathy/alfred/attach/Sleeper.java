package com.fathy.alfred.attach;

/** The "application" the IT attaches to. */
public final class Sleeper {

    private Sleeper() {
    }

    public static void main(String[] args) throws Exception {
        System.out.print("ready");
        System.out.flush();
        Thread.sleep(120_000);
    }
}
