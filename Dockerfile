# syntax=docker/dockerfile:1
FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
RUN apk add --no-cache \
    bash curl iproute2 iptables ip6tables libqrencode-tools tini \
    'ca-certificates>=20261020-r0' 'ca-certificates-bundle>=20261020-r0' \
    wireguard-tools && \
    update-ca-certificates && \
    mkdir -p /config /app && \
    rm -rf /etc/wireguard && ln -s /config/wg_confs /etc/wireguard
COPY wireguard /usr/local/lib/wireguard
RUN chmod +x /usr/local/lib/wireguard/*.sh /usr/local/lib/wireguard/show-peer && \
    ln -s /usr/local/lib/wireguard/show-peer /app/show-peer
RUN --mount=type=bind,source=tests/configuration.sh,target=/tmp/configuration-test.sh bash /tmp/configuration-test.sh
EXPOSE 51820/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/usr/local/lib/wireguard/healthcheck.sh"]
ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/lib/wireguard/start.sh"]
