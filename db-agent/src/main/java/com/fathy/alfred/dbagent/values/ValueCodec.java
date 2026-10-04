package com.fathy.alfred.dbagent.values;

import com.fathy.alfred.dbagent.transport.Value;

import java.io.InputStream;
import java.io.Reader;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.JDBCType;
import java.sql.Ref;
import java.sql.RowId;
import java.sql.SQLXML;
import java.sql.Struct;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Turns a parameter or column value into its typed text form (research D8). Exact by design: decimals keep their
 * scale ({@code toPlainString}), timestamps keep their nanoseconds, bytes are base64. Vendor types are read by
 * REFLECTION - no driver is a compile-time dependency - for Oracle, PostgreSQL, MySQL/MariaDB and SQL Server; anything
 * unknown falls back to {@code toString()} marked opaque.
 *
 * <p>Streams and LOB objects are never consumed: reading them would steal the bytes from the driver (parameters) or
 * from the application (columns). They are recorded by kind and, where the object says so cheaply, by length.
 */
public final class ValueCodec {

    private static final Map<String, String> SETTER_TYPES = new HashMap<>();

    static {
        SETTER_TYPES.put("setString", "VARCHAR");
        SETTER_TYPES.put("setNString", "NVARCHAR");
        SETTER_TYPES.put("setInt", "INTEGER");
        SETTER_TYPES.put("setLong", "BIGINT");
        SETTER_TYPES.put("setShort", "SMALLINT");
        SETTER_TYPES.put("setByte", "TINYINT");
        SETTER_TYPES.put("setBoolean", "BOOLEAN");
        SETTER_TYPES.put("setDouble", "DOUBLE");
        SETTER_TYPES.put("setFloat", "REAL");
        SETTER_TYPES.put("setBigDecimal", "DECIMAL");
        SETTER_TYPES.put("setDate", "DATE");
        SETTER_TYPES.put("setTime", "TIME");
        SETTER_TYPES.put("setTimestamp", "TIMESTAMP");
        SETTER_TYPES.put("setBytes", "BINARY");
        SETTER_TYPES.put("setBlob", "BLOB");
        SETTER_TYPES.put("setClob", "CLOB");
        SETTER_TYPES.put("setNClob", "NCLOB");
        SETTER_TYPES.put("setBinaryStream", "BLOB");
        SETTER_TYPES.put("setAsciiStream", "CLOB");
        SETTER_TYPES.put("setCharacterStream", "CLOB");
        SETTER_TYPES.put("setNCharacterStream", "NCLOB");
        SETTER_TYPES.put("setUnicodeStream", "CLOB");
        SETTER_TYPES.put("setArray", "ARRAY");
        SETTER_TYPES.put("setRef", "REF");
        SETTER_TYPES.put("setRowId", "ROWID");
        SETTER_TYPES.put("setSQLXML", "SQLXML");
        SETTER_TYPES.put("setURL", "DATALINK");
    }

    private ValueCodec() {
    }

    /** A PreparedStatement/CallableStatement setter call: {@code args[0]} is the index or name, {@code args[1]} the value. */
    public static Value parameter(String setter, Object[] args) {
        if (setter.equals("setNull")) {
            return new Value(args.length > 1 && args[1] instanceof Integer ? jdbcName((Integer) args[1]) : "NULL", null, false, null, null);
        }
        Object value = args.length > 1 ? args[1] : null;
        String type = SETTER_TYPES.get(setter);
        if (setter.equals("setObject")) {
            type = args.length > 2 && args[2] instanceof Integer ? jdbcName((Integer) args[2]) : typeOf(value);
        }
        return encode(type == null ? typeOf(value) : type, value);
    }

    /** A column (or OUT parameter) value as a get* returned it; {@code columnType} from ResultSetMetaData when known. */
    public static Value column(String columnType, String getter, Object value) {
        String type = columnType != null ? columnType : typeOf(value);
        return encode(type, value);
    }

