FROM node:22-alpine

# yt-dlp butuh python3, ffmpeg dipakai untuk menggabungkan video+audio dan konversi mp3
RUN apk add --no-cache python3 py3-pip ffmpeg ca-certificates tini \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip yt-dlp

ENV PATH="/opt/venv/bin:$PATH" \
    NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/data

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
