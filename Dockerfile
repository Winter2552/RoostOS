FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HTTPS_PORT=8443 \
    DATA_DIR=/data

# WireGuard tools, for the private link to the Coffee Galaxy server (Admin → Coffee Galaxy)
# and for Away from home (Admin → Network), which also needs iptables to pass traffic on to the home network.
RUN apk add --no-cache wireguard-tools iptables

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

EXPOSE 8080 8443 51821/udp
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/state >/dev/null || exit 1

# Brings the Coffee Galaxy link and Away from home back up after a restart, when they have been set up.
CMD ["sh", "-c", "[ -f /data/wireguard/wg0.conf ] && wg-quick up /data/wireguard/wg0.conf; [ -f /data/wireguard/wg1.conf ] && wg-quick up /data/wireguard/wg1.conf; exec node src/server.js"]
