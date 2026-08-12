package com.fathy.alfred.backend.settings;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The real @SpringBootApplication lives in backend-app, a module this one deliberately
 * doesn't depend on (that dependency would be backwards - the composition root depends on
 * slices, not the other way around). @WebMvcTest needs a @SpringBootConfiguration discoverable
 * within its own module's classpath to know what package to component-scan for controllers -
 * plain @SpringBootConfiguration alone doesn't imply scanning, hence @SpringBootApplication here
 * (the test slice trims away the parts of it - full autoconfiguration - that it doesn't want).
 */
@SpringBootApplication
class TestApplication {
}
