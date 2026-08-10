package com.fathy.alfred.backend.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * Automates the rules documented in CLAUDE.md's "backend architecture notes" -
 * a violation fails the build instead of waiting for a review comment. Maven module boundaries
 * already make cross-slice access to another slice's *module* impossible (there's no dependency
 * to even put it on the classpath); these rules cover what modules alone can't: the direction of
 * dependencies *within* a slice, and the one deliberately allowed cross-slice exception.
 */
class HexagonalArchitectureTest {

    private static JavaClasses classes;

    @BeforeAll
    static void importClasses() {
        classes = new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("com.fathy.alfred.backend");
    }

    @Test
    void domainMustNotDependOnApplicationOrAdapter() {
        noClasses().that().resideInAPackage("..domain..")
                .should().dependOnClassesThat().resideInAnyPackage("..application..", "..adapter..")
                .check(classes);
    }

    @Test
    void domainMustStayFreeOfSpringFramework() {
        // Jackson is deliberately allowed: CallRecord keeps its @JsonProperty annotations since
        // the wire shape and the domain shape are identical (see the DTO-vs-domain-reuse rule) -
        // that is not the same thing as depending on Spring.
        noClasses().that().resideInAPackage("..domain..")
                .should().dependOnClassesThat().resideInAPackage("org.springframework..")
                .check(classes);
    }

    @Test
    void applicationMustNotDependOnAdapter() {
        noClasses().that().resideInAPackage("..application..")
                .should().dependOnClassesThat().resideInAPackage("..adapter..")
                .check(classes);
    }

    @Test
    void inboundAdaptersMustDependOnPortsNotServices() {
        noClasses().that().resideInAPackage("..adapter.in..")
                .should().dependOnClassesThat().resideInAPackage("..application.service..")
                .check(classes);
    }

    @Test
    void inboundAdaptersMustNotReachIntoOutboundAdapters() {
        noClasses().that().resideInAPackage("..adapter.in..")
                .should().dependOnClassesThat().resideInAPackage("..adapter.out..")
                .check(classes);
    }

    @Test
    void callsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.calls..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.comments..", "..backend.export..", "..backend.sessioncycles..",
                        "..backend.profiles..")
                .check(classes);
    }

    @Test
    void commentsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.comments..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.export..", "..backend.sessioncycles..",
                        "..backend.profiles..")
                .check(classes);
    }

    // export -> calls and sessioncycles -> calls are the two allowed cross-slice dependencies
    // (each receives a full logged call and does something with it - extracts metadata, or
    // captures it into a recording cycle), so there is deliberately no
    // "exportSliceMustNotDependOnOtherSlices" test, and sessionCyclesSliceMustNotDependOnOtherSlices
    // below permits calls specifically while still forbidding comments/export/profiles.

    @Test
    void sessionCyclesSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.sessioncycles..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.comments..", "..backend.export..", "..backend.profiles..")
                .check(classes);
    }

    // profiles is a leaf slice: session-cycles' assignedTo only ever stores a profile's id as a
    // plain string, so there is no compile-time coupling in either direction - profiles depends on
    // nothing else, and nothing else depends on profiles.
    @Test
    void profilesSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.profiles..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..")
                .check(classes);
    }
}
