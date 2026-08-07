package com.alfred.pennyworth.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * Automates the rules documented in CLAUDE.md's "pennyworth (backend) architecture notes" -
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
                .importPackages("com.alfred.pennyworth");
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
        noClasses().that().resideInAPackage("..pennyworth.calls..")
                .should().dependOnClassesThat().resideInAnyPackage("..pennyworth.comments..", "..pennyworth.export..")
                .check(classes);
    }

    @Test
    void commentsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..pennyworth.comments..")
                .should().dependOnClassesThat().resideInAnyPackage("..pennyworth.calls..", "..pennyworth.export..")
                .check(classes);
    }

    // export -> calls is the one allowed cross-slice dependency (export receives a full logged
    // call and extracts metadata from it), so there is deliberately no
    // "exportSliceMustNotDependOnOtherSlices" test here.
}
