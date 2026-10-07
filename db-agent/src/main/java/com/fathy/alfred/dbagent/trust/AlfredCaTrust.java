package com.fathy.alfred.dbagent.trust;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.function.Predicate;

/**
 * Accepts a server certificate chain only when it was issued by Alfred's CA (the forward proxy's, read from
 * {@code caFile}): some certificate of the chain is signed by the CA, every certificate before it is signed by the
 * next one, and all of them are within their validity dates. Anything else is refused.
 */
public final class AlfredCaTrust implements Predicate<Object> {

    private final X509Certificate ca;

    public AlfredCaTrust(X509Certificate ca) {
        this.ca = ca;
    }

    public static AlfredCaTrust fromFile(String file) throws IOException, GeneralSecurityException {
        try (InputStream in = Files.newInputStream(Paths.get(file))) {
            return new AlfredCaTrust((X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in));
        }
    }

    @Override
    public boolean test(Object chain) {
        if (!(chain instanceof X509Certificate[])) {
            return false;
        }
        X509Certificate[] certs = (X509Certificate[]) chain;
        if (certs.length == 0) {
            return false;
        }
        try {
            ca.checkValidity();
            for (int i = 0; i < certs.length; i++) {
                certs[i].checkValidity();
                if (signedByCa(certs[i])) {
                    return true;
                }
                if (i + 1 >= certs.length) {
                    return false;
                }
                certs[i].verify(certs[i + 1].getPublicKey());
            }
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
        return false;
    }

    private boolean signedByCa(X509Certificate cert) {
        if (!cert.getIssuerX500Principal().equals(ca.getSubjectX500Principal())) {
            return false;
        }
        try {
            cert.verify(ca.getPublicKey());
            return true;
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }
}
