# Roost's updater: git (to fetch Roost's code from GitHub) and the Docker
# command line (to rebuild and restart Roost). It has no web port; it only
# reads requests from a small file in Roost's data folder.
FROM node:22-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose
WORKDIR /app
COPY update-service.js ./
CMD ["node", "update-service.js"]
