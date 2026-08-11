FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build -- --configuration production

FROM nginx:alpine

COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# The base image's own entrypoint runs every executable script under /docker-entrypoint.d/ before
# starting nginx - this one (re)generates env.js from BACKEND_PORT at container start, so a
# deployment whose default backend port is already taken by something else just needs a .env
# file, no image rebuild.
COPY docker-entrypoint.d/10-generate-env.sh /docker-entrypoint.d/10-generate-env.sh
# Strip any \r regardless of the checkout's line endings - a CRLF shebang ("#!/bin/sh\r") makes
# the kernel look for a nonexistent "/bin/sh\r" interpreter and this script silently fails to run
# (confirmed live on a Windows checkout where core.autocrlf re-introduced CRLF at build time).
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-generate-env.sh && chmod +x /docker-entrypoint.d/10-generate-env.sh

EXPOSE 80
