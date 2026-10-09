# Roost

Roost is the home-server suite: one homepage that signs you in and shows the apps you can use.

![The Roost dashboard on a desktop browser and a phone](docs/screenshots/dashboard.png)

| App | What it is |
| --- | --- |
| Jellyfin | Media (films, shows, music) |
| Nova | The galaxies, starting with Coffee Galaxy (own repo for now, merging in later) |
| Nest | File storage, built into Roost (the Files page) |
| Glint | Photo storage |

## Setup checklist

**Admin → Setup** walks through everything Roost needs, one step at a time. Each step covers the data drive, the domain, the email relay, two-step sign-in and so on, and gives the exact steps, including the ones outside Roost. Roost checks most steps itself and ticks them off as you go. Until every step is done, admins see a "Setup · 3 of 9 done" link on the dashboard.

The steps live in `src/setup.js`, which is the single tally of what setting up Roost involves. **When a change needs something set up (a setting, an environment variable, a DNS record, a drive), add a step there in the same change**, with a check if Roost can see it. `npm test` fails if an environment variable or saved setting in `src/` has no step (or a reason under `NO_STEP` for not needing one).

## The homepage

- **First run** creates the admin account.
- **Dashboard**: greeting, live server stats (uptime, memory, load, free space on the data drive) and a card for every app you have access to, each showing whether the app is reachable.
- **Status**: refreshes every 5 seconds. First, each app (and Roost itself) with its container state from Docker: running, stopped, restarting, unhealthy, how long it has been up and how often it restarted, plus whether it answers on its link. Admins also see every other container, and a **Restart** button on apps they're allowed to restart (it asks first, then waits until the app is back up). Below that, server health: uptime, CPU, memory and free space on each drive. Each app also shows a 30-day uptime strip, one bar per day (tap a day to see when it was down). Roost keeps this itself in `uptime.json` next to its data, starting from the day it is installed; days Roost was off show as no data. Problems are listed at the top.
- **Profile**: change your display name and password, turn two-step sign-in on or off, see your storage use and limit, and ask an admin for more space.
- **Admin**: edit the app list and links, invite or remove users, make password reset links, choose which apps each user sees and how much storage they get, approve or decline storage requests, rename the server, and set up HTTPS.

![Signing in to Roost](docs/screenshots/sign-in.png)

![The admin page: users and which apps each one sees](docs/screenshots/admin.png)

