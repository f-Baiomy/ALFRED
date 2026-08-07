package com.alfred.pennyworth.calls;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The real @SpringBootApplication lives in pennyworth-app, a module this one deliberately
 * doesn't depend on. @WebMvcTest needs a @SpringBootConfiguration discoverable within its own
 * module's classpath to know what package to component-scan for controllers - plain
 * @SpringBootConfiguration alone doesn't imply scanning, hence @SpringBootApplication here (the
 * test slice trims away the parts of it - full autoconfiguration - that it doesn't want).
 */
@SpringBootApplication
class TestApplication {
}
