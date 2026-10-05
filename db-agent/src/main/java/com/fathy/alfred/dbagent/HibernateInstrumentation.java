package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.HibernateEventAdvice;
import com.fathy.alfred.dbagent.advice.NamedQueryAdvice;
import com.fathy.alfred.dbagent.advice.QueryExecuteAdvice;
import com.fathy.alfred.dbagent.advice.QueryParameterAdvice;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.matcher.ElementMatcher;

import static com.fathy.alfred.dbagent.Instrumenter.advise;
import static net.bytebuddy.matcher.ElementMatchers.hasSuperType;
import static net.bytebuddy.matcher.ElementMatchers.isInterface;
import static net.bytebuddy.matcher.ElementMatchers.isPublic;
import static net.bytebuddy.matcher.ElementMatchers.isStatic;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

/**
 * Hibernate 4, 5 and 6 (and JPA through it): where a statement came from. Query execution, its parameters and name,
 * and the events that make SQL without a query of the code's - by class and method NAME, so no Hibernate version is
 * a compile dependency, and only {@code org.hibernate.*} classes are ever matched (the hierarchy check is the costly
 * part, so the package test goes first). An application without Hibernate loads none of these and pays nothing.
 */
final class HibernateInstrumentation {

    private static final String[] TYPED_SETTERS = {
            "setParameter", "setParameterList", "setString", "setCharacter", "setBoolean", "setByte", "setShort", "setInteger",
            "setLong", "setFloat", "setDouble", "setBinary", "setText", "setSerializable", "setLocale", "setBigDecimal",
            "setBigInteger", "setDate", "setTime", "setTimestamp", "setCalendar", "setCalendarDate", "setEntity"
    };

    private HibernateInstrumentation() {
    }

    private static ElementMatcher.Junction<TypeDescription> hibernate(String... superTypes) {
        return nameStartsWith("org.hibernate.").and(not(isInterface())).and(hasSuperType(namedOneOf(superTypes)));
    }

    /** Interfaces too: Hibernate 5.2+ implements getResultList/getSingleResult/stream as DEFAULT methods of its Query
     *  interface - abstract interface methods are never advised (Instrumenter.advise). */
    private static ElementMatcher.Junction<TypeDescription> hibernateOrInterface(String... superTypes) {
        return nameStartsWith("org.hibernate.").and(hasSuperType(namedOneOf(superTypes)));
    }

    static AgentBuilder add(AgentBuilder builder) {
        ElementMatcher.Junction<TypeDescription> queries = hibernateOrInterface(
                "org.hibernate.Query", "org.hibernate.query.Query", "org.hibernate.query.CommonQueryContract",
                "org.hibernate.Criteria", "javax.persistence.Query", "jakarta.persistence.Query");

        builder = advise(builder, queries, QueryExecuteAdvice.class, isPublic().and(not(isStatic())).and(namedOneOf(
                "list", "getResultList", "uniqueResult", "uniqueResultOptional", "getSingleResult", "getSingleResultOrNull",
                "executeUpdate", "scroll", "stream", "getResultStream", "iterate")));
        builder = advise(builder, queries, QueryParameterAdvice.class, isPublic().and(not(isStatic())).and(
                namedOneOf(TYPED_SETTERS).and(takesArguments(2).or(takesArguments(3)))
                        .or(namedOneOf("setFirstResult", "setMaxResults").and(takesArguments(1)))));
        builder = advise(builder, hibernate("org.hibernate.SharedSessionContract", "org.hibernate.Session",
                        "javax.persistence.EntityManager", "jakarta.persistence.EntityManager"),
                NamedQueryAdvice.class, isPublic().and(namedOneOf("createNamedQuery", "getNamedQuery", "getNamedNativeQuery",
                        "createNamedSelectionQuery", "createNamedMutationQuery")).and(takesArgument(0, String.class)));

        builder = advise(builder, named("org.hibernate.event.internal.DefaultInitializeCollectionEventListener"),
                HibernateEventAdvice.class, named("onInitializeCollection").and(takesArguments(1)));
        builder = advise(builder, named("org.hibernate.event.internal.DefaultLoadEventListener"),
                HibernateEventAdvice.class, named("onLoad").and(takesArguments(2)));
        builder = advise(builder, named("org.hibernate.event.internal.DefaultFlushEventListener"),
                HibernateEventAdvice.class, named("onFlush").and(takesArguments(1)));
        builder = advise(builder, named("org.hibernate.event.internal.DefaultAutoFlushEventListener"),
                HibernateEventAdvice.class, named("onAutoFlush").and(takesArguments(1)));
        builder = advise(builder, hibernate("org.hibernate.action.internal.EntityAction", "org.hibernate.action.internal.CollectionAction"),
                HibernateEventAdvice.class, named("execute").and(takesArguments(0)));
        return builder;
    }
}
