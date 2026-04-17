FROM alpine:3.20

RUN apk add --no-cache dnsmasq bash curl iproute2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
