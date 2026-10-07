package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.bootstrap.TrustBridge;
import com.fathy.alfred.dbagent.trust.AlfredCaTrust;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import net.bytebuddy.agent.ByteBuddyAgent;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The trust advice against a real TLS handshake (research R12): a server whose certificate Alfred's CA signed is
 * refused by the JDK as it stands, accepted once the agent trusts that CA, and refused again when the feature is off.
 * A chain from another CA is refused throughout. Certificates are made with the JDK's own keytool.
 */
class TrustAdviceIT {

    private static final String PASS = "changeit";
    private static Path dir;
    private static final List<HttpsServer> servers = new ArrayList<>();

    @BeforeAll
    static void setUp() throws Exception {
        assertThat(AgentTestSupport.DISPATCHER).isNotNull(); // the bootstrap classes are injected first
        TrustInstrumentation.install(ByteBuddyAgent.install());
        dir = Files.createTempDirectory("alfred-trust-");
        ca("alfred-ca");
        ca("other-ca");
        server("alfred-server", "alfred-ca");
        server("other-server", "other-ca");
    }

    @AfterAll
    static void tearDown() {
        TrustBridge.acceptor = null;
        servers.forEach(s -> s.stop(0));
    }

    @Test
    void onlyAlfredsChainsAreAcceptedAndOnlyWhileTheFeatureIsOn() throws Exception {
        int alfred1 = start("alfred-server");
        int alfred2 = start("alfred-server");
        int other = start("other-server");

        TrustBridge.acceptor = null;
        assertThatThrownBy(() -> get(alfred1)).isInstanceOf(SSLHandshakeException.class);

        TrustBridge.acceptor = AlfredCaTrust.fromFile(dir.resolve("alfred-ca.pem").toString());
        assertThat(get(alfred1)).isEqualTo(200);
        assertThatThrownBy(() -> get(other)).isInstanceOf(SSLHandshakeException.class);

        TrustBridge.acceptor = null; // a fresh server: no TLS session to resume
        assertThatThrownBy(() -> get(alfred2)).isInstanceOf(SSLHandshakeException.class);
    }

    private static int get(int port) throws IOException {
        HttpsURLConnection connection = (HttpsURLConnection) new URL("https://127.0.0.1:" + port + "/").openConnection(java.net.Proxy.NO_PROXY);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        try {
            return connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }

    private static int start(String keystore) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(dir.resolve(keystore + ".p12").toFile())) {
            store.load(in, PASS.toCharArray());
        }
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, PASS.toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), null, null);
        HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(context));
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        servers.add(server);
        return server.getAddress().getPort();
    }

    private static void ca(String name) throws Exception {
        keytool("-genkeypair", "-keyalg", "RSA", "-keysize", "2048", "-alias", "ca", "-dname", "CN=" + name, "-ext", "bc:c",
                "-validity", "30", "-keystore", name + ".p12", "-storetype", "PKCS12", "-storepass", PASS, "-keypass", PASS);
        keytool("-exportcert", "-rfc", "-alias", "ca", "-keystore", name + ".p12", "-storepass", PASS, "-file", name + ".pem");
    }

    private static void server(String name, String ca) throws Exception {
        keytool("-genkeypair", "-keyalg", "RSA", "-keysize", "2048", "-alias", "server", "-dname", "CN=localhost",
                "-validity", "30", "-keystore", name + ".p12", "-storetype", "PKCS12", "-storepass", PASS, "-keypass", PASS);
        keytool("-certreq", "-alias", "server", "-keystore", name + ".p12", "-storepass", PASS, "-file", name + ".csr");
        keytool("-gencert", "-rfc", "-alias", "ca", "-keystore", ca + ".p12", "-storepass", PASS, "-infile", name + ".csr",
                "-outfile", name + ".pem", "-ext", "SAN=ip:127.0.0.1,dns:localhost", "-validity", "30");
        keytool("-importcert", "-noprompt", "-alias", "ca", "-file", ca + ".pem", "-keystore", name + ".p12", "-storepass", PASS);
        keytool("-importcert", "-noprompt", "-alias", "server", "-file", name + ".pem", "-keystore", name + ".p12", "-storepass", PASS);
    }

    private static void keytool(String... args) throws Exception {
        List<String> command = new ArrayList<>();
        command.add(System.getProperty("java.home") + File.separator + "bin" + File.separator + "keytool");
        command.addAll(Arrays.asList(args));
        Process process = new ProcessBuilder(command).directory(dir.toFile()).redirectErrorStream(true).start();
        byte[] output = readAll(process.getInputStream());
        if (process.waitFor() != 0) {
            throw new IllegalStateException("keytool " + args[0] + " failed: " + new String(output, "UTF-8"));
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }
}
