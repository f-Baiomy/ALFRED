package com.fathy.alfred.backend.dbcapture.domain;

import java.util.List;

/**
 * Commands as lines that can be pasted into redis-cli (specs/011-redis-capture "Copy as redis-cli" / "Export .redis"):
 * every argument quoted, binary bytes as {@code \xNN}. A masked key's value arguments are written as {@code ‹masked›}.
 */
public final class RedisCli {

    private RedisCli() {
    }

    /** One line: the arguments (command name first) as redis-cli would read them. */
    public static String line(List<byte[]> args, boolean masked, int keyCount) {
        StringBuilder out = new StringBuilder();
        int nameWords = args.size() > 1 && List.of("CLIENT", "SCRIPT", "CONFIG", "OBJECT", "MEMORY", "XGROUP", "XINFO", "COMMAND",
                "FUNCTION", "ACL", "PUBSUB").contains(new String(args.get(0), java.nio.charset.StandardCharsets.ISO_8859_1).toUpperCase()) ? 2 : 1;
        for (int i = 0; i < args.size(); i++) {
            if (i > 0) {
                out.append(' ');
            }
            if (masked && i >= nameWords + keyCount) {
                out.append("‹masked›");
                continue;
            }
            String a = Resp.escaped(args.get(i));
            boolean plain = i < nameWords || (!a.isEmpty() && a.chars().allMatch(c -> c > 0x20 && c < 0x7f && c != '"' && c != '\'' && c != '\\'));
            String clean = Resp.utf8(args.get(i));
            String quoted = clean != null && clean.indexOf(10) < 0 && clean.indexOf(13) < 0
                    ? clean.replace("\\", "\\\\").replace("\"", "\\\"") : a;
            out.append(plain ? a : "\"" + quoted + "\"");
        }
        return out.toString();
    }
}
