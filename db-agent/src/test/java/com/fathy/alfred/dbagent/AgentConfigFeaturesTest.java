package com.fathy.alfred.dbagent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AgentConfigFeaturesTest {

    @Test
    void withoutFeaturesTheAgentCapturesAsItAlwaysDid() {
        AgentConfig config = AgentConfig.parse("alfredUrl=http://localhost:3000/;project=wallet;secret=s");
        assertThat(config.featureList()).isEqualTo("db,logs,redis");
        assertThat(config.has("proxy")).isFalse();
        assertThat(config.captures()).isTrue();
        assertThat(config.alfredUrl).isEqualTo("http://localhost:3000");
    }

    @Test
    void theFeatureSetProxyAndCaAreRead() {
        AgentConfig config = AgentConfig.parse("alfredUrl=http://127.0.0.1:3000;project=wallet;secret=s;"
                + "features=Proxy, redis,teleport;proxy=127.0.0.2:8443;caFile=/opt/alfred/ca.pem");
        assertThat(config.featureList()).isEqualTo("proxy,redis");
        assertThat(config.proxy).isEqualTo("127.0.0.2:8443");
        assertThat(config.caFile).isEqualTo("/opt/alfred/ca.pem");

        AgentConfig proxyOnly = AgentConfig.parse("features=proxy");
        assertThat(proxyOnly.captures()).isFalse();
        assertThat(proxyOnly.proxy).isEqualTo("127.0.0.2:443");
        assertThat(AgentConfig.parse("features=").featureList()).isEmpty();
    }
}
