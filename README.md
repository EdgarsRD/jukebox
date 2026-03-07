# Jukebox

Bar song request queue. Patrons connect to WiFi, scan a QR code, search Spotify and queue songs. Bartender manages everything via `/admin`.

---

## How it works

- Runs on a dedicated machine at the bar
- Patrons open `https://jukebox.kzd:3000` (via QR code)
- `jukebox.kzd` is a local-only domain — resolves inside the bar's WiFi only
- Everything (code, config, certs) lives in one folder — portable to any spare machine if needed

---

## Requirements

- Node.js 18+
- openssl
- A Spotify Premium account

---

## Initial Setup (production machine)

### 1. Set a static local IP

Find your network interface:
```bash
ip link show
```

Edit netplan:
```bash
sudo nano /etc/netplan/01-netcfg.yaml
```

```yaml
network:
  version: 2
  ethernets:
    eth0:                        # replace with your interface name
      dhcp4: no
      addresses: [192.168.1.50/24]
      gateway4: 192.168.1.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
```

```bash
sudo netplan apply
```

### 2. Set up local DNS on your router

Log into your router admin panel and add a custom DNS record:

```
jukebox.kzd  →  192.168.1.50
```

This is usually under: Advanced → DNS → Local DNS Records (varies by router).
Once set, any device on the WiFi can reach the server at `jukebox.kzd`.

### 3. Generate the TLS certificate

```bash
cd ~/jukebox
bash scripts/gen-cert.sh
```

Generates a cert for `jukebox.kzd` + your local IP, valid 10 years.
Stored in the project folder — travels with it.

### 4. Install as a systemd service

```bash
sudo bash scripts/install-service.sh
```

Autostart on boot, restarts on crash.

### 5. Complete setup in the admin panel

Open `https://jukebox.kzd:3000/admin` on the bar machine.
- Set admin password (first run)
- Add Spotify credentials → Authorize
- Configure queue rules

### 6. Make QR codes

Generate two QR codes to post at the bar:
1. **WiFi** — your router's guest network QR (you already have this)
2. **Jukebox** — points to `https://jukebox.kzd:3000`

Patrons will see a one-time "Not Secure" browser warning.
They tap Advanced → Proceed. Never see it again on that device.

---

## Dev Setup (Arch Linux / any machine)

Since you won't have `jukebox.kzd` resolving locally during dev, use `/etc/hosts`:

```bash
# Add to /etc/hosts:
127.0.0.1   jukebox.kzd
```

Then:
```bash
npm install
bash scripts/gen-cert.sh    # generates cert for jukebox.kzd + your local IP
npm run dev                  # nodemon — auto-restarts on changes
```

Open `https://jukebox.kzd:3000` — accept the cert warning once, done.
Admin at `https://jukebox.kzd:3000/admin`.

> The `/etc/hosts` entry is only needed on your dev machine.
> On the bar network, the router handles DNS for all devices automatically.

---

## Deploying updates

Development happens on the `arch` branch, production runs `main`.

```bash
# Ship tested changes to production
git checkout main
git merge arch
git push origin main
git checkout arch
```

On the bar machine, staff runs the "Update Jukebox" shortcut (or `bash update.sh`).

---

## USB Recovery (machine died)

1. Plug USB into any spare Ubuntu machine
2. Run:
   ```bash
   bash scripts/start.sh
   ```
3. Follow prompts — installs service, starts server
4. Update the router's DNS record to point `jukebox.kzd` at the new machine's IP
5. Back up in minutes

> `config.json`, `cert.pem`, and `key.pem` travel on the USB —
> Spotify auth, password, and rules are all preserved.

---

## Useful commands

```bash
sudo systemctl status jukebox       # is it running?
sudo systemctl restart jukebox      # restart after update
sudo journalctl -u jukebox -f       # live logs
sudo systemctl stop jukebox         # stop manually
```

---

## File structure

```
jukebox/
├── server.js           — Express server + all API routes
├── package.json
├── config.json         — Auto-created on first run (gitignored)
├── config.example.json — Template for config.json
├── cert.pem            — TLS cert (gitignored, travels with app)
├── key.pem             — TLS key (gitignored, travels with app)
├── queue.json          — Persisted queue state (gitignored)
├── history.json        — Request history (gitignored)
├── public/
│   └── index.html      — Patron UI (search + queue)
├── admin/
│   ├── index.html      — Admin panel (queue mgmt, Spotify, rules, moderation)
│   └── setup.html      — First-run password setup
├── scripts/
│   ├── gen-cert.sh         — Generate TLS cert
│   ├── start.sh            — USB recovery: one command to get back online
│   └── install-service.sh  — Install systemd autostart service
└── update.sh           — Pull latest code + restart service
```

---

## Spotify setup notes

- Needs a **Spotify Premium** account
- Spotify must be **open and active** on the bar machine for queue requests to work
- In Spotify Developer Dashboard, set Redirect URI to:
  ```
  https://jukebox.kzd:3000/auth/callback
  ```
- Do all Spotify config through the admin panel — no file editing needed
