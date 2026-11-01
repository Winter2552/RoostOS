FROM alpine:3.20
RUN apk add --no-cache iproute2
COPY shim.sh /shim.sh
CMD ["sh", "/shim.sh"]
