import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URL;
import java.security.KeyStore;

/**
 * Spike S3 target (specs/012-server-program research R12). Hosts an HTTPS server whose certificate the test CA signed,
 * builds three clients BEFORE the agent is attached, calls the server with each (the JDK refuses: unknown CA), waits
 * for the agent's "proxy" feature, then calls again with the SAME client objects.
 * Java 8 source; the JDK HttpClient (11+) and Apache HttpClient 4 are reached by reflection when present.
 */
public class S3Target {

    public static void main(String[] args) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(args[0])) {
            store.load(in, "changeit".toCharArray());
        }
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, "changeit".toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), null, null);
        HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(context));
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        String url = "https://127.0.0.1:" + server.getAddress().getPort() + "/";

        Object apache = null;
        try {
            apache = Class.forName("org.apache.http.impl.client.HttpClients").getMethod("createSystem").invoke(null);
        } catch (ClassNotFoundException e) {
            // not on the class path
        }
        Object jdk = null;
        try {
            jdk = Class.forName("java.net.http.HttpClient").getMethod("newHttpClient").invoke(null);
        } catch (ClassNotFoundException e) {
            // JDK 8
        }

        round("before", url, apache, jdk);
        System.out.println("READY pid=" + pid());
        long end = System.currentTimeMillis() + 120_000;
        while (!String.valueOf(System.getProperty("alfred.agent.features")).contains("proxy") && System.currentTimeMillis() < end) {
            Thread.sleep(200);
        }
        System.out.println("features=" + System.getProperty("alfred.agent.features"));
        round("after", url, apache, jdk);
        server.stop(0);
        System.exit(0);
    }

    static void round(String when, String url, Object apache, Object jdk) {
        report(when, "HttpURLConnection", () -> {
            HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
            int code = c.getResponseCode();
            c.disconnect();
            return code;
        });
        if (apache != null) {
            report(when, "ApacheHttpClient4(createSystem)", () -> {
                Object get = Class.forName("org.apache.http.client.methods.HttpGet").getConstructor(String.class).newInstance(url);
                Method execute = Class.forName("org.apache.http.impl.client.CloseableHttpClient")
                        .getMethod("execute", Class.forName("org.apache.http.client.methods.HttpUriRequest"));
                Object response = execute.invoke(apache, get);
                Object status = Class.forName("org.apache.http.HttpResponse").getMethod("getStatusLine").invoke(response);
                int code = (Integer) Class.forName("org.apache.http.StatusLine").getMethod("getStatusCode").invoke(status);
                ((java.io.Closeable) response).close();
                return code;
            });
        }
        if (jdk != null) {
            report(when, "JDK HttpClient", () -> {
                Class<?> requestClass = Class.forName("java.net.http.HttpRequest");
                Object builder = requestClass.getMethod("newBuilder", URI.class).invoke(null, URI.create(url));
                Object request = Class.forName("java.net.http.HttpRequest$Builder").getMethod("build").invoke(builder);
                Class<?> handlers = Class.forName("java.net.http.HttpResponse$BodyHandlers");
                Object discarding = handlers.getMethod("discarding").invoke(null);
                Method send = Class.forName("java.net.http.HttpClient").getMethod("send", requestClass,
                        Class.forName("java.net.http.HttpResponse$BodyHandler"));
                Object response = send.invoke(jdk, request, discarding);
                return (Integer) Class.forName("java.net.http.HttpResponse").getMethod("statusCode").invoke(response);
            });
        }
    }

    interface Call {
        int run() throws Exception;
    }

    static void report(String when, String client, Call call) {
        try {
            System.out.println("RESULT " + when + " " + client + " -> " + call.run());
        } catch (Throwable t) {
            Throwable root = t;
            while (root.getCause() != null) {
                root = root.getCause();
            }
            System.out.println("RESULT " + when + " " + client + " -> refused (" + root.getClass().getSimpleName() + ")");
        }
    }

    static String pid() {
        String name = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
        return name.substring(0, name.indexOf('@'));
    }
}
