package com.fathy.alfred.backend.relive.domain.fingerprint;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Expected hashes are {@code semantic_fingerprint_v1} in proxy/relive.py for the same fixtures.
 * A change here that is not also made in the proxy will attach the wrong child.
 */
class RequestFingerprintTest {

    private static final String EMPTY = "263ef87bfe8fa229807d3622eda26cf83251aa3bb4233802cb8861f5d4aa9378";
    private static final String JSON = "07c11a03c9cf136174674c140fe34b8b345c2db4f03d1449ac8238364e5354dc";
    private static final String UNICODE = "03a41715890ce86af9c85b74da95a3e21ca8b6802fead1a615b923208107deaf";
    private static final String PLUS_QUERY = "8d308e47563d9dfa45ce3dc228c12efc980aad4924c00f1f49b2261a1313a617";
    private static final String NUMBERS = "60bc665876f0d2b1601a094b01d0f3f0e597ce9f2d0fe96bda2563afee200d07";
    private static final String XML = "c7b81bf67626605dff1e1beb4adad353d1fc64dba0582e5913d79fc57b6d79ba";
    private static final String XML_NS = "3a6023bf60859f60879590756c76282ed03bee8ba18209abce5575b7858a1535";
    private static final String PLAIN = "d18f96a4b85055ede8fdf8a7cbfa8c8c5877fb7f950ae3d603dcedd2402124b3";

    @Test
    void emptyGetMatchesTheProxyHash() {
        assertThat(RequestFingerprint.of("GET", "https://api.supplier.com/search", Map.of(), ""))
                .isEqualTo(EMPTY);
        assertThat(RequestFingerprint.of("GET", "https://api.supplier.com/search", null, null))
                .isEqualTo(EMPTY);
    }

    @Test
    void jsonKeyOrderAndGeneratedHeadersDoNotChangeTheHash() {
        String pretty = "{\n  \"b\": 1,\n  \"a\": 2\n}";
        Map<String, String> recorded = Map.of(
                "Content-Type", "application/json",
                "Cookie", "session=abc",
                "X-Request-Id", "trace-1",
                "User-Agent", "JUnit",
                "Content-Length", "12",
                "Client-Id", "NDC-Core");
        assertThat(RequestFingerprint.canonicalBody(pretty)).isEqualTo("{\"a\":2,\"b\":1}");
        assertThat(RequestFingerprint.of("POST", "https://api.supplier.com/search?b=1&a=2", recorded, pretty))
                .isEqualTo(JSON);
        assertThat(RequestFingerprint.of("POST", "https://api.supplier.com/search?a=2&b=1",
                Map.of("Client-Id", "NDC-Core", "Content-Type", "application/json"),
                "{\"a\":2,\"b\":1}")).isEqualTo(JSON);
    }

    @Test
    void unicodeBodyAndDecodedQueryMatchTheProxy() {
        String body = "{\"city\":\"\u0627\u0644\u0642\u0627\u0647\u0631\u0629\",\"q\":\"a\\\"b\"}";
        assertThat(RequestFingerprint.of("POST", "https://api.supplier.com/search?city=New%20York",
                Map.of("Content-Type", "application/json"), body)).isEqualTo(UNICODE);
        assertThat(RequestFingerprint.endpoint("GET", "https://api.supplier.com/search?q=New+York"))
                .containsExactly("GET", "https", "api.supplier.com", "/search", "q=New York");
        assertThat(RequestFingerprint.of("GET", "https://api.supplier.com/search?q=New+York", Map.of(), ""))
                .isEqualTo(PLUS_QUERY);
        assertThat(RequestFingerprint.endpoint("POST", "https://API.Supplier.com.:8443/search"))
                .containsExactly("POST", "https", "api.supplier.com", "/search", "");
    }

    @Test
    void jsonNumbersUsePythonDumpFormat() {
        String body = "{\"ok\":true,\"v\":null,\"n\":1.0,\"m\":1,\"z\":1.5,\"e\":1e-7,\"big\":1e21,\"xs\":[1,2]}";
        assertThat(RequestFingerprint.canonicalBody(body))
                .isEqualTo("{\"big\":1e+21,\"e\":1e-07,\"m\":1,\"n\":1.0,\"ok\":true,\"v\":null,\"xs\":[1,2],\"z\":1.5}");
        assertThat(RequestFingerprint.of("POST", "https://ndc.example/api/FlightSearch/Search",
                Map.of("Content-Type", "application/json"), body)).isEqualTo(NUMBERS);
    }

    @Test
    void xmlWhitespaceAndNamespacesMatchTheProxy() {
        String compact = "<Env xmlns:s=\"urn:soap\"><Body id=\"1\" n=\"2\"><Search>DXB</Search></Body></Env>";
        String pretty = "<Env xmlns:s=\"urn:soap\"><Body id=\"1\" n=\"2\">\n  <Search>DXB</Search>\n</Body></Env>";
        assertThat(RequestFingerprint.canonicalBody(compact))
                .isEqualTo("<Env><Body id=\"1\" n=\"2\"><Search>DXB</Search></Body></Env>");
        assertThat(RequestFingerprint.canonicalBody(pretty)).isEqualTo(RequestFingerprint.canonicalBody(compact));
        assertThat(RequestFingerprint.of("POST", "https://ndc.example/api/FlightSearch/Search",
                Map.of("Content-Type", "text/xml", "SOAPAction", "search"), pretty)).isEqualTo(XML);

        String namespaced = "<s:Envelope xmlns:s=\"urn:soap\"><s:Body n=\"2\" id=\"1\"><Search>DXB</Search></s:Body></s:Envelope>";
        assertThat(RequestFingerprint.canonicalBody(namespaced)).isEqualTo(
                "<{urn:soap}Envelope><{urn:soap}Body id=\"1\" n=\"2\"><Search>DXB</Search></{urn:soap}Body></{urn:soap}Envelope>");
        assertThat(RequestFingerprint.of("POST", "https://ndc.example/api/FlightSearch/Search",
                Map.of("Content-Type", "text/xml"), namespaced)).isEqualTo(XML_NS);
    }

    @Test
    void plainTextNormalizesNewlines() {
        assertThat(RequestFingerprint.canonicalBody("hello\r\nworld")).isEqualTo("hello\nworld");
        assertThat(RequestFingerprint.of("POST", "https://api.supplier.com/note", Map.of(), "hello\r\nworld"))
                .isEqualTo(PLAIN);
    }
}
