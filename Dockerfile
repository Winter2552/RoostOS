FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HTTPS_PORT=8443 \
    DATA_DIR=/data

# WireGuard tools, for the private link to the Coffee Galaxy server (Admin → Coffee Galaxy).
RUN apk add --no-cache wireguard-tools

# Viewing HEIC photos and MKV, AVI, 3GP... videos in browsers that can't play them
# (src/convert.js): copies are made on first view; originals are never touched.
RUN apk add --no-cache ffmpeg libheif-tools

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY releases ./releases

# Runs as root so it can write to a bind-mounted /data that ZimaOS creates as root.
RUN mkdir -p /data

EXPOSE 8080 8443
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/state >/dev/null || exit 1

# Brings the Coffee Galaxy link back up after a restart, when one has been set up.
CMD ["sh", "-c", "[ -f /data/wireguard/wg0.conf ] && wg-quick up /data/wireguard/wg0.conf; exec node src/server.js"]
