package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Issued;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class KeysServiceTest {

    @TempDir
    Path dir;

    private SessionsFixture f;

    @BeforeEach
    void setUp() {
        f = new SessionsFixture(dir);
    }

    @Test
    void aHelperKeyIsShownOnceAndKeptOnlyAsAHash() {
        Issued i = f.keys.registerHelper("me@x.ae", "WORK-PC", "me@x.ae", "10.0.0.1");

        assertThat(f.keys.authenticate(i.key())).get().extracting(Caller::user, Caller::kind).containsExactly("me@x.ae", Caller.Kind.HELPER);
        assertThat(f.store.keyHash(i.keyId()).orElseThrow().hash()).isNotEqualTo(i.key()).hasSize(64);
        assertThat(f.keys.authenticate(i.key() + "x")).isEmpty();
        assertThat(f.keys.authenticate("nonsense")).isEmpty();
        assertThat(f.keys.authenticate(null)).isEmpty();
    }

    @Test
    void aHelperRegistersWithAnEmailAndAMachine() {
        assertThatThrownBy(() -> f.keys.registerHelper("not-an-email", "PC", "", "")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> f.keys.registerHelper("me@x.ae", " ", "", "")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void reinstallingOnTheSamePcRevokesTheOldKeyAndKeepsItsBrowsers() {
        Issued first = f.keys.registerHelper("me@x.ae", "WORK-PC", "", "");
        Caller browser = f.browser(f.keys.authenticate(first.key()).orElseThrow());

        Issued second = f.keys.registerHelper("me@x.ae", "WORK-PC", "", "");

        assertThat(f.keys.authenticate(first.key())).isEmpty();
        assertThat(f.keys.authenticate(second.key())).isPresent();
        assertThat(f.store.browser(browser.keyId()).orElseThrow().revokedAt()).isNull();
        assertThat(f.keys.authenticate(f.browserKeys.get(browser.keyId())).orElseThrow().helperKeyId()).isEqualTo(second.keyId());
    }

    @Test
    void aPairedBrowserWritesAsTheHelpersUser() {
        Caller helper = f.helper("me@x.ae", "WORK-PC");
        Caller browser = f.browser(helper);

        assertThat(browser.user()).isEqualTo("me@x.ae");
        assertThat(browser.kind()).isEqualTo(Caller.Kind.BROWSER);
        assertThat(browser.helperKeyId()).isEqualTo(helper.keyId());
    }

    @Test
    void aCodeWorksOnceAndExpiresAfterTwoMinutes() {
        Caller helper = f.helper("me@x.ae", "WORK-PC");
        String code = f.keys.pairCode(helper).code();
        assertThat(f.keys.pairBrowser(code, "a")).isPresent();
        assertThat(f.keys.pairBrowser(code, "b")).isEmpty();

        String late = f.keys.pairCode(helper).code();
        f.clock.plusMinutes(3);
        assertThat(f.keys.pairBrowser(late, "c")).isEmpty();
    }

    @Test
    void wrongCodesBurnTheOpenCodeSoSixDigitsCannotBeWalked() {
        Caller helper = f.helper("me@x.ae", "WORK-PC");
        String code = f.keys.pairCode(helper).code();
        String wrong = code.equals("000000") ? "000001" : "000000";
        for (int i = 0; i < KeysService.CODE_TRIES; i++) {
            f.keys.pairBrowser(wrong, "x");
        }
        assertThat(f.keys.pairBrowser(code, "x")).isEmpty();
    }

    @Test
    void onlyHelpersMakeCodes() {
        Caller browser = f.browser(f.helper("me@x.ae", "WORK-PC"));
        assertThatThrownBy(() -> f.keys.pairCode(browser)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aUserRevokesOnlyTheirOwnKeys() {
        Caller me = f.helper("me@x.ae", "WORK-PC");
        Caller other = f.helper("o@x.ae", "PC2");
        Caller myBrowser = f.browser(me);

        assertThat(f.keys.revokeOwn(other, myBrowser.keyId())).isFalse();
        assertThat(f.keys.revokeOwn(me, myBrowser.keyId())).isTrue();
        assertThat(f.store.keyHash(myBrowser.keyId())).isEmpty();
    }

    @Test
    void theAdminSeesUsersAndPcsButNoSettings() {
        Caller me = f.helper("me@x.ae", "WORK-PC");
        f.helper("me@x.ae", "LAPTOP-2");
        f.browser(me);
        f.settings.put(me, "{\"projects\":[]}");

        assertThat(f.keys.users()).singleElement().satisfies(u -> {
            assertThat(u.user()).isEqualTo("me@x.ae");
            assertThat(u.machines()).containsExactly("LAPTOP-2", "WORK-PC");
            assertThat(u.browsers()).isEqualTo(1);
        });
    }

    @Test
    void keysParseOnlyInTheirOwnShape() {
        assertThat(Keys.parse("ak_0123456789abcdef.secret")).isPresent();
        assertThat(Keys.parse("ak_XYZ.secret")).isEmpty();
        assertThat(Keys.parse("0123456789abcdef.secret")).isEmpty();
        assertThat(Keys.parse("ak_0123456789abcdef.")).isEmpty();
    }

    @Test
    void aConnectFilePairsTheBrowserThatDownloadedItOnce() {
        KeysService.ConnectStart start = f.keys.connectStart("Chrome on WORK-PC");
        assertThat(f.keys.collect(start.connectId(), start.collectSecret())).isEmpty(); // the PC has not run it yet

        Issued helper = f.keys.registerHelper("Me@X.ae", "WORK-PC", "me@x.ae", "10.0.0.1", start.token());

        assertThat(f.events).contains("connect:null");
        assertThat(f.keys.collect(start.connectId(), "wrong")).isEmpty();
        Issued browser = f.keys.collect(start.connectId(), start.collectSecret()).orElseThrow();
        assertThat(f.keys.authenticate(browser.key())).get().extracting(Caller::user, Caller::kind, Caller::helperKeyId)
                .containsExactly("me@x.ae", Caller.Kind.BROWSER, helper.keyId());
        assertThat(f.keys.collect(start.connectId(), start.collectSecret())).isEmpty(); // collected once
        assertThatThrownBy(() -> f.keys.registerHelper("me@x.ae", "WORK-PC", "", "", start.token()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("used or has expired");
    }

    @Test
    void aConnectFileExpiresAfterHalfAnHour() {
        KeysService.ConnectStart start = f.keys.connectStart("Chrome");
        f.clock.plusMinutes(KeysService.CONNECT_LIFE.toMinutes() + 1);

        assertThatThrownBy(() -> f.keys.registerHelper("me@x.ae", "WORK-PC", "", "", start.token())).isInstanceOf(IllegalArgumentException.class);
        assertThat(f.keys.collect(start.connectId(), start.collectSecret())).isEmpty();
    }
}
