FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# ─── Final image ──────────────────────────────────────────────────────────────
FROM node:20-alpine

# Install utilities for chmod/chown features
RUN apk add --no-cache tini su-exec

WORKDIR /app

# Copy dependencies and app files
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# Create data and temp directories (writable by any UID for OpenShift)
RUN mkdir -p /data /tmp/pvcbrowser-uploads && \
    chmod -R 777 /data /tmp/pvcbrowser-uploads && \
    chmod -R 755 /app && \
    chmod -R 777 /app/public

# Expose port
EXPOSE 3000

# Use tini as init to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

# Labels
LABEL org.opencontainers.image.title="k8s-pvc-filebrowser" \
      org.opencontainers.image.description="Web-based file browser for Kubernetes PVC" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.licenses="MIT"
