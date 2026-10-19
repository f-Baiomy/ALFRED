package com.fathy.alfred.backend.linksbridge;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The read allowlist (R2) - the read-side twin of BoardWriteTargets. Every route a stream may answer is here, with where
 * its ref sits (a path segment or a query parameter) and what kind of thing the ref names; the owner answers a linked
 * Alfred's read only when one of its streams covers that thing ({@link StreamScope}), and the reader sends a GET whose
 * ref carries a link's suffix ({@code <id>@<slug>}) over that link. A route missing from here is never streamed.
 * StreamRoutesTest walks every GET route of the backend and fails on one that is neither here nor in {@link #NEVER}.
 */
final class StreamRoutes {

    enum Kind {
        /** A session cycle. */
        CYCLE,
        /** A call (inbound or outbound) - in a streamed cycle, or in a streamed board's cycles. */
        CALL,
        /** Several calls, comma-separated in one parameter: every one must be covered. */
        CALLS,
        /** A captured statement: covered when its call is (checked on the answer). */
        STATEMENT,
        /** A captured Redis command: covered when its call is (checked on the answer). */
        STORE_COMMAND,
        /** A board (task): its id, or {@code default:<project>}. */
        BOARD,
        /** A board named by the {@code cycleId} parameter, or the project's default board when it is absent. */
        BOARD_OR_PROJECT,
        /** A project: covered when one of its boards is streamed (team names and the like, no data). */
        PROJECT,
        /** A card, by id. */
        CARD,
        /** A card by number, with the {@code project} parameter. */
        CARD_NUMBER,
        /** A board chat, by scope and the {@code project} parameter. */
        CHAT,
        /** A board file, snippet or picture, by id. */
        FILE, SNIPPET, IMAGE
    }

    /** Where a ref sits: path group {@code group} (1-based) or query parameter {@code param}. */
    record Ref(Kind kind, int group, String param) {

        static Ref path(Kind kind, int group) {
            return new Ref(kind, group, null);
        }

        static Ref param(Kind kind, String param) {
            return new Ref(kind, 0, param);
        }
    }

    /**
     * {@code post}: a read sent as POST (investigation scopes) - its call ids are in the JSON body's {@code callIds}.
     * {@code relaysRefs} false: a ref with a link's suffix on this route stays with this Alfred - it asks about this
     * Alfred's own view of another's thing ("which of my boards is that cycle on"); a stream still answers it when a
     * reader opens the owner's board itself.
     */
    record Route(String family, Pattern path, List<Ref> refs, boolean post, boolean relaysRefs) {
    }

    /** A ref found in a request: its value (decoded) and where it was. */
    record Found(Ref ref, String value) {
    }

    record Match(Route route, List<Found> found, Map<String, List<String>> params) {

        Optional<Found> of(Kind kind) {
            return found.stream().filter(f -> f.ref().kind() == kind).findFirst();
        }

        String param(String name) {
            List<String> v = params.get(name);
            return v == null || v.isEmpty() ? null : v.get(0);
        }
    }

    private static final String ID = "([^/]+)";

    static final List<Route> ROUTES = List.of(
            // ---------------------------------------------------------------------------------------- session cycles
            get("cycle", "/session-cycles/" + ID, Ref.path(Kind.CYCLE, 1)),
            get("cycle", "/session-cycles/" + ID + "/(?:calls|internal-calls|call-overlaps|spacers|summary|notes)", Ref.path(Kind.CYCLE, 1)),
            get("call", "/session-cycles/" + ID + "/(?:calls|internal-calls)/" + ID + "/detail", Ref.path(Kind.CYCLE, 1), Ref.path(Kind.CALL, 2)),
            // ---------------------------------------------------------------------------------------------- calls
            get("call", "/internal-calls/" + ID + "(?:/(?:detail|summary|interception|ws-messages))?", Ref.path(Kind.CALL, 1)),
            get("call", "/calls/" + ID + "(?:/(?:detail|summary|interception|ws-messages|children))?", Ref.path(Kind.CALL, 1)),
            // ----------------------------------------------------------------------------------- database, Redis, logs
            get("db", "/db-capture/calls/" + ID + "/(?:statements|statements/query|store-commands|store-commands/redis-cli|store-keys|tables|trace|export)",
                    Ref.path(Kind.CALL, 1)),
            get("db", "/db-capture/statements/" + ID + "(?:/rows)?", Ref.path(Kind.STATEMENT, 1)),
            get("db", "/db-capture/store-commands/" + ID, Ref.path(Kind.STORE_COMMAND, 1)),
            get("db", "/db-capture/summaries", Ref.param(Kind.CALLS, "callIds")),
            get("db", "/db-capture/store/summaries", Ref.param(Kind.CALLS, "callIds")),
            get("logs", "/call-logs/" + ID, Ref.path(Kind.CALL, 1)),
            get("logs", "/call-logs/counts", Ref.param(Kind.CALLS, "callIds")),
            get("comments", "/comments", Ref.param(Kind.CALL, "callId")),
            get("comments", "/comments/counts", Ref.param(Kind.CALLS, "callIds")),
            get("triage", "/triage/calls", Ref.param(Kind.CALLS, "callIds")),
            post("triage", "/triage/(?:problem-calls|timeline|endpoints)"),
            post("logs", "/call-logs/(?:problems|problems/calls|search)"),
            // ------------------------------------------------------------------------------------------------ boards
            get("board", "/board/boards/" + ID + "(?:/(?:stage|activity|cycle-rows|cycle-prefs|call-badges|brief|brief/comments|checklist|requirements"
                    + "|requirements/calls|steps|specs|specs/.+|evidence|log))?", Ref.path(Kind.BOARD, 1)),
            get("board", "/board/cards", Ref.param(Kind.BOARD_OR_PROJECT, "cycleId")),
            get("board", "/board/cards/by-number/" + ID, Ref.path(Kind.CARD_NUMBER, 1)),
            get("board", "/board/cards/" + ID + "(?:/(?:activity|questions|cycles|cycle-verdicts|retest|owner))?", Ref.path(Kind.CARD, 1)),
            get("board", "/board/cycles/" + ID + "/(?:brief|brief/comments|checklist|requirements|requirements/calls|steps|specs|specs/.+|evidence|log)",
                    Ref.path(Kind.BOARD, 1)),
            local("board", "/board/cycles/" + ID + "/(?:call-badges|home|boards|verdicts)", Ref.path(Kind.CYCLE, 1)),
            // the cards that mention these calls: on a page of this Alfred, its own cards - a stream answers it for the
            // owner's board read through /links/r
            local("board", "/board/call-badges", Ref.param(Kind.CALLS, "callIds")),
            get("board", "/board/verify", Ref.param(Kind.BOARD_OR_PROJECT, "cycleId")),
            get("board", "/board/next-steps", Ref.param(Kind.BOARD_OR_PROJECT, "cycleId")),
            get("board", "/board/retest", Ref.param(Kind.BOARD_OR_PROJECT, "cycleId")),
            get("board", "/board/questions", Ref.param(Kind.BOARD_OR_PROJECT, "cycleId")),
            get("board", "/board/teams", Ref.param(Kind.PROJECT, "project")),
            get("chat", "/board/chats/" + ID + "/(?:messages|digest|search|shared)", Ref.path(Kind.CHAT, 1)),
            get("board", "/board/files/" + ID, Ref.path(Kind.FILE, 1)),
            get("board", "/board/snippets/" + ID + "(?:/(?:versions|state|state/[^/]+|state/[^/]+/history|shot|shot[.]png))?", Ref.path(Kind.SNIPPET, 1)),
            get("board", "/board/images/" + ID, Ref.path(Kind.IMAGE, 1)),
            // the board's team tracker items as Alfred keeps them (copies) - never a live tracker read (D16)
            get("board", "/teamboards/boards/" + ID + "/(?:items|main)", Ref.path(Kind.BOARD, 1)),
            // ---------------------------------------------------------------- what the reader's board judges with (linksbridge)
            get("cycle", "/links/data/cycle", Ref.param(Kind.CYCLE, "cycleId")),
            get("cycle", "/links/data/cycle-calls", Ref.param(Kind.CYCLE, "cycleId")),
            get("call", "/links/data/call-facts", Ref.param(Kind.CYCLE, "cycleId"), Ref.param(Kind.CALL, "callId")),
            get("call", "/links/data/call-bodies", Ref.param(Kind.CYCLE, "cycleId"), Ref.param(Kind.CALL, "callId")),
            // an environment Alfred asks the host to judge its re-test cycle (D40): the host reads that cycle over the link
            get("board", "/links/data/env-judge", Ref.param(Kind.BOARD, "boardId")));

    /**
     * GET routes deliberately never streamed (D9): settings, interception, Relive and resend, the Logs explorer, Team
     * tracker reads (the owner's token), recording and capture switches, server, sessions, storage, exports outside the
     * board. StreamRoutesTest checks that every GET route is in {@link #ROUTES} or matches one of these.
     */
    static final List<Pattern> NEVER = List.of(
            Pattern.compile("^/(settings|interception|relive-cycles|resend|scenarios|profiles|redactions|server|database|health|logs|mcp|mcp-exports"
                    + ")(/.*)?$"),
            // the tracker itself (searches, people, the token, bundles) - only a board's copies are streamed (above)
            Pattern.compile("^/teamboards(/(?!boards/[^/]+/(items|main)$).*)?$"),
            // a link's own API stays with this Alfred; only what a reader's board judges with (/links/data) is streamed
            Pattern.compile("^/links(/(?!data/).*)?$"),
            Pattern.compile("^/(calls|internal-calls)(/(baseline|services|services/.+|feature-enabled|export-metadata))?$"),
            Pattern.compile("^/call-overlaps$"),
            Pattern.compile("^/session-cycles(/relive-runs/.+)?$"),
            Pattern.compile("^/db-capture/(projects.*|failures|silent|outside.*|store-keys/history|store/failures)$"),
            Pattern.compile("^/triage/(live|counts)$"),
            Pattern.compile("^/board/(access|agent-status|boards|changes|changes/.+|cycle-chat|board-chat|owners|people/.+|visuals|live-runner|live-work|retest/guards|skill-runs.*|storage|versions"
                    + "|chats|chats/export|chats/messages/.+|chats/[^/]+/(context|settings|terminal|watches)|data/.+|me|me/.+|users.*|helpers.*|holders.*"
                    + "|browsers.*|sessions.*|helper-commands.*|audit.*|connect.*|import.*|widgets.*|pages|files|files/[^/]+/answers[.]json|teams/.+|asks.*|cards/[^/]+/text-versions"
                    + "|cycles/[^/]+/delete-plan|search.*|similar.*|closed-reasons.*|regressions.*|mentions.*|live-strip.*|session-log.*|for-call.*)$"),
            Pattern.compile("^/call-logs/(import)$"));

    private static Route get(String family, String path, Ref... refs) {
        return new Route(family, Pattern.compile("^" + path + "$"), List.of(refs), false, true);
    }

    private static Route local(String family, String path, Ref... refs) {
        return new Route(family, Pattern.compile("^" + path + "$"), List.of(refs), false, false);
    }

    private static Route post(String family, String path) {
        return new Route(family, Pattern.compile("^" + path + "$"), List.of(Ref.param(Kind.CALLS, "callIds")), true, true);
    }

    private StreamRoutes() {
    }

    /** The path with each segment decoded (a ref may arrive as {@code %40}); '/' inside a segment stays encoded. */
    static String decodePath(String rawPath) {
        StringBuilder out = new StringBuilder();
        for (String seg : rawPath.split("/", -1)) {
            if (out.length() > 0 || rawPath.startsWith("/")) {
                out.append('/');
            }
            String d = URLDecoder.decode(seg.replace("+", "%2B"), StandardCharsets.UTF_8);
            out.append(d.replace("/", "%2F"));
        }
        String s = out.toString();
        return s.startsWith("//") ? s.substring(1) : s;
    }

    static Map<String, List<String>> params(String query) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        if (query == null || query.isBlank()) {
            return out;
        }
        for (String part : query.split("&")) {
            if (part.isEmpty()) {
                continue;
            }
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
            out.computeIfAbsent(k, x -> new ArrayList<>()).add(v);
        }
        return out;
    }

    /** The route a request matches, with its refs; a POST read's call ids come from {@code bodyCallIds}. */
    static Optional<Match> match(String method, String decodedPath, Map<String, List<String>> params, List<String> bodyCallIds) {
        boolean isPost = "POST".equals(method);
        if (!isPost && !"GET".equals(method) || never(decodedPath)) {
            // NEVER wins: "/internal-calls/baseline" is not a call named "baseline"
            return Optional.empty();
        }
        for (Route r : ROUTES) {
            if (r.post() != isPost) {
                continue;
            }
            Matcher m = r.path().matcher(decodedPath);
            if (!m.matches()) {
                continue;
            }
            List<Found> found = new ArrayList<>();
            for (Ref ref : r.refs()) {
                if (ref.group() > 0) {
                    found.add(new Found(ref, m.group(ref.group())));
                } else if (r.post()) {
                    String joined = String.join(",", bodyCallIds == null ? List.of() : bodyCallIds);
                    found.add(new Found(ref, joined));
                } else {
                    List<String> v = params.get(ref.param());
                    if (v != null && !v.isEmpty() && !v.get(0).isBlank()) {
                        found.add(new Found(ref, v.get(0)));
                    } else if (ref.kind() == Kind.BOARD_OR_PROJECT) {
                        List<String> project = params.get("project");
                        if (project != null && !project.isEmpty() && !project.get(0).isBlank()) {
                            found.add(new Found(ref, "default:" + project.get(0)));
                        }
                    }
                }
            }
            return Optional.of(new Match(r, found, params));
        }
        return Optional.empty();
    }

    static boolean never(String decodedPath) {
        return NEVER.stream().anyMatch(p -> p.matcher(decodedPath).matches());
    }
}
