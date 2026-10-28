ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    SCENE_DATA_DIR=/app/.data/sessions
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /app/.data/sessions \
    && chown -R node:node /app/.data
COPY --from=build /app/dist ./dist
COPY --from=build /app/public/vad ./public/vad
COPY --from=build /app/server ./server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/api/health', { signal: AbortSignal.timeout(4000) }); if (!response.ok) process.exit(1);"]
CMD ["node", "server/index.mjs"]
