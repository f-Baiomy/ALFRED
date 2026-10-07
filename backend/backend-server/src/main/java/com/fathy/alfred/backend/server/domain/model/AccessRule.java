package com.fathy.alfred.backend.server.domain.model;

import java.math.BigInteger;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Who may change server settings and restart Alfred (FR-050..054, research R9), from ALFRED_SETTINGS_EDIT_FROM:
 * {@code local} (this machine), {@code lan} (private addresses), and explicit addresses or CIDR ranges.
 *
 * <p>The decision uses the TCP peer address only - never X-Forwarded-For, which any client can write. A request that
 * came through the Cloudflare tunnel is always refused, whatever its address: cloudflared runs on this machine, so it
 * reaches Alfred from 127.0.0.1, and only the headers Cloudflare always adds (and a client cannot remove) tell it
 * apart. In Docker mode every write is refused: settings live in the repo's .env and apply with restart.py.
 */
public final class AccessRule {

    /** Added by Cloudflare to every request it forwards. */
    public static final Set<String> TUNNEL_HEADERS = Set.of("cf-connecting-ip", "cf-ray", "cdn-loop");

    private static final Pattern ADDRESS_CHARS = Pattern.compile("^[0-9A-Fa-f:.]+(/\\d{1,3})?$");
    private static final List<String> LAN_RANGES = List.of("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7");
    private static final String HOW_TO_EDIT_TUNNEL = "Server settings can't be changed through the Cloudflare tunnel. "
            + "Open Alfred on the local network or through an SSH tunnel (ssh -L 3000:localhost:3000 <server>), "
            + "or use 'alfred config' on the server.";
    private static final String HOW_TO_EDIT_DOCKER = "Alfred runs with Docker here: edit .env in the Alfred folder, then run python3 restart.py.";

    private final boolean local;
    private final boolean lan;
    private final List<Cidr> listed;

    private AccessRule(boolean local, boolean lan, List<Cidr> listed) {
        this.local = local;
        this.lan = lan;
        this.listed = List.copyOf(listed);
    }

    /** Parses the setting; invalid tokens are ignored here (the validator reports them before they can be saved). */
    public static AccessRule parse(String value) {
        boolean local = false;
        boolean lan = false;
        List<Cidr> listed = new ArrayList<>();
        for (String token : SettingsValidator.splitList(value)) {
            switch (token.toLowerCase(Locale.ROOT)) {
                case "local" -> local = true;
                case "lan" -> lan = true;
                default -> {
                    Cidr cidr = Cidr.parse(token);
                    if (cidr != null) {
                        listed.add(cidr);
                    }
                }
            }
        }
        return new AccessRule(local, lan, listed);
    }

    public static boolean validToken(String token) {
        String lower = token.toLowerCase(Locale.ROOT);
        return lower.equals("local") || lower.equals("lan") || Cidr.parse(token) != null;
    }

    /**
     * @param headerNames      names of the request's headers (any case)
     * @param localAddresses   this machine's own interface addresses ("local" covers them too)
     */
    public EditAccess decide(String peerAddress, Set<String> headerNames, Set<String> localAddresses, RuntimeMode mode) {
        if (mode == RuntimeMode.DOCKER) {
            return new EditAccess(false, EditAccess.Reason.DOCKER_MODE, peerAddress, HOW_TO_EDIT_DOCKER);
        }
        boolean tunnel = headerNames.stream().map(h -> h.toLowerCase(Locale.ROOT)).anyMatch(TUNNEL_HEADERS::contains);
        if (tunnel) {
            return new EditAccess(false, EditAccess.Reason.TUNNEL, peerAddress, HOW_TO_EDIT_TUNNEL);
        }
        InetAddress peer = address(peerAddress);
        if (peer != null) {
            if (local && (peer.isLoopbackAddress() || localAddresses.contains(peer.getHostAddress()))) {
                return new EditAccess(true, EditAccess.Reason.LOCAL, peerAddress, "");
            }
            if (lan && LAN_RANGES.stream().map(Cidr::parse).anyMatch(c -> c.contains(peer))) {
                return new EditAccess(true, EditAccess.Reason.LAN, peerAddress, "");
            }
            if (listed.stream().anyMatch(c -> c.contains(peer))) {
                return new EditAccess(true, EditAccess.Reason.LISTED, peerAddress, "");
            }
        }
        return new EditAccess(false, EditAccess.Reason.NOT_LISTED, peerAddress,
                "Your address " + peerAddress + " is not allowed by ALFRED_SETTINGS_EDIT_FROM. "
                        + "Open Alfred from the server itself (ssh -L 3000:localhost:3000 <server>) or use 'alfred config' there.");
    }

    public Map<String, Object> describe() {
        return Map.of("local", local, "lan", lan, "listed", listed.stream().map(Cidr::toString).toList());
    }

    private static InetAddress address(String text) {
        if (text == null || !ADDRESS_CHARS.matcher(text).matches()) {
            return null;
        }
        try {
            return InetAddress.getByName(text);
        } catch (UnknownHostException e) {
            return null;
        }
    }

    /** An address or a CIDR range, IPv4 or IPv6. Literal addresses only - nothing is ever looked up by name. */
    record Cidr(byte[] network, int prefix, String text) {

        static Cidr parse(String token) {
            if (token == null || !ADDRESS_CHARS.matcher(token).matches()) {
                return null;
            }
            String[] parts = token.split("/", 2);
            InetAddress base = address(parts[0]);
            if (base == null) {
                return null;
            }
            int bits = base.getAddress().length * 8;
            int prefix;
            try {
                prefix = parts.length == 2 ? Integer.parseInt(parts[1]) : bits;
            } catch (NumberFormatException e) {
                return null;
            }
            if (prefix < 0 || prefix > bits) {
                return null;
            }
            return new Cidr(base.getAddress(), prefix, token);
        }

        boolean contains(InetAddress candidate) {
            byte[] bytes = candidate.getAddress();
            if (bytes.length != network.length) {
                return false;
            }
            int shift = network.length * 8 - prefix;
            BigInteger mask = BigInteger.ONE.shiftLeft(network.length * 8).subtract(BigInteger.ONE)
                    .shiftRight(shift).shiftLeft(shift);
            return new BigInteger(1, bytes).and(mask).equals(new BigInteger(1, network).and(mask));
        }

        @Override
        public String toString() {
            return text;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Cidr other && other.text.equals(text);
        }

        @Override
        public int hashCode() {
            return text.hashCode();
        }
    }
}
