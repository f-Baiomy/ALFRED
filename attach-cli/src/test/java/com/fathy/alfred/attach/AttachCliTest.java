package com.fathy.alfred.attach;

import com.sun.tools.attach.AgentLoadException;
import org.junit.jupiter.api.Test;

import java.util.Properties;

import static org.assertj.core.api.Assertions.assertThat;

class AttachCliTest {

    @Test
    void aJdk8TargetsZeroReplyIsSuccessAndNothingElseIs() {
        assertThat(AttachCli.jdk8Success(new AgentLoadException("0"))).isTrue();
        assertThat(AttachCli.jdk8Success(new AgentLoadException("Failed to load agent library: 0"))).isTrue();
        assertThat(AttachCli.jdk8Success(new AgentLoadException("Failed to load agent library: 100"))).isFalse();
        assertThat(AttachCli.jdk8Success(new AgentLoadException("Agent JAR not found or no Agent-Class attribute"))).isFalse();
    }

    @Test
    void wildFlyIsNamedByItsHomeAndOthersByTheirMainClass() {
        Properties wildfly = new Properties();
        wildfly.setProperty("jboss.home.dir", "/opt/wildfly");
        wildfly.setProperty("sun.java.command", "org.jboss.modules.Main -mp ...");
        assertThat(AttachCli.name(wildfly, "x")).isEqualTo("WildFly /opt/wildfly");
        Properties app = new Properties();
        app.setProperty("sun.java.command", "/srv/app.jar --server.port=8080");
        assertThat(AttachCli.name(app, "x")).isEqualTo("/srv/app.jar");
        assertThat(AttachCli.name(new Properties(), "fallback")).isEqualTo("fallback");
    }

    @Test
    void theJsonSaysWhichAlfredTheAgentReportsToAndWhetherItStoodDown() {
        String json = AttachCli.toJson(java.util.List.of(new AttachCli.Jvm("4348", "WildFly", "work", "1.8.0_191", "proxy,db", "1.0.0",
                true, "", "http://localhost:3000", null)));
        assertThat(json).contains("\"reportsTo\":\"http://localhost:3000\"").contains("\"standby\":null");
    }

    @Test
    void anAgentStandingDownSaysSoInsteadOfARouteThatIsOff() {
        Properties props = new Properties();
        props.setProperty(AttachCli.FEATURES, "proxy,db");
        props.setProperty("https.proxyHost", "127.0.0.2");
        props.setProperty("https.proxyPort", "443");
        assertThat(AttachCli.note(props)).isEqualTo("outbound through 127.0.0.2:443");
        props.setProperty(AttachCli.STANDBY, "Alfred unreachable at http://localhost:3000 (3 heartbeats missed) since 13:42");
        assertThat(AttachCli.note(props)).isEqualTo("stood down - Alfred unreachable at http://localhost:3000 (3 heartbeats missed) since 13:42");
    }

    @Test
    void featuresAreKnownNamesInAFixedOrder() {
        assertThat(AttachCli.ordered(AttachCli.features("redis, PROXY,db"))).isEqualTo("proxy,db,redis");
        assertThat(AttachCli.ordered(AttachCli.features(""))).isEmpty();
    }
}
