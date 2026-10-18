#!/usr/bin/env bash
#
# The remote story, rehearsed from nothing: fresh Debian 12 boxes in docker as
# "the VPSes", this machine as "the Mac", and the tarball a release would
# publish installed on all of them. What CI can hold of the same story is
# `packages/app/test/wire/rehearsal.test.ts`; this is the rest — systemd,
# Caddy, a public name, the installer, setup over SSH — which needs a box.
#
#   scripts/rehearse-remote.sh up        # build, boot, install; then prints the person's steps
#   scripts/rehearse-remote.sh mac       # the Mac's side: an isolated home, `tade remote add` for each box
#   scripts/rehearse-remote.sh hook <n>  # the scripted intake source on box n, and a signed delivery
#   scripts/rehearse-remote.sh down      # remove the boxes and the work folder
#
# Every step says what it does before it does it. Nothing here touches this
# machine's own Tade, its ~/.ssh or its global npm: the Mac's side is a home,
# an install prefix and an ssh config of its own under the work folder, and
# `mac.env` there is what to source to be that Mac.
#
# Environment: REHEARSAL_DIR (/tmp/rehearsal; short, because a Unix socket's
# path is capped near 104 bytes), REHEARSAL_BOXES (2), REHEARSAL_BASE (an
# image with apt to run debootstrap in when debian:12 cannot be pulled),
# REHEARSAL_WORK_SECONDS (45: how long a stand-in agent works), REHEARSAL_PORT
# (2240: box n's sshd is on 127.0.0.1:REHEARSAL_PORT+n).
#
# What each box gets is what a person does on a fresh VPS, as root: a user
# `you` with sudo, openssh, build tools, Node 22 from nodejs.org. Then as
# `you`: the installer's own command for the staged tarball, and pi pointed at
# the stand-in model (`test/fixtures/stand-in-model.ts`) so agents work with
# no key. Everything after that is the person's, and is printed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${REHEARSAL_DIR:-/tmp/rehearsal}"
BOXES="${REHEARSAL_BOXES:-2}"
WORK_SECONDS="${REHEARSAL_WORK_SECONDS:-45}"
IMAGE='tade-rehearsal-debian'
NODE='v22.23.3'
VERSION="$(node -p "require('$ROOT/package.json').version")-rehearsal"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
box() { echo "tade-rehearsal-vps$1"; }
port() { echo $((${REHEARSAL_PORT:-2240} + $1)); }
ssh_() { ssh -F "$DIR/ssh/config" "$@"; }

need() {
  for one in "$@"; do
    command -v "$one" >/dev/null || { echo "rehearse: needs $one" >&2; exit 1; }
  done
}

# ── the tarball ─────────────────────────────────────────────────────────────

stage() {
  say "Staging tade-sh@$VERSION from HEAD (a clean clone, so nobody's uncommitted work is in it)"
  rm -rf "$DIR/build" && git clone -q "$ROOT" "$DIR/build/clone"
  (cd "$DIR/build/clone" && node scripts/release/stage.ts --version "$VERSION" --out "$DIR/build/stage" 2>/dev/null | head -1)
  (cd "$DIR/build/stage" && npm pack --silent --pack-destination "$DIR" >/dev/null)
  TARBALL="$DIR/tade-sh-$VERSION.tgz"
  note "$TARBALL"
}

# ── a fresh Debian 12 with systemd ───────────────────────────────────────────

image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    say "Using the image $IMAGE (\`docker rmi $IMAGE\` to build it again)"
    return
  fi
  local base="${REHEARSAL_BASE:-debian:12}"
  say "Building $IMAGE: Debian 12 by debootstrap, run inside $base"
  docker image inspect "$base" >/dev/null 2>&1 || docker pull "$base"
  docker rm -f tade-rehearsal-debootstrap >/dev/null 2>&1 || true
  docker run -d --name tade-rehearsal-debootstrap --privileged --entrypoint /bin/sleep "$base" infinity >/dev/null
  docker exec tade-rehearsal-debootstrap sh -c 'export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq debootstrap >/dev/null &&
    debootstrap --variant=minbase --include=systemd,systemd-sysv,dbus,dbus-user-session,libpam-systemd,ca-certificates \
      bookworm /rootfs http://deb.debian.org/debian >/tmp/debootstrap.log'
  docker exec tade-rehearsal-debootstrap sh -c 'cd /rootfs && tar -c --numeric-owner .' |
    docker import --change 'ENTRYPOINT ["/sbin/init"]' --change 'STOPSIGNAL SIGRTMIN+3' - "$IMAGE" >/dev/null
  docker rm -f tade-rehearsal-debootstrap >/dev/null
}

# ── the boxes ───────────────────────────────────────────────────────────────