**Admin → Apps → + Add app** lists the apps Docker is running that have no card yet, with the port each is really published on, then a few templates (Roost's own apps, Home Assistant, Navidrome, Audiobookshelf, Portainer). Tap one and a filled-in card appears; check it and press **Save apps**. **Blank card** is still there for anything else. Roost only asks Docker when the list opens.

App links can use `{host}`, which becomes whatever address you opened Roost on. `http://{host}:8096` works from the LAN IP, the hostname or a Tailscale name without editing anything.

## Nest (Files)

Nest is Roost's own file storage, built to work like Google Drive. Open it from **Files** in the menu or the Nest card.

- **My Drive**: make folders, upload files or whole folders (button or drag and drop), download (folders and several items come as one zip), rename, move, make copies. List or grid view, sorted by name, date or size.
- **Trash**: deleted items wait 30 days, then go for good. Restore puts them back where they were. Everything in the trash still counts toward your storage.
- **Undo** follows every move, rename and delete.
- **On a computer**: click selects (Ctrl/Cmd to add, Shift for a range), double-click opens, right-click for actions, drag onto a folder to move. Delete, F2 (rename), Ctrl/Cmd+A and Esc work as expected.
- **On a phone**: tap opens, long-press starts selecting, ⋯ or a tap on a file shows its actions, and the round + button uploads or makes a folder.
- **Big uploads** go in 16 MB pieces, three files at a time. A dropped connection picks up where it stopped, and the upload panel keeps going while you browse.

Files are stored as ordinary files and folders, laid out the way you see them, so they stay readable even without Roost: `NEST_DIR/<username>_<id>/files/...` (the trash is next to it in `trash/`). Folder details (ids, trash dates) are kept in `/data/nest.db` (SQLite, built into Node). Uploads are refused when they would go over your storage limit or leave less than 1 GB free on the drive. Removing a user leaves their Nest folder on the drive.

## Invites and password resets

Nobody needs to be in the room to get an account. Under **Admin → Invite someone**, pick their role, apps and storage limit and press **Create invite link**. Copy the link (or use **Share** on a phone) and send it any way you like. It looks like `https://roostos.network/j/K7PX-2QM9`. They open it, choose their own username and password, and are signed straight in.

- An invite works once and stops working after 7 days. Pending invites are listed under the form, where you can cancel one.
- The link is only shown when you make it. Lost it? Cancel it and make a new one.
- If someone forgets their password, press **Password reset link** next to their name under **Admin → Users** and send them that (`/r/…`). It works once for 24 hours, and saving the new password signs them out everywhere else.
- Codes are 8 characters with no look-alikes (no 0/O or 1/I/L), so they can be read out and typed in any case, with or without the dash. Wrong guesses are rate limited per address and codes are stored hashed.
- Set **Admin → Server → Public address** (for example `https://roostos.network`) so links use it even when you make them at home. Left blank, links use whatever address you opened Roost on, so one made on `http://192.168.1.20:8080` only opens at home.

## Email (Forgot password and emailed invites)

Optional. With email set up, the sign-in page gets **Forgot password?**, which emails a reset link that works once for 1 hour. Invites and reset links can also be emailed straight from Admin. Users add their email address on **Profile**, or when they join from an invite.

A home connection can't deliver email reliably: most providers block outgoing mail, and home addresses are on spam blocklists. So Roost hands each email to a relay over SMTP, using its own built-in sender (no packages). Any SMTP relay works. Two with free plans that let you send as your own domain:

- **Resend**: 3,000 emails a month, 100 a day. SMTP host `smtp.resend.com`, port 587 (STARTTLS), username `resend`, password = an API key.
- **Brevo**: 300 emails a day. SMTP host `smtp-relay.brevo.com`, port 587, with the login and SMTP key from its SMTP settings.

To send as `server@roostos.network`:

1. Sign up with the relay and add `roostos.network` as a sending domain. It gives you a few DNS records (SPF and DKIM). Add them in Cloudflare → DNS. Without them, mail lands in spam.
2. In Roost, open **Admin → Server**, set **Public address** to `https://roostos.network`, and save. Email links always use this address.
3. Fill in **Admin → Email** with the relay's details and **Send from** `server@roostos.network`, then press **Send me a test email**. It goes to the email on your Profile.
4. Optional: so replies to `server@` reach you, turn on Cloudflare **Email Routing** and forward that address to your own inbox.

The relay password is kept in `roost.json` and is never sent back to the browser. Leave **Mail server** blank to turn email off.

## Storage limits

Every user has a storage limit in GB, picked with a slider that runs up to the size of the data drive (or typed exactly; admins can also tick "No limit"). New users start with the default set under **Admin → Server** (50 GB unless changed); only admins can change a limit. Other users can ask for more from their Profile, and the request waits under **Admin → Storage requests** until an admin approves it (optionally with a different amount) or declines it.

Nest is part of Roost, so it enforces the limit itself and its usage shows up on the Profile straight away. From 90% full, Nest shows an **Ask for more** link under its storage bar (admins get **Raise limit**), and an upload that would go over stops with the same link instead of a retry. Glint, once it exists, reads the limit and reports its usage with the token in `ROOST_APP_TOKEN` (the app API is off when it is unset):

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

## Two-step sign-in

After the password, Roost asks for a 6-digit code from an authenticator app (Google or Microsoft Authenticator, 1Password, Bitwarden, or the phone's own passwords app). It's built into Roost with no outside service, using the standard TOTP codes (RFC 6238); Roost draws the setup QR code itself.

- **Admins must use it** (turn this off under **Admin → Server**). Right after signing in, an admin without it is taken to the setup screen and can't open Admin until it's done. Everyone else is offered it once after signing in and can turn it on later from **Profile**.
- **Setup**: scan the QR code (on a phone, tap **Open in authenticator app**; or type the key), enter one code, then save the 10 recovery codes.
- **Signing in**: the code box opens the number keypad, phones can fill the code in, and it signs in as soon as 6 digits are in. **Trust this device for 30 days** skips the code on that device. Each code works once, and codes from a phone clock up to 30 seconds off are accepted.
- **Lost phone**: sign in with a recovery code (each works once), or an admin presses **Reset two-step** on that user under **Admin → Users**, and they set it up again. If the only admin is locked out, run this on the server:

```sh
docker exec roost node src/cli.js reset-two-step <username>
docker restart roost
```

Recovery codes and trusted devices are stored only as hashes. The authenticator secret has to be stored as-is in `roost.json`, so keep that file as private as the server itself.

## Stack

Plain Node.js (22.13+) with no npm dependencies, and a vanilla HTML/CSS/JS front end with no build step. Accounts and the app list live in one JSON file (`/data/roost.json`); Nest's folder details live in SQLite (`/data/nest.db`, using Node's built-in `node:sqlite`). Passwords are hashed with scrypt; sessions are HttpOnly, SameSite=Strict cookies held in memory, so a restart signs everyone out.

## Run it on ZimaOS

1. Copy this repo onto the server (for example `/DATA/AppData/roost-src`).
2. In the ZimaOS dashboard: **App Store → Custom Install → Import**, and paste `docker-compose.yml`. Or over SSH: `docker compose up -d --build` in the repo folder.
3. Open `http://<server-ip>:8080` and create the admin account.
4. Under **Admin**, fill in each app's link once those apps are installed (Jellyfin defaults to `http://{host}:8096`).

Data is kept in `/DATA/AppData/roost` on the host, and Nest's files in `/DATA/roost-nest`. Before storing real files, change that `/DATA/roost-nest` mount in `docker-compose.yml` to a folder on the 3 TB data drive. For the status page to show the data drive, change the second `/DATA` mount in `docker-compose.yml` to the folder ZimaOS mounted the 3 TB drive on; `ROOST_DISKS` sets the labels.

Container status comes through `roost-docker`, Roost's own small Docker helper (`src/docker-helper.js`, built from the same image). It lets Roost read the container list and restart only the containers named in its `ROOST_RESTARTABLE` setting; it refuses starting, stopping, removing, exec and everything else, and has no port open outside. Roost never restarts itself. Each restart shows up under Admin → Activity → Apps. Apps are matched to containers by name; if a container is named differently, put its name in the app's **Container** field under Admin. Without Docker access the status page falls back to checking each app's link and says so. Set `SECURE_COOKIES=true` only when Roost is served over HTTPS.

The **Activity** section under Admin lists sign-ins, failed sign-in attempts (the username typed, never the password), user and app changes, and storage requests and approvals. It keeps the newest 1,000 entries in `/data/activity.json`. If Roost is reached through a tunnel or reverse proxy, set `BEHIND_PROXY=true` so the log shows each visitor's address instead of the proxy's; leave it off otherwise, since the forwarded-address header can be faked.

## Develop

```sh
npm start        # http://localhost:8080, data in ./data
npm test
```
