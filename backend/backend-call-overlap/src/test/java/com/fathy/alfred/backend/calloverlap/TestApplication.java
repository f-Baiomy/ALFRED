package com.fathy.alfred.backend.calloverlap;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The real @SpringBootApplication lives in backend-app, a module this one deliberately doesn't
 * depend on - see backend-calls' own TestApplication for why @WebMvcTest needs this.
 */
@SpringBootApplication
class TestApplication {
}
