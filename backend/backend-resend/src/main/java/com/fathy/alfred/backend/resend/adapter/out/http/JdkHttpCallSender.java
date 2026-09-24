package com.fathy.alfred.backend.resend.adapter.out.http;

import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Sends a resend back through Alfred's own proxies - outbound through the forward proxy (so
 * interception rules apply exactly as they do for a live call from that project), inbound direct
 * to the reverse-proxy listener for the target project (the same one browser traffic already
 * reaches). Needs the mitmproxy CA to trust either proxy's re-signed TLS certificate, and
 * {@code -Djdk.httpclient.allowRestrictedHeaders=host} (set on the backend's JAVA_TOOL_OPTIONS) to
 * be allowed to set the Host header itself for the inbound case.
 */
@Component
public class JdkHttpCallSender implements CallSenderPort {

    private static final Logger log = LoggerFactory.getLogger(JdkHttpCallSender.class);

    /** Headers HttpClient computes itself and refuses to have set explicitly - copying these through verbatim would throw. */
    private static final Set<String> RESTRICTED_HEADERS =
            Set.of("content-length", "connection", "transfer-encoding", "upgrade", "expect");

    private final HttpClient inboundClient;
    private final SSLContext sslContext;
    private final Duration timeout;
    private final String forwardProxyHost;
    private final int forwardProxyDefaultPort;
    private final Map<String, Integer> forwardProxyPorts;
    private final String reverseProxyHost;
    private final Map<String, Integer> reverseListenPorts;

    @Autowired
    public JdkHttpCallSender(
            @Value("${alfred.resend.mitm-ca-file}") String mitmCaFile,
            @Value("${alfred.resend.timeout-ms}") long timeoutMs,
            @Value("${alfred.resend.forward-proxy-host}") String forwardProxy,
            @Value("${FORWARD_PROXY_DEFAULT_PORT:8080}") int forwardProxyDefaultPort,
            @Value("${FORWARD_PROXY_PORT_MAP:}") String forwardProxyPortMap,
            @Value("${alfred.resend.reverse-proxy-host}") String reverseProxyHost,
            @Value("${INTERNAL_CALL_SERVICES:}") String internalCallServices) {
        this(Duration.ofMillis(timeoutMs), hostOf(forwardProxy), forwardProxyDefaultPort,
                parsePairs(forwardProxyPortMap), reverseProxyHost, parseListenPorts(internalCallServices),
                sslContextFrom(mitmCaFile));
    }

    /** Package-private: lets tests point the proxy hosts at a local server and skip the real CA file. */
    JdkHttpCallSender(Duration timeout, String forwardProxyHost, int forwardProxyDefaultPort,
                       Map<String, Integer> forwardProxyPorts, String reverseProxyHost,
                       Map<String, Integer> reverseListenPorts, SSLContext sslContext) {
        this.timeout = timeout;
        this.forwardProxyHost = forwardProxyHost;
        this.forwardProxyDefaultPort = forwardProxyDefaultPort;
        this.forwardProxyPorts = forwardProxyPorts;
        this.reverseProxyHost = reverseProxyHost;
        this.reverseListenPorts = reverseListenPorts;
        this.sslContext = sslContext;
        HttpClient.Builder builder = HttpClient.newBuilder().connectTimeout(timeout);
        if (sslContext != null) {
            builder.sslContext(sslContext);
        }
        this.inboundClient = builder.build();
    }

    @Override
    public SendOutcome send(OutgoingCall call) {
        boolean inbound = "inbound".equals(call.direction());
        try {
            return inbound ? sendInbound(call) : sendOutbound(call);
        } catch (ConnectException e) {
            // Only meaningful for inbound: a refused connection there means the reverse-proxy
            // listener for this project isn't running (see contracts/rest-api.md's 409). Outbound
            // always has the forward proxy running (it's part of every deployment), so a refused
            // connection there is an ordinary send failure.
            return inbound ? new SendOutcome.ReverseProxyNotRunning() : new SendOutcome.Failed(e.getMessage());
        } catch (IOException e) {
            return new SendOutcome.Failed(e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new SendOutcome.Failed(e.getMessage());
        }
    }

    private SendOutcome sendInbound(OutgoingCall call) throws IOException, InterruptedException {
        int listenPort = reverseListenPorts.getOrDefault(call.serviceName(), 0);
        URI original = URI.create(call.url());
        String pathAndQuery = (original.getRawPath() == null || original.getRawPath().isEmpty() ? "/" : original.getRawPath())
                + (original.getRawQuery() != null ? "?" + original.getRawQuery() : "");
        URI target = URI.create("http://" + reverseProxyHost + ":" + listenPort + pathAndQuery);

        HttpRequest.Builder builder = HttpRequest.newBuilder(target).timeout(timeout);
        applyHeaders(builder, call.headers());
        // Alfred's caller stayed on localhost (see docs/interception.md); the reverse proxy is
        // told to keep pretending it still is, exactly as a browser hitting it directly would.
        builder.header("Host", "localhost:" + listenPort);
        applyMethodAndBody(builder, call);

        return doSend(inboundClient, builder.build());
    }

    private SendOutcome sendOutbound(OutgoingCall call) throws IOException, InterruptedException {
        int port = forwardProxyPorts.getOrDefault(call.serviceName(), forwardProxyDefaultPort);
        HttpClient.Builder clientBuilder = HttpClient.newBuilder()
                .connectTimeout(timeout)
                .proxy(ProxySelector.of(new InetSocketAddress(forwardProxyHost, port)));
        if (sslContext != null) {
            clientBuilder.sslContext(sslContext);
        }
        HttpClient client = clientBuilder.build();

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(call.url())).timeout(timeout);
        applyHeaders(builder, call.headers());
        applyMethodAndBody(builder, call);

        return doSend(client, builder.build());
    }

    private static SendOutcome doSend(HttpClient client, HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        return new SendOutcome.Sent(response.statusCode(), response.body());
    }

    private static void applyHeaders(HttpRequest.Builder builder, Map<String, String> headers) {
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String lower = entry.getKey().toLowerCase(Locale.ROOT);
            if (RESTRICTED_HEADERS.contains(lower) || lower.equals("host")) {
                continue;
            }
            builder.header(entry.getKey(), entry.getValue());
        }
    }

    private static void applyMethodAndBody(HttpRequest.Builder builder, OutgoingCall call) {
        String method = call.method() == null || call.method().isBlank() ? "GET" : call.method().toUpperCase(Locale.ROOT);
        String body = call.body();
        HttpRequest.BodyPublisher publisher = body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8);
        builder.method(method, publisher);
    }

    private static String hostOf(String hostPort) {
        int colon = hostPort == null ? -1 : hostPort.indexOf(':');
        return colon < 0 ? hostPort : hostPort.substring(0, colon);
    }

    /** {@code name:internalPort} pairs, comma-separated - the same shape proxy/forward-proxy-entrypoint.sh reads. */
    static Map<String, Integer> parsePairs(String value) {
        Map<String, Integer> ports = new HashMap<>();
        if (value == null || value.isBlank()) {
            return ports;
        }
        for (String pair : value.split(",")) {
            String trimmed = pair.strip();
            if (trimmed.isEmpty()) {
                continue;
            }
            int lastColon = trimmed.lastIndexOf(':');
            if (lastColon < 0) {
                continue;
            }
            String name = trimmed.substring(0, lastColon);
            String port = trimmed.substring(lastColon + 1);
            if (name.isBlank() || !port.chars().allMatch(Character::isDigit) || port.isBlank()) {
                continue;
            }
            ports.put(name, Integer.parseInt(port));
        }
        return ports;
    }

    /** {@code name:listenPort:upstreamPort} triples, comma-separated - the reverse proxy's own shape (see SelfTargetsConfig.listenPorts). */
    static Map<String, Integer> parseListenPorts(String value) {
        Map<String, Integer> ports = new HashMap<>();
        if (value == null || value.isBlank()) {
            return ports;
        }
        for (String triple : value.split(",")) {
            String[] parts = triple.strip().split(":");
            if (parts.length >= 2 && !parts[0].isBlank() && parts[1].chars().allMatch(Character::isDigit) && !parts[1].isBlank()) {
                ports.put(parts[0], Integer.parseInt(parts[1]));
            }
        }
        return ports;
    }

    /** The proxy port a resend for this service goes out through - package-private so it can be unit-tested without a network call. */
    int forwardProxyPortFor(String serviceName) {
        return forwardProxyPorts.getOrDefault(serviceName, forwardProxyDefaultPort);
    }

    /** Trusts the mitmproxy CA so the re-signed certificate either proxy presents is accepted, without trusting nothing else the JVM already does. */
    private static SSLContext sslContextFrom(String pemPath) {
        try {
            byte[] pem = Files.readAllBytes(Path.of(pemPath));
            CertificateFactory certFactory = CertificateFactory.getInstance("X.509");
            Certificate certificate = certFactory.generateCertificate(new ByteArrayInputStream(pem));

            KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
            keyStore.load(null, null);
            keyStore.setCertificateEntry("mitmproxy-ca", certificate);

            TrustManagerFactory trustManagerFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trustManagerFactory.init(keyStore);

            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustManagerFactory.getTrustManagers(), null);
            return context;
        } catch (Exception e) {
            // The CA file appears only once the stack has actually started (proxy/certs is a
            // shared volume, populated on first mitmdump run) - a resend attempted before that is
            // a send failure, not a reason to keep the whole backend from starting.
            log.warn("Could not load the mitmproxy CA from {} - resend will fail TLS verification until it exists: {}",
                    pemPath, e.getMessage());
            return null;
        }
    }
}
