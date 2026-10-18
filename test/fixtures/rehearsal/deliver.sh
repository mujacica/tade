#!/bin/sh
# One signed GitHub `issues` delivery to https://<name>/hooks/github, the way
# GitHub sends one, through the Caddy on this box (the name resolved here, so a
# stand-in name works). The rehearsal's doorbell: it makes the watch whose
# doorbell is GitHub's look now.
#
#   sh deliver.sh <name> <secret> <repository's web address>
#   sh deliver.sh vps1.rehearsal.example s3cret https://vps1/acme/app
set -eu
name="$1"
secret="$2"
url="$3"
body=$(printf '{"action":"labeled","issue":{"number":7,"title":"Refunds double-charge"},"repository":{"full_name":"acme/app","html_url":"%s"}}' "$url")
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)
curl -sk --resolve "$name:443:127.0.0.1" -X POST "https://$name/hooks/github" \
  -H 'content-type: application/json' -H 'user-agent: GitHub-Hookshot/rehearsal' \
  -H 'x-github-event: issues' -H "x-github-delivery: $(cat /proc/sys/kernel/random/uuid)" \
  -H "x-hub-signature-256: sha256=$sig" --data-binary "$body" -w " %{http_code}\n"
