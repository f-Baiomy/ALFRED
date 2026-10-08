package org.example.lateattach;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

/**
 * The application LateAttachIT attaches to: a servlet answering one inbound call every 100 ms, each running a JDBC
 * statement - started long before any agent, so its driver and servlet classes are loaded when the agent arrives,
 * as in a WildFly that has been running for hours. Calls carry the X-Alfred-Call header the reverse proxy would add.
 * Runs until its stdin closes (the test ends).
 */
public class LateApp extends HttpServlet {

    private final Connection connection;
    private volatile String callId;

    LateApp(Connection connection) {
        this.connection = connection;
    }

    public static void main(String[] args) throws Exception {
        Connection c = DriverManager.getConnection("jdbc:h2:mem:late;DB_CLOSE_DELAY=-1");
        c.createStatement().execute("CREATE TABLE LATE_T(ID INT)");
        LateApp app = new LateApp(c);
        Thread stdin = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in))) {
                while (in.readLine() != null) {
                    // nothing: only its end matters
                }
            } catch (Exception ignored) {
                // the end, either way
            }
            System.exit(0);
        });
        stdin.setDaemon(true);
        stdin.start();
        System.out.println("READY");
        System.out.flush();
        for (int n = 1; ; n++) {
            app.call("late-call-" + n);
            Thread.sleep(100);
        }
    }

    void call(String id) throws Exception {
        callId = id;
        HttpServletRequest request = (HttpServletRequest) Proxy.newProxyInstance(LateApp.class.getClassLoader(),
                new Class<?>[]{HttpServletRequest.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getHeader":
                            return "X-Alfred-Call".equalsIgnoreCase((String) args[0]) ? "id=" + callId + "; db=1" : null;
                        case "getMethod":
                            return "GET";
                        case "getProtocol":
                            return "HTTP/1.1";
                        case "getDateHeader":
                            return -1L;
                        case "getIntHeader":
                            return -1;
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        case "equals":
                            return proxy == args[0];
                        case "toString":
                            return "request " + callId;
                        default:
                            return method.getReturnType() == boolean.class ? false : method.getReturnType() == int.class ? 0 : null;
                    }
                });
        HttpServletResponse response = (HttpServletResponse) Proxy.newProxyInstance(LateApp.class.getClassLoader(),
                new Class<?>[]{HttpServletResponse.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        case "equals":
                            return proxy == args[0];
                        default:
                            return method.getReturnType() == boolean.class ? false : method.getReturnType() == int.class ? 0 : null;
                    }
                });
        service(request, response);
    }

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) {
        try (PreparedStatement ps = connection.prepareStatement("SELECT COUNT(*) FROM LATE_T WHERE ID = ?")) {
            ps.setInt(1, 7);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
            }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
