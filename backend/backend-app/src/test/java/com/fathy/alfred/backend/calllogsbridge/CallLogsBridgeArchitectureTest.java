package com.fathy.alfred.backend.calllogsbridge;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * calllogsbridge joins inbound calls, database capture and the Logs tab (specs/008-logs-call-link). It may reach each
 * slice only through its use-case ports and domain records - never a service or an adapter (constitution III). Lives
 * here because backend-architecture-test does not see backend-app's classes.
 */
class CallLogsBridgeArchitectureTest {

    @Test
    void callLogsBridgeUsesOnlySlicePorts() {
        JavaClasses classes = new ClassFileImporter().withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("com.fathy.alfred.backend");
        noClasses().that().resideInAPackage("..backend.calllogsbridge..")
                .should().dependOnClassesThat().resideInAnyPackage("..application.service..", "..adapter..")
                .check(classes);
    }
}
