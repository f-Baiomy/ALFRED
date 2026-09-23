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
                        "..backend.profiles..", "..backend.settings..", "..backend.internalcalls..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // internalcalls is a leaf slice like profiles/settings: it logs the frontend's own browser
    // calls to WildFly (captured by the separate reverse-mode wildfly-proxy), a completely
    // separate traffic source from backend-calls' supplier calls - it only reuses backend-calls'
    // JSON wire shape (copied, not shared) so the existing frontend models work against it
    // unmodified, with zero actual code dependency in either direction.
    @Test
    void internalCallsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.internalcalls..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    @Test
    void commentsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.comments..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.export..", "..backend.sessioncycles..",
                        "..backend.profiles..", "..backend.settings..", "..backend.internalcalls..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // export -> calls, sessioncycles -> calls, sessioncycles -> internalcalls, calloverlap -> calls,
    // and calloverlap -> internalcalls are the allowed cross-slice dependencies (each receives a
    // full logged call and does something with it - extracts metadata, captures it into a
    // recording cycle, or extracts the minimal overlap-check fields), so there is deliberately no
    // "exportSliceMustNotDependOnOtherSlices" test, and sessionCyclesSliceMustNotDependOnOtherSlices/
    // callOverlapSliceMustNotDependOnOtherSlices below each permit calls and internalcalls
    // specifically while still forbidding comments/export/profiles/settings/the other one of the two.

    @Test
    void sessionCyclesSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.sessioncycles..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.comments..", "..backend.export..", "..backend.profiles..",
                        "..backend.settings..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // callOverlap mirrors sessionCycles' own exception: it depends on both backend-calls and
    // backend-internal-calls to merge their two independent call histories into one flat list for
    // GET /call-overlaps (see backend-call-overlap's module doc) - the one other slice allowed to
    // depend on more than one other, alongside session-cycles.
    @Test
    void callOverlapSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.calloverlap..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.comments..", "..backend.export..", "..backend.sessioncycles..",
                        "..backend.profiles..", "..backend.settings..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
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
                        "..backend.sessioncycles..", "..backend.settings..", "..backend.internalcalls..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // settings is a leaf slice like profiles: CallFilterPort is defined inside backend.calls
    // itself as an outbound port, and the adapter implementing it (bridging calls -> settings)
    // lives in backend-app, the composition root - so settings depends on nothing else, and
    // nothing else depends on settings.
    @Test
    void settingsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.settings..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.internalcalls..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // redactions is a leaf slice like profiles/settings: a redaction only ever stores a call's id
    // as a plain string plus the NAME of a header/body path/query param to mask, so it needs
    // nothing from backend-calls, and the export-time masking that consumes redactions lives
    // downstream (frontend today), not inside this slice.
    @Test
    void redactionsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.redactions..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..",
                        "..backend.interception..", "..backend.resend..")
                .check(classes);
    }

    // interception is a leaf slice, and it is worth saying why it does not depend on backend-calls
    // even though it is obviously about calls: this slice never sees one. Rules are evaluated
    // inside the mitmproxy addons against a snapshot this slice publishes, and the record of what
    // a rule did travels on the EXISTING call webhook into backend-calls - so the two slices meet
    // in the payload, not in the code. A dependency here would be the first step towards
    // evaluating rules backend-side, which is the design this feature deliberately avoids.
    @Test
    void interceptionSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.interception..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.resend..")
                .check(classes);
    }

    // resend is a leaf slice even though it obviously needs logged calls: it reads them only through
    // its own out-ports (CallSourcePort, SessionValueLookupPort), which backend-app's resendbridge
    // implements against the calls, internal-calls and session-cycles use cases - the same shape as
    // CallFilterAdapter. Sending goes back out through the proxies, so a resent call reaches
    // backend-calls on the ordinary webhook, never by a direct call from this slice.
    @Test
    void resendSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.resend..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..")
                // Only until backend-resend has its first class (tasks.md T102): ArchUnit refuses
                // a rule that matches nothing. Remove this line with that task.
                .allowEmptyShould(true)
                .check(classes);
    }
}
