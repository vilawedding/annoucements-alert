#!/bin/sh
# Opens one SOCKS5 tunnel per host in UPBIT_SSH_TUNNELS (comma separated user@host[:port]).
# Tunnel i listens on 0.0.0.0:(SSH_TUNNEL_BASE_PORT + i) inside the compose network;
# the bot builds the matching socks5h:// proxy list from the same variable.
# autossh restarts a tunnel whenever its SSH session dies.
set -eu

BASE_PORT="${SSH_TUNNEL_BASE_PORT:-1081}"
KEY_SRC="${SSH_KEY_PATH:-/ssh/id_key}"

if [ -z "${UPBIT_SSH_TUNNELS:-}" ]; then
    echo "[tunnels] UPBIT_SSH_TUNNELS is empty - no tunnels to open, idling"
    while :; do sleep 3600; done
fi

if [ ! -f "$KEY_SRC" ]; then
    echo "[tunnels] SSH key not found at $KEY_SRC (mount it, see docker-compose.yml)" >&2
    exit 1
fi

# Bind-mounted keys often have loose permissions; ssh refuses those.
cp "$KEY_SRC" /tmp/id_key
chmod 600 /tmp/id_key
mkdir -p /known_hosts

# Retry even if the very first connection fails (VM still booting, network down, ...).
export AUTOSSH_GATETIME=0

i=0
for target in $(echo "$UPBIT_SSH_TUNNELS" | tr ',' ' '); do
    port=$((BASE_PORT + i))
    host="${target%:*}"
    ssh_port=22
    if [ "$host" != "$target" ]; then ssh_port="${target##*:}"; fi

    echo "[tunnels] $host (ssh port $ssh_port) -> socks5 :$port"
    autossh -M 0 -N \
        -D "0.0.0.0:$port" \
        -p "$ssh_port" \
        -i /tmp/id_key \
        -o ServerAliveInterval=15 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=accept-new \
        -o UserKnownHostsFile=/known_hosts/known_hosts \
        -o Compression=no \
        "$host" &

    i=$((i + 1))
done

wait
