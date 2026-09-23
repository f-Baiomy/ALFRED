package com.fathy.alfred.backend.interception.domain.model;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Save-time checks for a find/replace or matcher pattern, so a pattern that could freeze the proxy
 * is refused while the user is still looking at it.
 *
 * <p>The proxy has its own backstop - a regex runs in a separate process that is killed after a
 * timeout (proxy/regex_worker.py) - but a timed-out match is a skipped action and a confused
 * tester. Rejecting the shapes that backtrack catastrophically is cheaper for everyone.
 *
 * <p>A pattern must also mean the same thing in both engines: Java validates it here, and Python's
 * {@code re} runs it. Named groups and a few constructs are spelled differently or behave
 * differently between the two, so they are refused rather than translated.
 */
public final class PatternSafety {

    /** Mirrors proxy/interception.py's MAX_PATTERN_LENGTH, and is published to it in the snapshot. */
    public static final int MAX_PATTERN_LENGTH = 500;

    private PatternSafety() {
    }

    public static List<String> problems(String pattern, boolean regex) {
        List<String> problems = new ArrayList<>();
        if (pattern == null || pattern.isEmpty()) {
            problems.add("A pattern is required.");
            return problems;
        }
        if (pattern.length() > MAX_PATTERN_LENGTH) {
            problems.add("A pattern may be at most " + MAX_PATTERN_LENGTH + " characters.");
            return problems;
        }
        if (!regex) {
            // Literal text matches as itself in linear time - nothing else can go wrong.
            return problems;
        }
        // The cross-engine checks come BEFORE compiling: Python's `(?P<n>...)` does not compile in
        // Java at all, and "unknown inline modifier" would not tell anyone what to do instead.
        if (pattern.contains("(?<=") || pattern.contains("(?<!")) {
            problems.add("Lookbehind (?<= / (?<! is not supported - Java and Python accept different forms of it.");
        } else if (pattern.contains("(?P<") || pattern.matches("(?s).*\\(\\?<[A-Za-z].*")) {
            problems.add("Named groups are not supported - Java and Python spell them differently. "
                    + "Use a numbered group and \\1 in the replacement.");
        }
        if (pattern.contains("(?>")) {
            problems.add("Atomic groups (?> are not supported.");
        }
        if (hasPossessiveQuantifier(pattern)) {
            problems.add("Possessive quantifiers (*+, ++, ?+) are not supported.");
        }
        if (!problems.isEmpty()) {
            return problems;
        }
        try {
            Pattern.compile(pattern);
        } catch (PatternSyntaxException e) {
            problems.add("Regex does not compile: " + e.getDescription() + ".");
            return problems;
        }
        String nested = nestedRepeat(pattern);
        if (nested != null) {
            problems.add("This pattern repeats a group that itself repeats: " + nested
                    + ". On a long body it can take minutes. Rewrite it without the nested repeat.");
        }
        return problems;
    }

