package com.fathy.alfred.dbagent.proxy;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ProxySwitchTest {

    @AfterEach
    void clean() {
        ProxySwitch.off();
        for (String key : ProxySwitch.KEYS) {
            System.clearProperty(key);
        }
    }

    @Test
    void onSetsBothPairsAndOffRestoresWhatWasThere() {
        System.setProperty("https.proxyHost", "corporate.proxy");
        System.setProperty("https.proxyPort", "3128");

        ProxySwitch.on("127.0.0.2:443");
        ProxySwitch.on("127.0.0.2:8443"); // a second attach changes the address, it does not forget the original
        assertThat(ProxySwitch.isOn()).isTrue();
        assertThat(System.getProperty("http.proxyHost")).isEqualTo("127.0.0.2");
        assertThat(System.getProperty("http.proxyPort")).isEqualTo("8443");
        assertThat(System.getProperty("https.proxyHost")).isEqualTo("127.0.0.2");
        assertThat(System.getProperty("https.proxyPort")).isEqualTo("8443");

        ProxySwitch.off();
        assertThat(ProxySwitch.isOn()).isFalse();
        assertThat(System.getProperty("https.proxyHost")).isEqualTo("corporate.proxy");
        assertThat(System.getProperty("https.proxyPort")).isEqualTo("3128");
        assertThat(System.getProperty("http.proxyHost")).isNull();
        assertThat(System.getProperty("http.proxyPort")).isNull();
    }

    @Test
    void offWithoutOnChangesNothingAndABadAddressIsRefused() {
        System.setProperty("http.proxyHost", "kept");
        ProxySwitch.off();
        assertThat(System.getProperty("http.proxyHost")).isEqualTo("kept");
        assertThatThrownBy(() -> ProxySwitch.on("no-port")).isInstanceOf(IllegalArgumentException.class);
        assertThat(ProxySwitch.isOn()).isFalse();
    }
}
