package com.fathy.alfred.backend.dbcapture.domain;

import com.esotericsoftware.kryo.Kryo;
import com.esotericsoftware.kryo.io.Output;
import com.fathy.alfred.backend.dbcapture.domain.model.DecodedValue;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.Deflater;
import java.util.zip.GZIPOutputStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Values decoded for display without creating objects (specs/011-redis-capture T054-T057): fixtures are written at test
 * time by the real JDK serializer, gzip, Snappy (literals) and Kryo, and read back as text.
 */
class StoreValueDecoderTest {

    /** A class only the test knows - the decoder must name it without being able to load it. */
    static final class FareRule implements Serializable {
        private static final long serialVersionUID = 1L;
        String carrier = "EK";
        double markupPct = 1.5;
        List<String> dealCodes = new ArrayList<>(List.of("EKDEAL1"));
        LocalDate validTo = LocalDate.of(2026, 12, 31);
        BigDecimal fee = new BigDecimal("12.50");
        Map<String, Integer> limits = new LinkedHashMap<>(Map.of("adults", 9));
        transient String cachedKey = "never stored";
        UserRef approvedBy = new UserRef();
    }

    static final class UserRef implements Serializable {
        private static final long serialVersionUID = 1L;
        int id = 790;
        String name = "f.ops";
    }

    static final class Custom implements Serializable {
        private static final long serialVersionUID = 1L;
        int a = 1;

        private void writeObject(java.io.ObjectOutputStream out) throws java.io.IOException {
            out.defaultWriteObject();
            out.writeUTF("own data");
        }
    }

    static byte[] jdk(Object o) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
            out.writeObject(o);
        }
        return bytes.toByteArray();
    }

    @Test
    void jdkSerializationIsReadAsAStructureWithItsClassAndFields() throws Exception {
        DecodedValue d = StoreValueDecoder.decode(jdk(new FareRule()));
        assertThat(d.format()).isEqualTo("JDK serialization · " + FareRule.class.getName());
        assertThat(d.className()).isEqualTo(FareRule.class.getName());
        assertThat(d.text()).contains("carrier: \"EK\"").contains("markupPct: 1.5").contains("java.util.ArrayList [\"EKDEAL1\"]")
                .contains("validTo: java.time 2026-12-31").contains("fee: 12.50").contains("\"adults\" → 9")
                .contains(UserRef.class.getName() + " {").contains("id: 790").contains("name: \"f.ops\"")
                .doesNotContain("never stored");
        assertThat(d.partial()).isFalse();
    }

    @Test
    void ownWriteObjectDataIsShownAsBytesAndMarksPartial() throws Exception {
        DecodedValue d = StoreValueDecoder.decode(jdk(new Custom()));
        assertThat(d.text()).contains("a: 1").contains("(writeObject)");
        assertThat(d.partial()).isTrue();
    }

    @Test
    void backReferencesAndCollections() throws Exception {
        UserRef same = new UserRef();
        HashMap<String, Object> m = new HashMap<>();
        m.put("x", same);
        m.put("y", same);
        DecodedValue d = StoreValueDecoder.decode(jdk(m));
        assertThat(d.text()).contains("\"x\" →").contains("\"y\" →");
    }

    @Test
    void gzipJsonIsUnpackedAndSpringClassHintsNamed() throws Exception {
        String json = "{\"@class\":\"com.tt.ts.upsell.UpsellResult\",\"searchId\":\"a5b4f2f0\",\"offers\":[1,2]}";
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(bytes)) {
            gz.write(json.getBytes(StandardCharsets.UTF_8));
        }
        DecodedValue d = StoreValueDecoder.decode(bytes.toByteArray());
        assertThat(d.format()).startsWith("Jackson JSON · com.tt.ts.upsell.UpsellResult + gzip · ");
        assertThat(d.format()).contains("sent").contains("unpacked");
        assertThat(d.text()).contains("\"searchId\" : \"a5b4f2f0\"");
    }

    @Test
    void aZipBombIsNotUnpackedPastTheLimitAndStaysRaw() throws Exception {
        Deflater deflater = new Deflater(9);
        byte[] zeros = new byte[1024 * 1024];
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(bytes)) {
            for (int i = 0; i < 70; i++) {
                gz.write(zeros);
            }
        }
        deflater.end();
        DecodedValue d = StoreValueDecoder.decode(bytes.toByteArray());
        assertThat(d.format()).contains("too large to unpack for display");
        assertThat(d.bytes()).isEqualTo(bytes.size());
    }

    @Test
    void snappyFramedAndRawAreUnpacked() throws Exception {
        byte[] text = "{\"a\":1,\"b\":\"hello hello hello\"}".getBytes(StandardCharsets.UTF_8);
        byte[] raw = SnappyDecoder.literalOnly(text);
        assertThat(SnappyDecoder.decodeRaw(raw, 1000)).isEqualTo(text);
        ByteArrayOutputStream framed = new ByteArrayOutputStream();
        framed.write(new byte[]{(byte) 0xff, 0x06, 0x00, 0x00, 's', 'N', 'a', 'P', 'p', 'Y'});
        int len = raw.length + 4;
        framed.write(new byte[]{0x00, (byte) len, (byte) (len >> 8), (byte) (len >> 16), 0, 0, 0, 0});
        framed.write(raw);
        DecodedValue d = StoreValueDecoder.decode(framed.toByteArray());
        assertThat(d.format()).startsWith("JSON + Snappy");
        assertThat(d.text()).contains("hello hello hello");
    }

    @Test
    void kryoValuesShowTheirValuesUnnamedWhenRegistered() {
        Kryo kryo = new Kryo();
        kryo.register(Session.class, 23);
        Output out = new Output(256, -1);
        kryo.writeClassAndObject(out, new Session());
        DecodedValue d = StoreValueDecoder.decode(out.toBytes());
        assertThat(d.format()).startsWith("Kryo");
        assertThat(d.text()).contains("class #23").contains("\"f.ops\"");
        assertThat(d.partial()).isTrue();
    }

    public static final class Session {
        public String login = "f.ops";
        public int orgId = 948;
    }

    @Test
    void textAndUnknownBytes() {
        assertThat(StoreValueDecoder.decode("plain words".getBytes(StandardCharsets.UTF_8)).format()).isEqualTo("text");
        DecodedValue raw = StoreValueDecoder.decode(new byte[]{(byte) 0x90, 0x00, (byte) 0xfe});
        assertThat(raw.format()).isEqualTo("raw");
        assertThat(raw.text()).isEqualTo("90 00 fe");
    }

    @Test
    void repliesAreDecodedElementByElement() {
        DecodedValue map = StoreValueDecoder.decodeReply("*4\r\n$8\r\ncurrency\r\n$3\r\nAED\r\n$8\r\nlanguage\r\n$2\r\nen\r\n".getBytes(StandardCharsets.UTF_8));
        assertThat(map.text()).isEqualTo("currency\nAED\nlanguage\nen");
        DecodedValue resp3 = StoreValueDecoder.decodeReply("%1\r\n$8\r\ncurrency\r\n$3\r\nAED\r\n".getBytes(StandardCharsets.UTF_8));
        assertThat(resp3.text()).isEqualTo("currency → AED");
        assertThat(StoreValueDecoder.decodeReply("$-1\r\n".getBytes(StandardCharsets.UTF_8)).text()).isEqualTo("(nil)");
    }
}
