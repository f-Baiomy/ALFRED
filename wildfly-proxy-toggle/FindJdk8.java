import java.io.File;

/**
 * FindJdk8 - locates a JDK 8 install (one with lib/tools.jar, needed for the Attach API),
 * independent of whatever JAVA_HOME currently points at for other purposes. Checks JDK8_HOME
 * first (an explicit override), then JAVA_HOME if it happens to already be JDK 8. Prints the
 * found path, or nothing if neither works - the caller is expected to then ask the user to set
 * JDK8_HOME explicitly, rather than this class silently guessing at other install locations.
 *
 * Deliberately has no dependency on anything beyond plain java.io - this runs as a bootstrap
 * step using WHATEVER java happens to be on PATH/JAVA_HOME (does not need to be JDK 8 itself),
 * before the real controller/agent build even starts.
 */
public class FindJdk8 {

    public static void main(String[] args) {
        File override = candidateOrNull(System.getenv("JDK8_HOME"));
        if (override != null) {
            System.out.println(override.getAbsolutePath());
            return;
        }

        File fromJavaHome = candidateOrNull(System.getenv("JAVA_HOME"));
        if (fromJavaHome != null) {
            System.out.println(fromJavaHome.getAbsolutePath());
        }
        // Neither worked - print nothing, deliberately. The caller asks the user to set
        // JDK8_HOME explicitly rather than this class guessing at other install locations.
    }

    private static File candidateOrNull(String path) {
        if (path == null || path.trim().isEmpty()) return null;
        File dir = new File(path.trim());
        return new File(dir, "lib/tools.jar").isFile() ? dir : null;
    }
}
