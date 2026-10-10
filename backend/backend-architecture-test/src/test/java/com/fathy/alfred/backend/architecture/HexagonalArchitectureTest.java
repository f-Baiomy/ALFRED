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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
                .check(classes);
    }

    @Test
    void commentsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.comments..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.export..", "..backend.sessioncycles..",
                        "..backend.profiles..", "..backend.settings..", "..backend.internalcalls..",
                        "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.resend..", "..backend.scenarios..", "..backend.relive..")
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
                        "..backend.interception..", "..backend.scenarios..", "..backend.relive..")
                .check(classes);
    }

    // scenarios is a leaf slice like profiles: a scenario's definition/results are opaque JSON
    // authored and interpreted entirely by the frontend (contracts/002-power-features section 3)
    // - this slice never looks inside them, so it needs nothing from any other slice, and nothing
    // else references a scenario except by id (which nothing yet does).
    @Test
    void scenariosSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.scenarios..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.relive..")
                .check(classes);
    }

    // relive is the newest slice (specs/003-relive-cycle): it never depends on any other slice
    // directly, including backend-interception even though a call rule IS an interception rule
    // document - that document stays an opaque JsonNode here (domain.model.CycleRule), validated
    // and rendered only through backend-app bridges (relivebridge), so this slice can construct,
    // store and publish rule documents without ever calling into backend-interception's code.
    @Test
    void reliveSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.relive..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..")
                .check(classes);
    }

    // logs is a leaf slice: it ingests external log files/feeds and owns its own comments,
    // pins and saved views, so it needs nothing from the call slices. A comment's author is a
    // plain profile id string (no backend-profiles import), same as session-cycles' assignedTo.
    @Test
    void logsSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.logs..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..")
                .check(classes);
    }

    // dbcapture is a leaf slice: it stores what the db-agent records inside the application, keyed by the inbound
    // call id as a plain string. Where it must cooperate with other slices (calls retained by session/Relive cycles,
    // deleting statements with their call, inbound completion), backend-app bridges through its ports.
    @Test
    void dbCaptureSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.dbcapture..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.triage..")
                .check(classes);
    }

    @Test
    void noOtherSliceDependsOnDbCapture() {
        noClasses().that().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..")
                .should().dependOnClassesThat().resideInAPackage("..backend.dbcapture..")
                .check(classes);
    }

    // triage is a leaf slice: the saved "needs attention" mark of every call, keyed by call id as a plain string. It is
    // fed only by backend-app/triagebridge (call observers, db-capture's failed-statement port, cycle-held ids).
    @Test
    void triageSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.triage..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..")
                .check(classes);
    }

    @Test
    void noOtherSliceDependsOnTriage() {
        noClasses().that().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..")
                .should().dependOnClassesThat().resideInAPackage("..backend.triage..")
                .check(classes);
    }

    // board is a leaf slice: cards, their activity and mentions, cycle briefs, spec files and checklist marks
    // (specs/014-task-board). Kept calls, cycle deletion, call signatures and edit access reach it only through
    // backend-app/boardbridge, and no other slice depends on it.
    @Test
    void boardSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.board..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..", "..backend.triage..",
                        "..backend.server..")
                .check(classes);
    }

    @Test
    void noOtherSliceDependsOnBoard() {
        noClasses().that().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..", "..backend.triage..",
                        "..backend.server..")
                .should().dependOnClassesThat().resideInAPackage("..backend.board..")
                .check(classes);
    }

    // server is a leaf slice: the native install's settings (.env), checks, history and restart requests
    // (specs/012-server-program). It reaches other slices' data and runtime setters only through out-ports that
    // backend-app/serverbridge implements, and nothing depends on it except backend-app.
    @Test
    void serverSliceMustNotDependOnOtherSlices() {
        noClasses().that().resideInAPackage("..backend.server..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..", "..backend.triage..")
                .check(classes);
    }

    @Test
    void noOtherSliceDependsOnServer() {
        noClasses().that().resideInAnyPackage(
                        "..backend.calls..", "..backend.comments..", "..backend.export..",
                        "..backend.sessioncycles..", "..backend.profiles..", "..backend.settings..",
                        "..backend.internalcalls..", "..backend.calloverlap..", "..backend.redactions..",
                        "..backend.interception..", "..backend.resend..", "..backend.scenarios..",
                        "..backend.relive..", "..backend.logs..", "..backend.dbcapture..", "..backend.triage..")
                .should().dependOnClassesThat().resideInAPackage("..backend.server..")
                .check(classes);
    }

    // The server slice's domain and application layers are also run without Spring by ServerConfigCli
    // (the alfred config command line while the backend is stopped), so they must not need a Spring context.
    @Test
    void serverDomainAndApplicationDoNotUseSpring() {
        noClasses().that().resideInAnyPackage("..backend.server.domain..", "..backend.server.application..")
                .should().dependOnClassesThat().resideInAPackage("org.springframework..")
                .check(classes);
    }
}