keys() {
  mkdir -p "$DIR/ssh" "$DIR/bin"
  [ -f "$DIR/ssh/id" ] || ssh-keygen -q -t ed25519 -N '' -C rehearsal -f "$DIR/ssh/id"
  : >"$DIR/ssh/config"
  for n in $(seq 1 "$BOXES"); do
    printf 'Host vps%s\n  HostName 127.0.0.1\n  Port %s\n  User you\n  IdentityFile %s\n  IdentitiesOnly yes\n  UserKnownHostsFile %s\n  LogLevel ERROR\n' \
      "$n" "$(port "$n")" "$DIR/ssh/id" "$DIR/ssh/known_hosts" >>"$DIR/ssh/config"
  done
  # The Mac's ssh is the real one, told about these boxes: ssh reads ~/.ssh/config
  # from the passwd home whatever HOME says, so a wrapper is how it is told.
  printf '#!/bin/sh\nexec %s -F %s "$@"\n' "$(command -v ssh)" "$DIR/ssh/config" >"$DIR/bin/ssh"
  chmod +x "$DIR/bin/ssh"
}

boot() {
  local n="$1" name
  name="$(box "$n")"
  say "Booting vps$n ($name), systemd as its first process, sshd on 127.0.0.1:$(port "$n")"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --hostname "vps$n" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock -p "127.0.0.1:$(port "$n"):22" "$IMAGE" >/dev/null
  sleep 3
  note 'as root: a user with sudo, openssh, build tools, Node 22 from nodejs.org (checksummed)'
  docker exec -i "$name" sh -s "$NODE" <<'ROOT'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq sudo openssh-server curl xz-utils build-essential python3 openssl >/dev/null 2>&1
id you >/dev/null 2>&1 || useradd -m -s /bin/bash you
echo 'you ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/you
arch=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')
cd /tmp && curl -fsSLO "https://nodejs.org/dist/$1/node-$1-linux-$arch.tar.xz" && curl -fsSLO "https://nodejs.org/dist/$1/SHASUMS256.txt"
grep " node-$1-linux-$arch.tar.xz\$" SHASUMS256.txt | sha256sum -c - >/dev/null
tar -xJf "node-$1-linux-$arch.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
install -d -m 700 -o you -g you /home/you/.ssh
systemctl enable --now ssh >/dev/null 2>&1
ROOT
  docker cp -q "$DIR/ssh/id.pub" "$name:/home/you/.ssh/authorized_keys"
  docker exec "$name" sh -c 'chown you:you /home/you/.ssh/authorized_keys && chmod 600 /home/you/.ssh/authorized_keys'
  ssh-keygen -f "$DIR/ssh/known_hosts" -R "[127.0.0.1]:$(port "$n")" >/dev/null 2>&1 || true
}

install_on() {
  local n="$1" name
  name="$(box "$n")"
  say "Installing on vps$n as \`you\`, the way scripts/install.sh would"
  docker cp -q "$TARBALL" "$name:/tmp/tade-sh.tgz"
  docker cp -q "$ROOT/scripts/install.sh" "$name:/tmp/install.sh"
  local line
  line="$(docker exec -u you "$name" sh /tmp/install.sh --dry-run | grep '^  npm ')"
  note "the installer would run:$line"
  note "so, for the staged tarball: ${line/tade-sh/\/tmp\/tade-sh.tgz}"
  # shellcheck disable=SC2086
  docker exec -u you -w /home/you "$name" ${line/tade-sh/\/tmp\/tade-sh.tgz} >/dev/null 2>&1
  docker exec -u you "$name" bash -lc 'tade --version'
}

stand_in() {
  local n="$1" name
  name="$(box "$n")"
  say "The stand-in model on vps$n, and pi pointed at it (~/.pi/agent/models.json)"
  docker exec "$name" mkdir -p /opt/rehearsal /home/you/.pi/agent
  docker cp -q "$ROOT/test/fixtures/stand-in-model.ts" "$name:/opt/rehearsal/stand-in-model.ts"
  docker cp -q "$ROOT/test/fixtures/rehearsal/deliver.sh" "$name:/opt/rehearsal/deliver.sh"
  docker exec -i "$name" sh -s "$WORK_SECONDS" <<'UNIT'
set -eu
cat >/etc/systemd/system/rehearsal-model.service <<EOF
[Unit]
Description=The rehearsal's stand-in model
[Service]
User=you
Environment=REHEARSAL_WORK_SECONDS=$1
ExecStart=/usr/local/bin/node /opt/rehearsal/stand-in-model.ts
Restart=always
[Install]
WantedBy=multi-user.target
EOF
cat >/home/you/.pi/agent/models.json <<'EOF'
{ "providers": { "rehearsal": { "baseUrl": "http://127.0.0.1:11434/v1", "api": "openai-completions",
  "apiKey": "rehearsal", "models": [{ "id": "stand-in", "name": "Rehearsal stand-in" }] } } }
EOF
chown -R you:you /home/you/.pi
systemctl daemon-reload && systemctl enable --now rehearsal-model >/dev/null 2>&1
UNIT
}

