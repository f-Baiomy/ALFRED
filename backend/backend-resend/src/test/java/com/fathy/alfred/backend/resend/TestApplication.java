package com.fathy.alfred.backend.resend;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The real @SpringBootApplication lives in backend-app, a module this one deliberately doesn't
 * depend on (see backend-interception's identical TestApplication for why). @WebMvcTest needs a
 * @SpringBootConfiguration discoverable within its own module's classpath to know what package to
 * component-scan for controllers.
 */
@SpringBootApplication
class TestApplication {
}
