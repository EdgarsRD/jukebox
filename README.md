# Jukebox

Bar song request queue. Patrons connect to WiFi, scan a QR code, search Spotify and queue songs. Bartender manages everything via `/admin`.

---

## How it works

- Runs on a dedicated machine at the bar
- Patrons open `https://your-domain:3000` (via QR code)
- The domain is a local-only name — resolves inside the bar's WiFi only
- Everything (code, config, certs) lives in one folder — portable to any spare machine if needed

---

## Requirements

- Node.js 18+
- openssl
- A Spotify Premium account

---

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:3000/admin` — the setup wizard walks you through everything:

1. Create admin account
2. Configure domain & network
3. Generate SSL certificate
4. Connect Spotify
5. Set queue rules

The server auto-restarts after cert generation and the wizard resumes seamlessly on HTTPS.

---

## Production Setup

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

### 2. Install as a systemd service

```bash
sudo bash scripts/install-service.sh
```

Autostart on boot, auto-restarts on crash or when triggered from the admin panel.

### 3. Run the setup wizard

Open `http://localhost:3000/admin` on the bar machine and follow the wizard. It handles admin account, domain, SSL cert, Spotify, and queue rules — all in one flow.

### 4. Set up local DNS on your router

After the wizard tells you the domain and IP, log into your router admin panel and add a custom DNS record:

```
your-domain  →  192.168.1.50
```

This is usually under: Advanced → DNS → Local DNS Records (varies by router).
Once set, any device on the WiFi can reach the server at `your-domain`.

### 5. Make QR codes

Generate two QR codes to post at the bar:
1. **WiFi** — your router's guest network QR (you already have this)
2. **Jukebox** — points to `https://your-domain:3000`

Patrons will see a one-time "Not Secure" browser warning.
They tap Advanced → Proceed. Never see it again on that device.

---

## Dev Setup

```bash
npm install
npm run dev                  # nodemon — auto-restarts on changes
```

Open `http://localhost:3000/admin` — run through the setup wizard.
The cert covers `localhost` as a SAN, so HTTPS works without any `/etc/hosts` entries.

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

## Emergency Recovery (machine died)

### Option A — USB backup (fastest)

If you have the USB stick with the jukebox folder:

1. Plug USB into any spare Ubuntu machine
2. Run:
   ```bash
   bash scripts/start.sh
   ```
3. Follow prompts — installs service, starts server
4. Open `http://localhost:3000/admin` to verify or reconfigure
5. Update the router's DNS record to point your domain at the new machine's IP

> `config.json`, `cert.pem`, and `key.pem` travel on the USB —
> Spotify auth, password, and rules are all preserved.

### Option B — Fresh machine from GitHub (no USB)

If the USB backup is lost or unavailable:

1. Install Node.js 18+ on the new machine:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
   sudo apt install -y nodejs
   ```
2. Download the latest release `.tar.gz` from **[GitHub Releases](https://github.com/EdgarsRD/jukebox/releases/latest)**
   ```bash
   curl -L -o jukebox-1.0.0.tar.gz https://github.com/EdgarsRD/jukebox/releases/download/v1.0.0/jukebox-1.0.0.tar.gz
   ```
3. Extract and run:
   ```bash
   tar -xzf jukebox-1.0.0.tar.gz
   cd jukebox-*/
   bash scripts/start.sh
   ```
4. Open `http://localhost:3000/admin` — the setup wizard walks you through everything
5. Update the router's DNS record to point your domain at the new machine's IP

> Config will need to be re-entered (admin account, Spotify credentials, rules) since there's no USB backup. The wizard handles all of it.

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
├── config.json         — Auto-created by setup wizard (gitignored)
├── cert.pem            — TLS cert (gitignored, travels with app)
├── key.pem             — TLS key (gitignored, travels with app)
├── history.json        — Request history (gitignored)
├── public/
│   └── index.html      — Patron UI (search + queue)
├── admin/
│   ├── index.html      — Admin panel (queue mgmt, Spotify, rules, moderation)
│   └── setup.html      — First-run setup wizard (5-step guided flow)
└── scripts/
    ├── gen-cert.sh         — Generate TLS cert (standalone, wizard uses API instead)
    ├── start.sh            — USB recovery: one command to get back online
    └── install-service.sh  — Install systemd autostart service
```

---

## Spotify setup notes

- Needs a **Spotify Premium** account
- Spotify must be **open and active** on the bar machine for queue requests to work
- The setup wizard tells you the exact Redirect URI to use in the Spotify Developer Dashboard
- Do all Spotify config through the setup wizard or admin panel — no file editing needed