    private static boolean hasPossessiveQuantifier(String p) {
        boolean escaped = false;
        boolean inClass = false;
        for (int i = 0; i < p.length() - 1; i++) {
            char c = p.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c == '\\') {
                escaped = true;
            } else if (inClass) {
                inClass = c != ']';
            } else if (c == '[') {
                inClass = true;
            } else if ((c == '*' || c == '+' || c == '?' || c == '}') && p.charAt(i + 1) == '+') {
                // `a?+` and `a++` are possessive; `a+?` (lazy) is fine and is caught by neither.
                if (!(c == '?' && i > 0 && isQuantifierEnd(p, i - 1))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isQuantifierEnd(String p, int index) {
        char c = p.charAt(index);
        return c == '*' || c == '+' || c == '}';
    }

    /** One open group while scanning: where it started, whether something inside it repeats, and its alternatives. */
    private static final class Group {
        final int start;
        boolean repeatsInside;
        final List<String> alternatives = new ArrayList<>();
        int alternativeStart;

        Group(int start) {
            this.start = start;
            this.alternativeStart = start + 1;
        }
    }

    /**
     * Returns the offending group's text if a repeated group contains something that itself
     * repeats ({@code (a+)+}, {@code (\w+\s?)*}), or overlapping alternatives ({@code (a|aa)+}),
     * otherwise null. A character scanner rather than a regex, because a regex that recognises
     * regexes is its own maintenance problem.
     */
    static String nestedRepeat(String p) {
        Deque<Group> open = new ArrayDeque<>();
        boolean escaped = false;
        boolean inClass = false;
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (escaped) {
                // An escape (`\w`, `\d`, `\(`) is one atom; a repeat right after it counts.
                escaped = false;
                markRepeat(open, p, i);
                continue;
            }
            if (c == '\\') {
                escaped = true;
                continue;
            }
            if (inClass) {
                inClass = c != ']';
                if (!inClass) {
                    // So is a whole character class: `[a-z]+`.
                    markRepeat(open, p, i);
                }
                continue;
            }
            switch (c) {
                case '[' -> inClass = true;
                case '(' -> open.push(new Group(i));
                case '|' -> {
                    Group g = open.peek();
                    if (g != null) {
                        g.alternatives.add(p.substring(g.alternativeStart, i));
                        g.alternativeStart = i + 1;
                    }
                }
                case ')' -> {
                    Group g = open.poll();
                    if (g == null) {
                        continue;
                    }
                    if (!g.alternatives.isEmpty()) {
                        g.alternatives.add(p.substring(g.alternativeStart, i));
                    }
                    boolean repeated = repeatsAt(p, i + 1);
                    if (repeated && (g.repeatsInside || overlapping(g.alternatives))) {
                        return p.substring(g.start, Math.min(p.length(), i + 1 + quantifierLength(p, i + 1)));
                    }
                    Group parent = open.peek();
                    if (parent != null && (repeated || g.repeatsInside)) {
                        parent.repeatsInside = true;
                    }
                }
                default -> {
                    if (c != '*' && c != '+' && c != '?' && c != '}') {
                        markRepeat(open, p, i);
                    }
                }
            }
        }
        return null;
    }

    /** Notes on the innermost open group that the atom ending at {@code index} is repeated. */
    private static void markRepeat(Deque<Group> open, String p, int index) {
        Group g = open.peek();
        if (g != null && repeatsAt(p, index + 1)) {
            g.repeatsInside = true;
        }
    }

    /** Whether the quantifier starting at {@code index} can repeat more than once. {@code ?} cannot. */
    private static boolean repeatsAt(String p, int index) {
        if (index >= p.length()) {
            return false;
        }
        char c = p.charAt(index);
        if (c == '*' || c == '+') {
            return true;
        }
        if (c == '{') {
            int close = p.indexOf('}', index);
            if (close < 0) {
                return false;
            }
            String body = p.substring(index + 1, close);
            if (!body.matches("\\d+(,\\d*)?")) {
                return false;
            }
            String[] parts = body.split(",", -1);
            if (parts.length == 1) {
                return Integer.parseInt(parts[0]) > 1;
            }
            return parts[1].isEmpty() || Integer.parseInt(parts[1]) > 1;
        }
        return false;
    }

    private static int quantifierLength(String p, int index) {
        if (index < p.length() && p.charAt(index) == '{') {
            int close = p.indexOf('}', index);
            return close < 0 ? 1 : close - index + 1;
        }
        return 1;
    }

    /** `(a|aa)`: one alternative is a prefix of another, so a repeat can split the same text many ways. */
    private static boolean overlapping(List<String> alternatives) {
        for (int i = 0; i < alternatives.size(); i++) {
            for (int j = 0; j < alternatives.size(); j++) {
                String a = alternatives.get(i);
                String b = alternatives.get(j);
                if (i != j && !a.isEmpty() && b.startsWith(a)) {
                    return true;
                }
            }
        }
        return false;
    }
}
