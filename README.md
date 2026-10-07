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
- **Profile**: change your display name and password.
- **Admin**: edit the app list and links, add or remove users, choose which apps each user sees, rename the server.

![Signing in to Roost](docs/screenshots/sign-in.png)

![The admin page: users and which apps each one sees](docs/screenshots/admin.png)

App links can use `{host}`, which becomes whatever address you opened Roost on. `http://{host}:8096` works from the LAN IP, the hostname or a Tailscale name without editing anything.

## Stack

Plain Node.js (20+) with no npm dependencies, and a vanilla HTML/CSS/JS front end with no build step. Accounts and the app list live in one JSON file (`/data/roost.json`). Passwords are hashed with scrypt; sessions are HttpOnly, SameSite=Strict cookies held in memory, so a restart signs everyone out.

## Run it on ZimaOS

1. Copy this repo onto the server (for example `/DATA/AppData/roost-src`).
2. In the ZimaOS dashboard: **App Store → Custom Install → Import**, and paste `docker-compose.yml`. Or over SSH: `docker compose up -d --build` in the repo folder.
3. Open `http://<server-ip>:8080` and create the admin account.
4. Under **Admin**, fill in each app's link once those apps are installed (Jellyfin defaults to `http://{host}:8096`).

Data is kept in `/DATA/AppData/roost` on the host. Set `SECURE_COOKIES=true` only when Roost is served over HTTPS.

## Develop

```sh
npm start        # http://localhost:8080, data in ./data
npm test
```
