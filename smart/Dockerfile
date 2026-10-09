# Roost's drive health helper: reads each drive's SMART data once an hour and
# leaves it in a shared folder for Roost to show. It has no network and no
# ports; the only thing it runs is smartctl.
FROM alpine:3.20

RUN apk add --no-cache smartmontools

COPY check.sh /check.sh

CMD ["/bin/sh", "/check.sh"]
