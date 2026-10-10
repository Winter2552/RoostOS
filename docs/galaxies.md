# Galaxies

A galaxy is a web app that Roost serves at `https://nova.<your domain>/<name>/` behind Roost's one sign-in. Coffee Galaxy has its own server and its own card (Admin → Coffee Galaxy). Every other galaxy runs as a Docker container on the Roost box and is added under **Admin → Galaxies**.

## Adding one

1. Admin → Galaxies → give it a name and the port its container listens on (and optionally its image).
2. Roost makes the shared secret and shows a compose file once. In ZimaOS: App Store → Custom Install → Import, paste it.
3. Press **Check** to see Roost reach it, then tick the galaxy for people under Admin → People (guests too).
4. Once, re-import Roost's own `docker-compose.yml`: it now maps `host.docker.internal` so Roost can reach containers on the box.

Removing a galaxy removes its card and ticks; the container is never touched.

## What a galaxy has to do

- Use relative links in its pages. Roost removes the prefix before forwarding, so the app sees `/`, `/chat`, and so on, but the browser sees `/books/...`. The compose file sets `GALAXY_BASE_PATH` (for example `/books`) for apps that need to know it.
- Answer `GET /__health` with a 200.
- Trust the signed sign-in headers Roost adds to every request:

  | Header | Value |
  |---|---|
  | `X-Roost-User` | Roost username, lowercase, `[a-z0-9._-]{1,40}` |
  | `X-Roost-Admin` | `1` only for a Roost admin who has finished two-step, else `0` |
  | `X-Roost-Ts` | Unix seconds when signed |
  | `X-Roost-Sig` | hex `HMAC-SHA256(secret, "<ts>\n<user>\n<admin>")` |

  The key is the secret's hex **text** as UTF-8 bytes (`hmac.new(secret.encode(), msg, sha256)`). Accept a request only if the signature matches (constant-time compare) and `|now - ts| <= 60`. Roost removes any `X-Roost-*`, `X-Forwarded-*` and its own `roost_*` cookies the browser sent, then sets `X-Forwarded-For`, `-Proto` and `-Host`.
- These paths come with no headers and no sign-in: `/__health`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`. Everything else is signed.
- Publish the container's port on the box (the compose file does), and keep it off the internet: only Roost should reach it.

Sign-in, guest passes and the Galaxy tick are checked on every request, so taking someone's access away cuts them off on their next click.
