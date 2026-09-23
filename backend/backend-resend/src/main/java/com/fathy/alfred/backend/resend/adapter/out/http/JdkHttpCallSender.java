package com.fathy.alfred.backend.resend.adapter.out.http;

import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.domain.model.OutgoingCall;
import com.fathy.alfred.backend.resend.domain.model.SendOutcome;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class JdkHttpCallSender implements CallSenderPort {

    private static final Logger log = LoggerFactory.getLogger(JdkHttpCallSender.class);

    private final String forwardProxyHost;
    private final String reverseProxyHost;
    private final long timeoutMs;
    private final Map<String, Integer> forwardPortMap;
    private final int defaultForwardPort;
    private final Map<String, Integer> internalListenPorts;
    private final SSLContext sslContext;

    private final Map<Integer, HttpClient> forwardClients = new ConcurrentHashMap<>();
    private volatile HttpClient inboundClient;

    public JdkHttpCallSender(
            @Value("${alfred.resend.forward-proxy-host:proxy}") String forwardProxyHost,
            @Value("${alfred.resend.reverse-proxy-host:reverse-proxy}") String reverseProxyHost,
            @Value("${alfred.resend.mitm-ca-file:/appdata/mitm-certs/mitmproxy-ca-cert.pem}") String caFile,
            @Value("${alfred.resend.timeout-ms:120000}") long timeoutMs,
            @Value("${FORWARD_PROXY_PORT_MAP:}") String forwardPortMap,
            @Value("${FORWARD_PROXY_DEFAULT_PORT:8080}") int defaultForwardPort,
            @Value("${INTERNAL_CALL_SERVICES:}") String internalCallServices) {
        this.forwardProxyHost = forwardProxyHost;
        this.reverseProxyHost = reverseProxyHost;
        this.timeoutMs = timeoutMs;
        this.defaultForwardPort = defaultForwardPort;
        this.forwardPortMap = parsePairs(forwardPortMap);
        this.internalListenPorts = parseTriples(internalCallServices);
        this.sslContext = buildSslContext(caFile);
    }

    private static Map<String, Integer> parsePairs(String value) {
        Map<String, Integer> result = new HashMap<>();
        if (value == null || value.isBlank()) {
            return result;
        }
        for (String pair : value.split(",")) {
            pair = pair.strip();
            if (pair.isEmpty()) {
                continue;
            }
            int idx = pair.lastIndexOf(':');
            if (idx <= 0) {
                continue;
            }
            String name = pair.substring(0, idx);
            String portStr = pair.substring(idx + 1);
            try {
                result.put(name, Integer.parseInt(portStr));
            } catch (NumberFormatException ignored) {
                // skip malformed pair
            }
        }
        return result;
    }

    private static Map<String, Integer> parseTriples(String value) {
        Map<String, Integer> result = new HashMap<>();
        if (value == null || value.isBlank()) {
            return result;
        }
        for (String triple : value.split(",")) {
            triple = triple.strip();
            if (triple.isEmpty()) {
                continue;
            }
            String[] parts = triple.split(":", 3);
            if (parts.length != 3) {
                continue;
            }
            try {
                result.put(parts[0], Integer.parseInt(parts[1]));
            } catch (NumberFormatException ignored) {
                // skip malformed triple
            }
        }
        return result;
    }

    private static SSLContext buildSslContext(String caFile) {
        try (FileInputStream in = new FileInputStream(caFile)) {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            Certificate cert = cf.generateCertificate(in);
            KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
            keyStore.load(null, null);
            keyStore.setCertificateEntry("mitmproxy", cert);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(keyStore);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, tmf.getTrustManagers(), null);
            return context;
        } catch (Exception e) {
            log.warn("Could not load mitmproxy CA certificate from {} - resends of https calls will fail: {}", caFile, e.getMessage());
            try {
                return SSLContext.getDefault();
            } catch (Exception fallback) {
                throw new IllegalStateException("No SSLContext available", fallback);
            }
        }
    }

    int forwardPortFor(String serviceName) {
        Integer port = serviceName == null ? null : forwardPortMap.get(serviceName);
        return port != null ? port : defaultForwardPort;
    }

    Optional<Integer> listenPortFor(String serviceName) {
        return Optional.ofNullable(serviceName == null ? null : internalListenPorts.get(serviceName));
    }

    @Override
    public SendOutcome send(OutgoingCall call) {
        try {
            if ("inbound".equals(call.direction())) {
                return sendInbound(call);
            }
            return sendOutbound(call);
        } catch (ConnectException e) {
            return "inbound".equals(call.direction()) ? new SendOutcome.ReverseProxyNotRunning()
                    : new SendOutcome.Failed(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } catch (IOException e) {
            return new SendOutcome.Failed(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new SendOutcome.Failed("interrupted");
        }
    }

    private SendOutcome sendOutbound(OutgoingCall call) throws IOException, InterruptedException {
        int port = forwardPortFor(call.serviceName());
        HttpClient client = forwardClients.computeIfAbsent(port, p -> HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .sslContext(sslContext)
                .connectTimeout(Duration.ofMillis(timeoutMs))
                .proxy(ProxySelector.of(new InetSocketAddress(forwardProxyHost, p)))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build());
        URI uri = URI.create(call.url());
        return execute(client, uri, call);
    }

    private SendOutcome sendInbound(OutgoingCall call) throws IOException, InterruptedException {
        Optional<Integer> port = listenPortFor(call.serviceName());
        if (port.isEmpty()) {
            return new SendOutcome.Failed("Project " + call.serviceName() + " is not fronted by the reverse proxy.");
        }
        if (inboundClient == null) {
            synchronized (this) {
                if (inboundClient == null) {
                    inboundClient = HttpClient.newBuilder()
                            .version(HttpClient.Version.HTTP_1_1)
                            .sslContext(sslContext)
                            .connectTimeout(Duration.ofMillis(timeoutMs))
                            .followRedirects(HttpClient.Redirect.NEVER)
                            .build();
                }
            }
        }
        URI original = URI.create(call.url());
        String pathAndQuery = pathAndQuery(original);
        URI uri = URI.create("http://" + reverseProxyHost + ":" + port.get() + pathAndQuery);
        Map<String, String> headers = new HashMap<>(call.headers());
        headers.put("Host", "localhost:" + port.get());
        OutgoingCall withHost = new OutgoingCall(call.direction(), call.method(), call.url(), headers, call.body(), call.serviceName());
        return execute(inboundClient, uri, withHost);
    }

    private static String pathAndQuery(URI uri) {
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        String query = uri.getRawQuery();
        return query != null ? path + "?" + query : path;
    }

    private SendOutcome execute(HttpClient client, URI uri, OutgoingCall call) throws IOException, InterruptedException {
        String body = call.body();
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofMillis(timeoutMs))
                .method(call.method(), body == null || body.isEmpty()
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body));
        for (Map.Entry<String, String> entry : call.headers().entrySet()) {
            try {
                builder.setHeader(entry.getKey(), entry.getValue());
            } catch (IllegalArgumentException ignored) {
                // The client still refuses some header regardless of the JVM flag - skip it, don't fail the resend.
            }
        }
        HttpRequest request = builder.build();
        long start = System.nanoTime();
        HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
        long durationMs = (System.nanoTime() - start) / 1_000_000;
        return new SendOutcome.Sent(response.statusCode(), durationMs);
    }
}
