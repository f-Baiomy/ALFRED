// Checked-in placeholder for local `ng serve` (no Docker/nginx involved) - left empty so
// AppConfigService's window.location-based fallback in app-config.service.ts applies unchanged.
// In the Docker image, docker-entrypoint.d/10-generate-env.sh overwrites this file at container
// start with the real BACKEND_PORT for that deployment (see docker-compose.yml).
