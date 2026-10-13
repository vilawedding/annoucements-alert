FROM node:20.18.1-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first (cached layer while only source changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Storage files (sent announcements) live here; mount a volume so they survive restarts.
# An empty storage makes Binance re-process its latest catalog items on startup.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3003}/" > /dev/null || exit 1

# Run node directly (not via npm) so SIGTERM from `docker stop` reaches the process
# and storage is flushed on shutdown.
CMD ["node", "--require", "./preload.js", "index-new.js"]
