# Sonara: self-hosted music player.
#   docker build -t sonara .
#   docker run -d -p 7700:7700 -v sonara-data:/data -v /path/to/music:/music:ro sonara
FROM node:22-alpine

# ffmpeg: transcoding, cue sheets, tag editing, conversions. yt-dlp: Inbox downloads.
# mpv: jukebox mode (playing through the host's speakers; needs the sound device passed in).
ARG WITH_YTDLP=1
ARG WITH_MPV=0
RUN apk add --no-cache ffmpeg tini \
  && if [ "$WITH_YTDLP" = "1" ]; then apk add --no-cache yt-dlp; fi \
  && if [ "$WITH_MPV" = "1" ]; then apk add --no-cache mpv; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts/backup.js ./scripts/backup.js

ENV NODE_ENV=production \
    SONARA_DATA_DIR=/data \
    SONARA_MUSIC_DIRS=/music \
    SONARA_PORT=7700 \
    SONARA_HOST=0.0.0.0 \
    SONARA_LOG_FORMAT=text

RUN mkdir -p /data /music && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SONARA_PORT||7700)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
