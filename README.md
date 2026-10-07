# Roost

Roost is the home-server suite: one homepage that signs you in and shows the apps you can use.

![The Roost dashboard on a desktop browser and a phone](docs/screenshots/dashboard.png)

| App | What it is |
| --- | --- |
| Jellyfin | Media (films, shows, music) |
| Nova | The galaxies, starting with Coffee Galaxy (own repo for now, merging in later) |
| Nest | File storage |
| Glint | Photo storage |

## The homepage

- **First run** creates the admin account.
- **Dashboard**: greeting, live server stats (uptime, memory, load, free space on the data drive) and a card for every app you have access to, each showing whether the app is reachable.
- **Status**: refreshes every 5 seconds. First, each app (and Roost itself) with its container state from Docker: running, stopped, restarting, unhealthy, how long it has been up and how often it restarted, plus whether it answers on its link. Admins also see every other container. Below that, server health: uptime, CPU, memory and free space on each drive. Problems are listed at the top.
- **Profile**: change your display name and password, see your storage use and limit, and ask an admin for more space.
- **Admin**: edit the app list and links, add or remove users, choose which apps each user sees and how much storage they get, approve or decline storage requests, rename the server, and set up HTTPS.

![Signing in to Roost](docs/screenshots/sign-in.png)

![The admin page: users and which apps each one sees](docs/screenshots/admin.png)

App links can use `{host}`, which becomes whatever address you opened Roost on. `http://{host}:8096` works from the LAN IP, the hostname or a Tailscale name without editing anything.

## Storage limits

Every user has a storage limit in GB, picked with a slider that runs up to the size of the data drive (or typed exactly; admins can also tick "No limit"). New users start with the default set under **Admin → Server** (50 GB unless changed); only admins can change a limit. Other users can ask for more from their Profile, and the request waits under **Admin → Storage requests** until an admin approves it (optionally with a different amount) or declines it.

Roost stores the limits and the usage each storage app reports, but holds no files itself, so the limit is *enforced* by Nest and Glint once they exist. They talk to Roost with the token in `ROOST_APP_TOKEN` (the app API is off when it is unset):

```
GET /api/storage/users/<username>          → { storage: { limitBytes, usedBytes, remainingBytes, ... } }
PUT /api/storage/users/<username>/usage    { "app": "nest" | "glint", "bytes": 123 }
Authorization: Bearer <ROOST_APP_TOKEN>
```

## HTTPS

Roost gets and renews its own certificate from Let's Encrypt, with no extra containers or packages. It covers your domain and every name under it (`roostos.network` and `*.roostos.network`), so Jellyfin, Nest and Glint can share it later.

1. Put the domain's DNS on Cloudflare (the free plan is enough).
2. In Cloudflare, go to **My Profile → API Tokens → Create Token** and use the **Edit zone DNS** template, limited to that one domain.
3. In Roost, open **Admin → Secure connection**, enter the domain and paste the token. Roost proves it owns the domain by adding a temporary DNS record, so no router ports need opening for this.
4. Point a name such as `roost.roostos.network` at the server. At home, add it to your router's local DNS (pointing at the server's LAN IP) so traffic stays on your network; from outside, use Cloudflare.

Roost checks the certificate twice a day and renews it 30 days before it runs out. If renewal keeps failing, the status page warns admins two weeks before expiry. HTTPS listens on container port 8443, published as 443 in `docker-compose.yml`; if ZimaOS already uses 443, publish a different port. Set `ROOST_ACME_STAGING=true` to try the setup with Let's Encrypt's test certificates first (browsers won't trust those). The certificate and keys are kept in `/data/tls`.

Sign-in cookies are marked Secure whenever Roost is opened over HTTPS, directly or through Cloudflare.

## Stack

Plain Node.js (20+) with no npm dependencies, and a vanilla HTML/CSS/JS front end with no build step. Accounts and the app list live in one JSON file (`/data/roost.json`). Passwords are hashed with scrypt; sessions are HttpOnly, SameSite=Strict cookies held in memory, so a restart signs everyone out.

## Run it on ZimaOS

1. Copy this repo onto the server (for example `/DATA/AppData/roost-src`).
2. In the ZimaOS dashboard: **App Store → Custom Install → Import**, and paste `docker-compose.yml`. Or over SSH: `docker compose up -d --build` in the repo folder.
3. Open `http://<server-ip>:8080` and create the admin account.
4. Under **Admin**, fill in each app's link once those apps are installed (Jellyfin defaults to `http://{host}:8096`).

Data is kept in `/DATA/AppData/roost` on the host. For the status page to show the data drive, change the second `/DATA` mount in `docker-compose.yml` to the folder ZimaOS mounted the 3 TB drive on; `ROOST_DISKS` sets the labels.

Container status comes through the `docker-proxy` service in the compose file, which only lets Roost read the container list (it can't start, stop or change anything). Apps are matched to containers by name; if a container is named differently, put its name in the app's **Container** field under Admin. Without Docker access the status page falls back to checking each app's link and says so.

## Develop

```sh
npm start        # http://localhost:8080, data in ./data
npm test
```
