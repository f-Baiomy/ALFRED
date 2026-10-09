package org.jboss.modules;

/**
 * Stand-in for JBoss Modules' Module, for ModuleVisibilityIT: a WildFly deployment sees only what its module answers
 * from {@code loadModuleClass}, and the agent's {@code com.fathy.*} classes are not among them until the agent's
 * JBossModulesAdvice answers for the bootstrap Bridge's package. Same name and signature as the real one, so the agent
 * advises it the same way.
 */
public class Module {

    private final ClassLoader classes;

    public Module(ClassLoader classes) {
        this.classes = classes;
    }

    public Class<?> loadModuleClass(String name, boolean resolve) throws ClassNotFoundException {
        if (name.startsWith("com.fathy.")) {
            throw new ClassNotFoundException(name + " (not visible from this module)");
        }
        return classes.loadClass(name);
    }
}
