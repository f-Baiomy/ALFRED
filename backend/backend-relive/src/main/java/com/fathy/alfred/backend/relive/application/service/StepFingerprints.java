package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.domain.fingerprint.RequestFingerprint;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.Step;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Keeps outbound request fingerprints in step with the cycle. A fingerprint is computed only when
 * the step is new or its matching-relevant request changed. Order, enablement, and moving a step
 * under another parent reuse the stored hash.
 */
public final class StepFingerprints {

    private StepFingerprints() {
    }

    /** True when an outbound step with a recording has no SEMANTIC_V1 hash. Does not read the body. */
    public static boolean missing(List<Step> steps) {
        if (steps == null) {
            return false;
        }
        for (Step step : steps) {
            if (step == null || !"outbound".equalsIgnoreCase(step.direction()) || step.recording() == null) {
                continue;
            }
            if (step.fingerprint() == null || !RequestFingerprint.VERSION.equals(step.fingerprintVersion())) {
                return true;
            }
        }
        return false;
    }

    /** Drops any client-supplied hash without reading request bodies. Used when create defers the stamp. */
    public static List<Step> cleared(List<Step> steps) {
        if (steps == null || steps.isEmpty()) {
            return steps == null ? List.of() : steps;
        }
        List<Step> cleared = new ArrayList<>(steps.size());
        for (Step step : steps) {
            if (step == null || (step.fingerprint() == null && step.fingerprintVersion() == null)) {
                cleared.add(step);
            } else {
                cleared.add(step.withFingerprint(null, null));
            }
        }
        return cleared;
    }

    public static List<Step> maintain(List<Step> incoming, List<Step> previous) {
        if (incoming == null || incoming.isEmpty()) {
            return incoming == null ? List.of() : incoming;
        }
        Map<String, Step> priorByKey = new LinkedHashMap<>();
        if (previous != null) {
            for (Step step : previous) {
                if (step != null && step.key() != null) {
                    priorByKey.put(step.key(), step);
                }
            }
        }
        List<Step> stamped = new ArrayList<>(incoming.size());
        for (Step step : incoming) {
            stamped.add(stamp(step, priorByKey.get(step.key())));
        }
        return stamped;
    }

    /**
     * Parent step key → SEMANTIC_V1 hash → outbound candidate step keys, in the same order the
     * proxy walks candidates. Built from stored hashes and recorded paths only; bodies are not read.
     * A child with no SEMANTIC_V1 hash, no recorded path, or enabled false is left out so the proxy
     * keeps the older match for an unhashed child and does not select a disabled one. The hash
     * itself stays on the step.
     */
    public static Map<String, Map<String, List<String>>> indexes(List<Step> steps) {
        Map<String, Map<String, List<String>>> index = new LinkedHashMap<>();
        if (steps == null || steps.isEmpty()) {
            return index;
        }
        Map<String, List<Step>> childrenByParent = new LinkedHashMap<>();
        for (Step step : steps) {
            if (step == null) {
                continue;
            }
            childrenByParent.computeIfAbsent(step.parentKey(), key -> new ArrayList<>()).add(step);
        }
        for (Step step : steps) {
            if (step == null || step.key() == null) {
                continue;
            }
            List<Step> candidates = new ArrayList<>();
            walkCandidates(step, childrenByParent, candidates);
            Map<String, List<String>> byHash = new LinkedHashMap<>();
            for (Step candidate : candidates) {
                if (!indexable(candidate)) {
                    continue;
                }
                byHash.computeIfAbsent(candidate.fingerprint(), key -> new ArrayList<>()).add(candidate.key());
            }
            if (!byHash.isEmpty()) {
                index.put(step.key(), byHash);
            }
        }
        return index;
    }

    /** Same walk as {@code _outbound_candidates}: an inbound child is not a candidate; its outbound descendants are. */
    private static void walkCandidates(Step node, Map<String, List<Step>> childrenByParent, List<Step> found) {
        for (Step child : childrenByParent.getOrDefault(node.key(), List.of())) {
            if (inbound(child)) {
                walkCandidates(child, childrenByParent, found);
            } else {
                found.add(child);
                if (childrenByParent.containsKey(child.key())) {
                    walkCandidates(child, childrenByParent, found);
                }
            }
        }
    }

    private static boolean indexable(Step step) {
        return step != null
                && step.enabled()
                && step.key() != null
                && step.fingerprint() != null
                && RequestFingerprint.VERSION.equals(step.fingerprintVersion())
                && recordedPath(step) != null;
    }

    private static boolean inbound(Step step) {
        String direction = step.direction() == null ? "" : step.direction();
        if ("inbound".equalsIgnoreCase(direction)) {
            return true;
        }
        if ("outbound".equalsIgnoreCase(direction)) {
            return false;
        }
        FrozenCall recording = step.recording();
        return recording != null && "inbound".equalsIgnoreCase(recording.source());
    }

    /** Null when the recording has no path. Those children stay on the legacy host/path match. */
    private static String recordedPath(Step step) {
        FrozenCall recording = step.recording();
        if (recording == null || recording.url() == null || recording.url().isBlank()) {
            return null;
        }
        try {
            String path = URI.create(recording.url()).getPath();
            return path == null || path.isBlank() ? null : path;
        } catch (IllegalArgumentException e) {
            return recording.url();
        }
    }

    private static Step stamp(Step step, Step prior) {
        if (step == null) {
            return null;
        }
        if (!"outbound".equalsIgnoreCase(step.direction()) || step.recording() == null) {
            return step.fingerprint() == null && step.fingerprintVersion() == null
                    ? step
                    : step.withFingerprint(null, null);
        }
        if (prior != null
                && RequestFingerprint.VERSION.equals(prior.fingerprintVersion())
                && prior.fingerprint() != null
                && sameRequest(prior.recording(), step.recording())) {
            if (prior.fingerprint().equals(step.fingerprint()) && RequestFingerprint.VERSION.equals(step.fingerprintVersion())) {
                return step;
            }
            return step.withFingerprint(prior.fingerprint(), RequestFingerprint.VERSION);
        }
        return step.withFingerprint(RequestFingerprint.of(step.recording()), RequestFingerprint.VERSION);
    }

    static boolean sameRequest(FrozenCall left, FrozenCall right) {
        if (left == right) {
            return true;
        }
        if (left == null || right == null) {
            return false;
        }
        return Objects.equals(left.method(), right.method())
                && Objects.equals(left.url(), right.url())
                && Objects.equals(left.requestBody(), right.requestBody())
                && sameStableHeaders(left.requestHeaders(), right.requestHeaders());
    }

    /** Cookie, user-agent, content-length, and trace headers are not part of the fingerprint. */
    private static boolean sameStableHeaders(Map<String, String> left, Map<String, String> right) {
        List<String[]> a = RequestFingerprint.stableHeaders(left);
        List<String[]> b = RequestFingerprint.stableHeaders(right);
        if (a.size() != b.size()) {
            return false;
        }
        for (int i = 0; i < a.size(); i++) {
            if (!Objects.equals(a.get(i)[0], b.get(i)[0]) || !Objects.equals(a.get(i)[1], b.get(i)[1])) {
                return false;
            }
        }
        return true;
    }
}
