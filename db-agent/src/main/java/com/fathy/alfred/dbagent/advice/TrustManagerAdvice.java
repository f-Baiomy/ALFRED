package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.TrustBridge;
import net.bytebuddy.asm.Advice;

import java.security.cert.CertificateException;

/**
 * On {@code sun.security.ssl.X509TrustManagerImpl.checkServerTrusted}: when the JDK refuses a server chain, and the
 * chain is one Alfred's forward proxy issued (it verifies against Alfred's CA), the refusal is dropped. Any other
 * chain is refused exactly as before. With the feature off, {@link TrustBridge#acceptor} is null and nothing changes.
 * This is what lets an app that was not started with Alfred's CA in its trust store be proxied without a restart
 * (research R12).
 */
public final class TrustManagerAdvice {

    private TrustManagerAdvice() {
    }

    @Advice.OnMethodExit(onThrowable = CertificateException.class, suppress = Throwable.class)
    public static void exit(@Advice.Argument(0) Object chain, @Advice.Thrown(readOnly = false) Throwable thrown) {
        if (thrown instanceof CertificateException && TrustBridge.accepts(chain)) {
            thrown = null;
        }
    }
}