    static Value encode(String type, Object value) {
        if (value == null) {
            return new Value(type, null, false, null, null);
        }
        try {
            if (value instanceof String) {
                return Value.of(type, (String) value);
            }
            if (value instanceof BigDecimal) {
                return Value.of(type, ((BigDecimal) value).toPlainString());
            }
            if (value instanceof Number || value instanceof Boolean || value instanceof Character) {
                return Value.of(type, value.toString());
            }
            if (value instanceof java.sql.Timestamp || value instanceof java.sql.Date || value instanceof java.sql.Time) {
                return Value.of(type, value.toString());
            }
            if (value instanceof java.util.Date) {
                return Value.of(type, new java.sql.Timestamp(((java.util.Date) value).getTime()).toString());
            }
            if (value instanceof byte[]) {
                return Value.of(type, Base64.getEncoder().encodeToString((byte[]) value));
            }
            if (value instanceof java.time.temporal.TemporalAccessor || value instanceof java.util.UUID) {
                return Value.of(type, value.toString());
            }
            if (value instanceof InputStream || value instanceof Reader) {
                return new Value(type, "<stream - not read by the agent>", true, null, null);
            }
            if (value instanceof Blob) {
                return new Value(type, "<blob " + length((Blob) value) + " bytes>", true, null, null);
            }
            if (value instanceof Clob) {
                return new Value(type, "<clob " + length((Clob) value) + " chars>", true, null, null);
            }
            if (value instanceof SQLXML) {
                return new Value(type, "<sqlxml>", true, null, null);
            }
            if (value instanceof Array) {
                return Value.of(type, arrayText((Array) value));
            }
            if (value instanceof Struct) {
                return Value.of(type, Arrays.deepToString(((Struct) value).getAttributes()));
            }
            if (value instanceof RowId) {
                return Value.of(type, value.toString());
            }
            if (value instanceof Ref) {
                return Value.of(type, ((Ref) value).getBaseTypeName());
            }
            Value vendor = vendor(type, value);
            if (vendor != null) {
                return vendor;
            }
            return new Value(type, value.toString(), true, null, null);
        } catch (Throwable t) {
            return new Value(type, "<unreadable " + value.getClass().getName() + ">", true, null, null);
        }
    }

    /**
     * Vendor objects, by class name and reflection only:
     * PostgreSQL PGobject (json/jsonb/custom: getValue), PGInterval and MySQL/MariaDB/SQL Server types print correctly
     * through toString; Oracle's oracle.sql.* (TIMESTAMPTZ, NUMBER, ...) expose stringValue()/toJdbc().
     */
    private static Value vendor(String type, Object value) throws Exception {
        String cls = value.getClass().getName();
        if (cls.equals("org.postgresql.util.PGobject") || cls.startsWith("org.postgresql.")) {
            Method getValue = method(value, "getValue");
            Method getType = method(value, "getType");
            if (getValue != null) {
                Object pgType = getType == null ? null : getType.invoke(value);
                return Value.of(pgType != null ? String.valueOf(pgType) : type, String.valueOf(getValue.invoke(value)));
            }
        }
        if (cls.startsWith("oracle.sql.") || cls.startsWith("oracle.jdbc.")) {
            Method stringValue = method(value, "stringValue");
            if (stringValue != null) {
                return Value.of(type, String.valueOf(stringValue.invoke(value)));
            }
            Method toJdbc = method(value, "toJdbc");
            if (toJdbc != null) {
                Object jdbc = toJdbc.invoke(value);
                if (jdbc != null && jdbc != value) {
                    return encode(type, jdbc);
                }
            }
        }
        if (cls.startsWith("microsoft.sql.") || cls.startsWith("com.microsoft.sqlserver.") || cls.startsWith("com.mysql.")
                || cls.startsWith("org.mariadb.")) {
            return Value.of(type, value.toString());
        }
        return null;
    }

    private static Method method(Object target, String name) {
        try {
            Method m = target.getClass().getMethod(name);
            m.setAccessible(true);
            return m;
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    private static String arrayText(Array array) throws Exception {
        Object values = array.getArray();
        if (values instanceof Object[]) {
            return Arrays.deepToString((Object[]) values);
        }
        return String.valueOf(values);
    }

    private static long length(Blob blob) {
        try {
            return blob.length();
        } catch (Throwable t) {
            return -1;
        }
    }

    private static long length(Clob clob) {
        try {
            return clob.length();
        } catch (Throwable t) {
            return -1;
        }
    }

    static String jdbcName(int sqlType) {
        try {
            return JDBCType.valueOf(sqlType).getName();
        } catch (IllegalArgumentException e) {
            return "TYPE_" + sqlType;
        }
    }

    static String typeOf(Object value) {
        if (value == null) {
            return "NULL";
        }
        if (value instanceof String) {
            return "VARCHAR";
        }
        if (value instanceof Integer) {
            return "INTEGER";
        }
        if (value instanceof Long) {
            return "BIGINT";
        }
        if (value instanceof BigDecimal) {
            return "DECIMAL";
        }
        if (value instanceof Double) {
            return "DOUBLE";
        }
        if (value instanceof Float) {
            return "REAL";
        }
        if (value instanceof Boolean) {
            return "BOOLEAN";
        }
        if (value instanceof java.sql.Timestamp || value instanceof java.time.LocalDateTime) {
            return "TIMESTAMP";
        }
        if (value instanceof java.sql.Date || value instanceof java.time.LocalDate) {
            return "DATE";
        }
        if (value instanceof byte[]) {
            return "BINARY";
        }
        return value.getClass().getSimpleName();
    }
}
