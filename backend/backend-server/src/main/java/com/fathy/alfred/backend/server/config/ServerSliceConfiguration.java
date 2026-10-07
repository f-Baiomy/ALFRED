package com.fathy.alfred.backend.server.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.adapter.out.envfile.EnvFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.envfile.SettingsPropertiesDefaultsAdapter;
import com.fathy.alfred.backend.server.adapter.out.history.EnvHistoryFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.history.PendingRestartFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.probe.MachineAdapter;
import com.fathy.alfred.backend.server.adapter.out.runtime.JvmRuntimeInfoAdapter;
import com.fathy.alfred.backend.server.adapter.out.runtime.NetworkInterfacesAdapter;
import com.fathy.alfred.backend.server.adapter.out.runtime.ProcessEnvDockerSettingsAdapter;
import com.fathy.alfred.backend.server.adapter.out.supervisor.SupervisorControlAdapter;
import com.fathy.alfred.backend.server.adapter.out.websocket.ServerEventsWebSocketHandler;
import com.fathy.alfred.backend.server.adapter.out.websocket.WebSocketServerEventsAdapter;
import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.application.port.out.HistoryPort;
import com.fathy.alfred.backend.server.application.port.out.LiveSettingsPort;
import com.fathy.alfred.backend.server.application.port.out.PendingRestartPort;
import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;
import com.fathy.alfred.backend.server.application.port.out.StorageStatsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.application.service.EditAccessService;
import com.fathy.alfred.backend.server.application.service.MachineProbes;
import com.fathy.alfred.backend.server.application.service.ServerRuntimeService;
import com.fathy.alfred.backend.server.application.service.ServerSettingsService;
import com.fathy.alfred.backend.server.application.service.SettingsProbes;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import java.nio.file.Path;
import java.time.Clock;

/**
 * Wires the server slice. The domain and application classes carry no Spring annotations (ServerConfigCli builds them
 * without a context), so they are declared here. Paths come from the supervisor (packaging/launcher/supervisor.py);
 * in Docker they do not exist, the mode is DOCKER, and every write is refused (FR-054).
 */
@Configuration
@EnableWebSocket
public class ServerSliceConfiguration implements WebSocketConfigurer {

    private final ServerEventsWebSocketHandler eventsHandler = new ServerEventsWebSocketHandler();

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    @Bean
    public RuntimeMode serverRuntimeMode(@Value("${ALFRED_RUNTIME:docker}") String runtime) {
        return RuntimeMode.of(runtime);
    }

    @Bean
    public EnvFilePort serverEnvFile(@Value("${ALFRED_ENV_FILE:.env}") String file, RuntimeMode mode) {
        EnvFileAdapter adapter = new EnvFileAdapter(Path.of(file));
        if (mode == RuntimeMode.NATIVE) {
            adapter.checkWritable();
        }
        return adapter;
    }

    @Bean
    public DefaultsPort serverDefaults(@Value("${ALFRED_SETTINGS_DEFAULTS_FILE:settings.properties}") String file) {
        return new SettingsPropertiesDefaultsAdapter(Path.of(file));
    }

    @Bean
    public HistoryPort serverHistory(@Value("${ALFRED_DATA_DIR:data}") String dataDir, ObjectMapper mapper) {
        return new EnvHistoryFileAdapter(Path.of(dataDir), mapper, Clock.systemUTC());
    }

    @Bean
    public PendingRestartPort serverPendingRestart(@Value("${ALFRED_DATA_DIR:data}") String dataDir, ObjectMapper mapper) {
        return new PendingRestartFileAdapter(Path.of(dataDir), mapper);
    }

    @Bean
    public SupervisorPort serverSupervisor(@Value("${ALFRED_CONTROL_FILE:data/run/control.json}") String controlFile,
                                           RuntimeMode mode, ObjectMapper mapper) {
        return new SupervisorControlAdapter(Path.of(controlFile), mode, mapper);
    }

    @Bean
    public ServerEventsPort serverEvents() {
        return new WebSocketServerEventsAdapter(eventsHandler);
    }

    @Bean
    public ServerSettingsService serverSettingsService(EnvFilePort envFile, DefaultsPort defaults, HistoryPort history,
                                                       PendingRestartPort pending, LiveSettingsPort live,
                                                       SupervisorPort supervisor, ServerEventsPort events,
                                                       RuntimeMode mode, ObjectMapper mapper, SettingsProbes probes) {
        return new ServerSettingsService(envFile, defaults, history, pending, live, supervisor,
                new ProcessEnvDockerSettingsAdapter(mapper), events, mode, Clock.systemUTC(), probes::check);
    }

    @Bean
    public ServerRuntimeService serverRuntimeService(SupervisorPort supervisor, PendingRestartPort pending, HistoryPort history,
                                                     EnvFilePort envFile, ServerEventsPort events, RuntimeMode mode,
                                                     ServerSettingsService settings,
                                                     @Value("${ALFRED_VERSION:}") String version,
                                                     @Value("${ALFRED_HOME:}") String home) {
        return new ServerRuntimeService(supervisor, new JvmRuntimeInfoAdapter(version, home), pending, history, envFile,
                events, mode, settings.saveLock());
    }

    @Bean
    public SettingsProbes serverSettingsProbes(StorageStatsPort storage, EnvFilePort envFile, DefaultsPort defaults,
                                               @Value("${ALFRED_DATA_DIR:data}") String dataDir,
                                               @Value("${ALFRED_HOME:.}") String home,
                                               @Value("${server.port:3000}") int serverPort) {
        return new MachineProbes(new MachineAdapter(Path.of(dataDir)), storage,
                () -> runningSettings(defaults.defaults(), envFile.read().entries(), serverPort), Path.of(home));
    }

    /**
     * The settings the running processes use now - a port they hold is "in use by Alfred itself", not by another
     * process. That is what .env says (the proxies restart on every save, so .env and the running proxies agree),
     * except the UI port: it changes only at a restart, so until then .env and the running backend differ - and
     * setting it BACK to the running port was refused as "in use by java.exe (pid ...)", Alfred's own backend.
     */
    static java.util.Map<String, String> runningSettings(java.util.Map<String, String> defaults,
                                                         java.util.Map<String, String> env, int serverPort) {
        java.util.Map<String, String> effective = new java.util.LinkedHashMap<>(defaults);
        effective.putAll(env);
        effective.put("ALFRED_UI_PORT", String.valueOf(serverPort));
        return effective;
    }

    @Bean
    public EditAccessService serverEditAccess(EnvFilePort envFile, DefaultsPort defaults, RuntimeMode mode) {
        return new EditAccessService(envFile, defaults, new NetworkInterfacesAdapter(), mode);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(eventsHandler, "/ws/server").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
