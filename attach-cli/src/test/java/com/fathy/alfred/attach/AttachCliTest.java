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
    void featuresAreKnownNamesInAFixedOrder() {
        assertThat(AttachCli.ordered(AttachCli.features("redis, PROXY,db"))).isEqualTo("proxy,db,redis");
        assertThat(AttachCli.ordered(AttachCli.features(""))).isEmpty();
    }
}
