#!/usr/bin/env bash
# Deploys the game to the VDS: builds the image here, copies it and the compose files to the
# server and restarts the game there.
#
#   scripts/deploy.sh                 build, upload, restart
#   scripts/deploy.sh --with-shadow   also upload the VDS secrets from shadow/vds/ (turn.env, auth.env, db.env) —
#                                     first deploy or after changing them
#
# Settings: shadow/deploy.env (git-ignored) with DEPLOY_HOST (user@ip) and DEPLOY_DIR (/srv/orbita, the default).
# The domain is TURN_HOST of shadow/vds/turn.env. The project layout is mirrored on the server:
# $DEPLOY_DIR/docker/... and $DEPLOY_DIR/shadow/, so docker-compose.yml paths stay valid.
# Compose runs there with docker/game/vds.env (ports 443 and 80, the "db" service).
# The first deploy also issues the certificate on the server and adds a cron job renewing it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$ROOT/shadow/deploy.env" ]] && source "$ROOT/shadow/deploy.env"
HOST="${DEPLOY_HOST:?set DEPLOY_HOST (user@ip) in shadow/deploy.env}"
DIR="${DEPLOY_DIR:-/srv/orbita}"
DOMAIN="$(sed -n 's/^TURN_HOST=//p' "$ROOT/shadow/vds/turn.env")"
[[ -n "$DOMAIN" ]] || { echo "no TURN_HOST in shadow/vds/turn.env" >&2; exit 1; }
IMAGE="vr-orbita-game"
COMPOSE="docker compose -f $DIR/docker/game/docker-compose.yml --env-file $DIR/docker/game/vds.env"
SECRETS=(turn.env auth.env db.env)

WITH_SHADOW=0
for arg in "$@"; do
    case "$arg" in
        --with-shadow) WITH_SHADOW=1 ;;
        -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 1 ;;
    esac
done

step() { echo -e "\n==> $*"; }

step "building $IMAGE"
docker compose -f "$ROOT/docker/game/docker-compose.yml" build web

step "uploading image to $HOST"
docker save "$IMAGE" | gzip | ssh "$HOST" 'gunzip | docker load'

step "uploading compose files to $HOST:$DIR"
ssh "$HOST" "mkdir -p '$DIR/shadow'"
tar -C "$ROOT" -czf - docker | ssh "$HOST" "rm -rf '$DIR/docker' && tar -C '$DIR' -xzf -"

if [[ $WITH_SHADOW == 1 ]]; then
    step "uploading secrets from shadow/vds/"
    tar -C "$ROOT/shadow/vds" -czf - "${SECRETS[@]}" \
        | ssh "$HOST" "tar -C '$DIR/shadow' -xzf - && chown 1000:1000 '$DIR/shadow' $(printf "'$DIR/shadow/%s' " "${SECRETS[@]}") && chmod 600 $(printf "'$DIR/shadow/%s' " "${SECRETS[@]}")"
fi
for name in "${SECRETS[@]}"; do
    ssh "$HOST" "test -f '$DIR/shadow/$name'" \
        || { echo "no $DIR/shadow/$name on the server: run with --with-shadow" >&2; exit 1; }
done

# The certificate is issued on the server itself (certbot standalone on :80, before nginx needs it).
# Renewal: a weekly cron job; certbot renews only when less than 30 days are left.
if ! ssh "$HOST" "test -f '$DIR/shadow/fullchain.pem'"; then
    step "issuing the certificate"
    ssh "$HOST" "$COMPOSE run --rm --service-ports certbot certonly --standalone -d '$DOMAIN' \
        --non-interactive --agree-tos --register-unsafely-without-email && $COMPOSE run --rm cert-copy"
fi
ssh "$HOST" "cat > /etc/cron.d/orbita-cert" <<EOF
# Renews the certificate of the game (scripts/deploy.sh); nginx and coturn restart to pick it up
30 4 * * 1 root $COMPOSE run --rm --service-ports certbot renew -q && $COMPOSE run --rm cert-copy >/dev/null && $COMPOSE restart nginx coturn >/dev/null
EOF

step "restarting the game"
# up recreates the containers whose image changed; nginx resolves upstreams only at start, so it restarts too
ssh "$HOST" "$COMPOSE up -d --no-build --remove-orphans && $COMPOSE restart nginx && docker image prune -f >/dev/null && $COMPOSE ps"
