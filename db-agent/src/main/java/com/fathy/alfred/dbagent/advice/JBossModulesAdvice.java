package com.fathy.alfred.dbagent.advice;

import net.bytebuddy.asm.Advice;

/**
 * Inlined into JBoss Modules' {@code Module.loadModuleClass(String, boolean)}. A WildFly module only sees the packages
 * it declares, so instrumented driver/servlet code could not resolve the bootstrap Bridge and would fail with
 * NoClassDefFoundError. This answers that one package from the bootstrap loader for every module - the same thing
 * {@code -Djboss.modules.system.pkgs=com.fathy.alfred.dbagent.bootstrap} does at startup, but possible after attach.
 * References only JDK types, since it runs inside JBoss Modules itself.
 */
public final class JBossModulesAdvice {

    private JBossModulesAdvice() {
    }

    @Advice.OnMethodEnter(skipOn = Advice.OnNonDefaultValue.class, suppress = Throwable.class)
    public static Class<?> enter(@Advice.Argument(0) String name) {
        if (name != null && name.startsWith("com.fathy.alfred.dbagent.bootstrap.")) {
            try {
                return Class.forName(name, false, null);
            } catch (ClassNotFoundException e) {
                return null;
            }
        }
        return null;
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.Enter Class<?> found, @Advice.Return(readOnly = false) Class<?> result) {
        if (found != null) {
            result = found;
        }
    }
}