project_on() {
  local n="$1" name project
  name="$(box "$n")"
  project="$([ "$n" = 1 ] && echo app || echo "site$n")"
  say "vps$n's project: ~/src/$project, whose origin is vps$n:acme/$project.git"
  note "(a bare repository on the box, named as a forge would name it, so the Mac's clone is the same repository)"
  docker exec -u you -i "$name" sh -s "$n" "$project" <<'GIT'
set -eu
sudo apt-get install -y -qq git >/dev/null 2>&1
git config --global user.name You && git config --global user.email you@example.com && git config --global init.defaultBranch main
git config --global "url./home/you/.insteadOf" "vps$1:"
mkdir -p ~/acme ~/src && [ -d ~/acme/$2.git ] || git init -q --bare ~/acme/$2.git
rm -rf /tmp/seed && git init -q /tmp/seed && cd /tmp/seed && printf '# %s\n' "$2" >README.md && git add . && git commit -qm first && git push -q ~/acme/$2.git main
[ -d ~/src/$2 ] || git clone -q "vps$1:acme/$2.git" ~/src/$2
GIT
}

steps() {
  say "Now yours, on each box. In a terminal of its own:  ssh -F $DIR/ssh/config -t vpsN"
  cat <<EOF
   1. tade setup                  project ~/src/app (or ~/src/siteN), model rehearsal/stand-in, tmux,
                                  linger yes, the unit yes — it asks no speech on a server
   2. tade host service           start it: yes
   3. tade host domain vpsN.rehearsal.example   — a stand-in nobody registered: says so; write it: y
   4. tade host caddy             then, as it says (Caddy 2.7 or newer, from Caddy's own repository):
        sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
        curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
        sudo apt-get update && sudo apt-get install -y caddy
        printf 'd /run/tade 2750 %s caddy -\\n' you | sudo tee /etc/tmpfiles.d/tade.conf && sudo systemd-tmpfiles --create /etc/tmpfiles.d/tade.conf
        printf '{\\n\\tlocal_certs\\n}\\n\\n' | sudo tee /etc/caddy/Caddyfile && tade host caddy | sudo tee -a /etc/caddy/Caddyfile && sudo systemctl reload caddy
        tade web on && tade host caddy --check     (listening; the certificate is Caddy's own CA: loud, rightly)
   5. tade web pair               then claim it as a phone would, through Caddy:
        curl -sk --resolve vpsN.rehearsal.example:443:127.0.0.1 -H 'Origin: https://vpsN.rehearsal.example' \\
          -H 'content-type: application/json' -X POST https://vpsN.rehearsal.example/api/pair -d '{"ticket":"<t= from the link>","label":"phone"}'
   6. $0 mac                      the Mac's side: \`tade remote add\` for every box
EOF
}

up() {
  need docker git node npm ssh ssh-keygen
  mkdir -p "$DIR"
  stage
  image
  keys
  for n in $(seq 1 "$BOXES"); do
    boot "$n"
    install_on "$n"
    stand_in "$n"
    project_on "$n"
  done
  steps
}

# ── the Mac ─────────────────────────────────────────────────────────────────

mac() {
  TARBALL="$(ls -t "$DIR"/tade-sh-*.tgz | head -1)"
  say "The Mac: Tade installed under $DIR/mac-install, its home $DIR/mac/tade, HOME $DIR/mac/home"
  mkdir -p "$DIR/mac/home/.pi/agent" "$DIR/mac/tade" "$DIR/mac/src"
  npm install --global --allow-scripts=tade-sh,node-pty,better-sqlite3 --prefix "$DIR/mac-install" "$TARBALL" >/dev/null 2>&1
  cat >"$DIR/mac.env" <<EOF
export PATH="$DIR/bin:$DIR/mac-install/bin:\$PATH"
export HOME="$DIR/mac/home" TADE_HOME="$DIR/mac/tade" TERM=xterm-256color
EOF
  note "source $DIR/mac.env to be this Mac"
  # shellcheck disable=SC1091
  . "$DIR/mac.env"
  git config --global user.name You && git config --global user.email you@example.com
  say "The Mac's stand-in model, on 127.0.0.1:11435 (log: $DIR/mac-model.log)"
  sed 's/11434/11435/' <<'EOF' >"$DIR/mac/home/.pi/agent/models.json"
{ "providers": { "rehearsal": { "baseUrl": "http://127.0.0.1:11434/v1", "api": "openai-completions",
  "apiKey": "rehearsal", "models": [{ "id": "stand-in", "name": "Rehearsal stand-in" }] } } }
EOF
  (REHEARSAL_MODEL_PORT=11435 REHEARSAL_WORK_SECONDS="$WORK_SECONDS" nohup node "$ROOT/test/fixtures/stand-in-model.ts" >"$DIR/mac-model.log" 2>&1 &)
  say "The Mac's project app: a clone of vps1:acme/app.git, the same repository as vps1's"
  [ -d "$DIR/mac/src/app" ] || git clone -q vps1:acme/app.git "$DIR/mac/src/app"
  printf 'projects:\n  app:\n    root: %s\norchestrator:\n  model: rehearsal/stand-in\n' "$DIR/mac/src/app" >"$TADE_HOME/config.yaml"
  for n in $(seq 1 "$BOXES"); do
    say "tade remote add vps$n --ssh vps$n --tade /home/you/.local/bin/tade"
    note 'a box never met is shown by its key first: compare it with the one printed here'
    docker exec "$(box "$n")" ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
    tade remote add "vps$n" --ssh "vps$n" --tade /home/you/.local/bin/tade
  done
  say 'Then, in order (source mac.env and run `tade`):'
  cat <<'EOF'
   - each box's project is a tab under its name; on its orchestrator tab (the strip, bottom left) type
       start app/refunds: fix refunds double-charge        (on vps1)
     and see the agent there, working, then ✓
   - start a longer one on each, close the window (ctrl+c twice), take a note on a box
       (ssh vps2, `tade remember …`), wait past five minutes and the work, open `tade` again:
       each tab says "since you were here", and NOTES has the note
   - on this Mac's own tab:  start app/export: export the ledger   then   hand app/export to vps1
     (the stand-in agent pushes as it is told; vps1 begins a worktree on tade/export)
   - on a box's project tab: CHECKS, SCHEDULES, DOCUMENTS are that box's
   - the scripted intake source:  scripts/rehearse-remote.sh hook 1
EOF
}

# ── the doorbell ────────────────────────────────────────────────────────────

hook() {
  local n="${1:-1}" name
  name="$(box "$n")"
  say "vps$n: the scripted intake source (test/fixtures/rehearsal/extension.ts), and GitHub's webhook secret"
  docker exec "$name" mkdir -p /home/you/.tade/extensions/rehearsal-intake
  docker cp -q "$ROOT/test/fixtures/rehearsal/extension.ts" "$name:/home/you/.tade/extensions/rehearsal-intake/extension.ts"
  docker exec "$name" chown -R you:you /home/you/.tade/extensions
  ssh_ "vps$n" 'bash -lc "tade extensions enable rehearsal-intake"
    cd ~/.local/lib/node_modules/tade-sh && node -e "
      const fs = require(\"fs\"), Y = require(\"yaml\"), p = process.env.HOME + \"/.tade/config.yaml\"
      const d = Y.parseDocument(fs.readFileSync(p, \"utf8\"))
      d.setIn([\"extensions\", \"intake\", \"github_webhook_secret\"], \"rehearsal-hook-secret\")
      fs.writeFileSync(p, String(d), { mode: 0o600 })"
    XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart tade'
  cat <<EOF
   Turn its watch on at that machine: stop the service (systemctl --user stop tade), run \`tade\` there,
   Extensions › Rehearsal intake › Turn on, quit, start the service. (From the Mac's tab it is refused
   until a typed line there counts as the person's — see the rehearsal's leftovers.)
   Then a request for it to find, and the delivery:
     ssh -F $DIR/ssh/config vps$n 'printf "[{\\"id\\":\\"req-7\\",\\"title\\":\\"Refunds double-charge\\"}]\\n" > ~/src/app/REQUESTS.json'
     ssh -F $DIR/ssh/config vps$n 'sh /opt/rehearsal/deliver.sh vps$n.rehearsal.example rehearsal-hook-secret https://vps$n/acme/app'
   and look for hook_rung (woke: rehearsal-requests), watch_checked and watch_found in ~/.tade/events.jsonl there,
   and the finding under that box's SCHEDULES on the Mac.
EOF
}

down() {
  say "Removing the boxes and $DIR"
  for n in $(seq 1 "$BOXES"); do docker rm -f "$(box "$n")" >/dev/null 2>&1 || true; done
  pkill -f "$ROOT/test/fixtures/stand-in-model.ts" 2>/dev/null || true
  rm -rf "$DIR"
}

case "${1:-}" in
  up) up ;;
  mac) mac ;;
  hook) hook "${2:-1}" ;;
  down) down ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'; exit 2 ;;
esac
