# Build stage
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Runtime stage
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

RUN mkdir -p /app/data/models && chown -R appuser:appuser /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/spacefolding.db
ENV MODEL_PATH=/app/data/models

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node dist/main.js health || exit 1

USER appuser

ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]
