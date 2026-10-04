package com.fathy.alfred.backend.dbcapture;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The real @SpringBootApplication lives in backend-app, which this module must not depend on;
 * @WebMvcTest needs one discoverable in this module (same as backend-logs' TestApplication).
 */
@SpringBootApplication
class TestApplication {
}
