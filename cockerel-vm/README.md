# Cockerel's VM

Cockerel is Raven's personal agent. He runs in his own Debian virtual machine on the Optiplex, can't see Roost's data, and talks to Roost over a signed local link. Roost's side is the **Cockerel** app (chat, activity feed, job cards) and **Admin → Server → Cockerel**.

What is in this folder:

| File | What it does |
| --- | --- |
| `setup-vm.sh` | Installs everything in a fresh Debian VM (Node, aria2, ffmpeg, WireGuard, XFCE desktop and browser, Claude Code). |
| `service.js` | His service. Sleeps until Roost sends a chat message, a movie request or an answer. |
| `tool.js` | The only program Claude may run (`cockerel-tool`). Holds the rules: open sources, size limit, VPN check, filing into Roostflix. |
| `CLAUDE.md` | His job description and rules. |
| `vpn-killswitch.sh`, `nftables.conf.template`, `leak-test.sh` | Windscribe tunnel and kill switch, and the test that proves it. |

## 1. Create the VM (on ZimaOS)

1. In ZimaOS open the **VM** app (turn on virtualisation in the BIOS if it asks). If there is no VM app on your ZimaOS version, tell Claude: the same setup works under any KVM host.
2. New VM: **Debian 12 (netinst ISO)**, **2 vCPU, 3 GB RAM, 40 GB disk on the SSD**, network **bridged** so it gets its own home-network address. If the VM app can limit CPU, cap it near 50% so Jellyfin never starves.
3. Install Debian: no desktop, tick **SSH server** and **standard system utilities**. Make a user for yourself, then note the VM's address (say `192.168.4.40`). Give it a fixed address in your router.

## 2. Install Cockerel

On the VM, as root:

```
apt-get install -y git
git clone https://github.com/Winter2552/RoostOS /root/roost
bash /root/roost/cockerel-vm/setup-vm.sh          # add --no-desktop to skip the desktop
```

It prints a **shared secret**. Keep it; you paste it into Roost in step 6.

## 3. Windscribe and the kill switch

1. On windscribe.com: **My Account → Config Generators → WireGuard**. Make a config (any location), download it, and copy it to the VM as `/etc/wireguard/wg0.conf`.
2. `sudo bash /opt/cockerel/vpn-killswitch.sh 192.168.4.35` (Roost's address; add your home network as a second word if it is not `192.168.4.0/24`).
3. `sudo bash /opt/cockerel/leak-test.sh <your home public IP>` (the address whatismyip.com shows on your PC). It must print **PASS**. Do not let Cockerel download before it does.

If the tunnel drops, everything he sends stops, including Claude and downloads, until it is back. That is the point.

## 4. Sign Claude in (once)

```
sudo -u cockerel -H claude
```

Choose your Claude subscription sign-in and open the link on your PC. For a token that does not expire, `claude setup-token` also works. Check `claude --help` if a flag the service uses (`--allowedTools`, `--max-turns`, `--output-format json`) has been renamed.

He shares your Claude allowance. The service wakes Claude only for a chat message or an approved request, and stops at `MAX_RUNS_PER_DAY` (60) in `/etc/cockerel/env`.

## 5. Share the media folders

He needs read-write access to three folders on the data drive, and nothing else: `incoming`, `Movies` and `Series` inside the Roostflix folder (`/media/roosthdd/media/roostflix`).

1. In ZimaOS **Files**, share the folder as an SMB share (a user just for him, with a password).
2. In the VM: put `username=…` and `password=…` in `/etc/cockerel/smb` (`chmod 600`), then add to `/etc/fstab`:

```
//192.168.4.35/media  /srv/media  cifs  credentials=/etc/cockerel/smb,uid=cockerel,gid=cockerel,vers=3.0,_netdev  0  0
```

If ZimaOS can only share the whole `media` folder, that is what he gets. Films and shows are the only things in it. Bulk data never goes in his own 40 GB disk.

## 6. Start him and link Roost

```
sudo systemctl enable --now cockerel
```

In Roost: **Admin → Server → Cockerel**. Address `http://<vm-address>:7070`, the shared secret from step 2, and the size limits (default: 5 GB per download, 20 GB per day). Then open the **Cockerel** app and say hello.

If `ROOST_URL` in `/etc/cockerel/env` is not Roost's address, fix it and `sudo systemctl restart cockerel`.

## 7. Snapshots

Snapshot the VM before big changes and weekly. Use the VM app's snapshot or backup button if ZimaOS has one; otherwise shut the VM down and copy its disk file to the data drive. A snapshot is the way back if he or the VM goes wrong. (Roost's **Pause** button stops him listening and acting without touching the VM.)

## What he will and won't fetch

- Anything on the Internet Archive's open collections (public domain, Creative Commons), Blender's open movies, and Wikimedia, on his own.
- A link or magnet **you** give him: he asks you to confirm you are entitled to it, and the answer is kept in the activity feed.
- He never searches pirate sites or indexes and has no tool that can. Copyrighted films you don't own are not something he will find or download.
- Under the size limit he acts alone; over it he asks you. Roost keeps the day's total, so restarting the VM can't reset it.

## The desktop and browser

`setup-vm.sh` installs XFCE and Chromium. The desktop shows in the ZimaOS VM console, so you can watch what is happening on the screen. Claude does not drive the browser yet: his only tool is `cockerel-tool`. A browser tool can be added later for a job that needs one.

## Updating

`cd /root/roost && git pull && sudo bash cockerel-vm/setup-vm.sh && sudo systemctl restart cockerel` (your secret and settings are kept).
