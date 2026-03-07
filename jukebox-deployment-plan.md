# Jukebox Deployment Plan

## Goal
Publish the jukebox app to a public GitHub repo with MIT license, set it up as a systemd service that auto-starts on boot, and give staff a one-click "Update Jukebox" trigger — so you can deploy remotely over text.

## Design Reference
- Repo: public GitHub, MIT license, .env.example, .gitignore
- **Branch strategy:**
  - `main` — production, targets Ubuntu bar machine (system-level systemd, `.desktop` shortcut)
  - `arch` — dev/testing branch, targets your Arch/Hyprland machine (user-level systemd, rofi launcher)
  - Develop on `arch`, merge to `main` when ready to ship
- Bar machine: `/home/username/jukebox`, Node/Express, HTTPS self-signed
- Service: systemd unit, auto-start on boot, restart on crash
- Updates: `update.sh` script → git pull + npm install + service restart
- Staff UX (Ubuntu/main): `.desktop` shortcut, you text them to press it
- Dev UX (Arch/arch): rofi launcher entry

---

## Phase 1: Prepare the Repo Locally

### Task 1: Create `.gitignore`
- **Action:** Create `.gitignore` in project root
- **Location:** `/home/username/jukebox/.gitignore`
- **Details:** Include at minimum:
  ```
  node_modules/
  .env
  certs/
  *.pem
  *.key
  *.crt
  npm-debug.log
  ```
- **Verify:** `git status` doesn't show node_modules, .env, or cert files as untracked

### Task 2: Create `.env.example`
- **Action:** Create `.env.example` documenting all required env vars without real values
- **Location:** `/home/username/jukebox/.env.example`
- **Details:** Copy the structure of your real `.env`, replace all values with placeholders:
  ```
  SPOTIFY_CLIENT_ID=your_spotify_client_id
  SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
  SPOTIFY_REDIRECT_URI=https://localhost:3000/callback
  ADMIN_PASSWORD_HASH=bcrypt_hash_of_your_password
  PORT=3000
  ```
  (add/remove vars to match your actual .env)
- **Verify:** File exists, contains no real secrets, covers every var the app uses

### Task 3: Add MIT License file
- **Action:** Create `LICENSE` file in project root
- **Location:** `/home/username/jukebox/LICENSE`
- **Details:** Use the standard MIT text — replace `[year]` and `[your name]`:
  ```
  MIT License

  Copyright (c) 2025 [Your Name]

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```
- **Verify:** File exists at project root

### Task 4: Create `README.md`
- **Action:** Write a minimal README so the repo is usable by others
- **Location:** `/home/username/jukebox/README.md`
- **Details:** Include:
  - What it is (Spotify jukebox for bars)
  - Prerequisites (Node.js, Spotify Developer App, self-signed cert)
  - Setup steps: clone → copy .env.example to .env → fill in values → npm install → generate cert → npm start
  - Link to Spotify Developer Dashboard for API credentials
- **Verify:** README renders cleanly on GitHub, setup steps are complete

---

## Phase 2: Push to GitHub

### Task 5: Create the GitHub repo
- **Action:** Go to github.com → New repository
- **Details:**
  - Name: `jukebox` (or `bar-jukebox`, your call)
  - Visibility: **Public**
  - Do NOT initialize with README (you already have one)
  - No template
- **Verify:** Empty repo created, you have the remote URL (e.g. `git@github.com:username/jukebox.git`)

### Task 6: Initialize git and push
- **Action:** From `/home/username/jukebox` on your machine:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git branch -M main
  git remote add origin git@github.com:USERNAME/jukebox.git
  git push -u origin main
  ```
- **Verify:** Repo on GitHub shows your files. Confirm node_modules, .env, and certs are absent.

### Task 6b: Create the `arch` branch
- **Action:**
  ```bash
  git checkout -b arch
  git push -u origin arch
  ```
- **Details:** All testing work happens on `arch`. When a feature is stable, merge to `main`:
  ```bash
  git checkout main
  git merge arch
  git push
  ```
- **Verify:** GitHub shows both `main` and `arch` branches. You are currently on `arch`.

---

## Phase 3: First-Time Setup — Arch (Testing)

> You are on the `arch` branch for all of Phase 3–5.

### Task 7: Install dependencies and set up `.env` locally
- **Action:** From your Arch machine:
  ```bash
  cd /home/username/jukebox
  npm install --production
  cp .env.example .env
  nano .env   # fill in real Spotify credentials etc.
  ```
- **Verify:** `node server.js` starts without errors, app reachable at `https://localhost:3000`

### Task 8: Ensure certs exist
- **Action:**
  ```bash
  mkdir -p certs
  openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem \
    -days 3650 -nodes -subj "/CN=localhost"
  ```
- **Details:** 10-year cert so it never expires and breaks things
- **Verify:** `certs/key.pem` and `certs/cert.pem` exist, app starts on HTTPS

---

## Phase 4: systemd Service — Arch (User Service)

> User-level service — no sudo needed, lives in `~/.config/systemd/user/`

### Task 9: Create the user systemd unit file
- **Action:**
  ```bash
  mkdir -p ~/.config/systemd/user
  nano ~/.config/systemd/user/jukebox.service
  ```
  Contents:
  ```ini
  [Unit]
  Description=Bar Jukebox (dev)
  After=network.target

  [Service]
  Type=simple
  WorkingDirectory=/home/username/jukebox
  ExecStart=/usr/bin/node server.js
  Restart=on-failure
  RestartSec=5
  EnvironmentFile=/home/username/jukebox/.env

  [Install]
  WantedBy=default.target
  ```
  Replace `server.js` with your actual entry point. Verify `node` path with `which node` — if using nvm use the full resolved path.
- **Verify:** File saved at `~/.config/systemd/user/jukebox.service`

### Task 10: Enable and start the user service
- **Action:**
  ```bash
  systemctl --user daemon-reload
  systemctl --user enable jukebox
  systemctl --user start jukebox
  ```
- **Verify:**
  ```bash
  systemctl --user status jukebox
  ```
  Shows `active (running)`. App reachable at `https://localhost:3000`.

### Task 10b: Enable lingering (so service starts on boot without login)
- **Action:**
  ```bash
  sudo loginctl enable-linger $USER
  ```
- **Verify:** After reboot, `systemctl --user status jukebox` shows running without you manually starting it

---

## Phase 5: Update Script + Rofi Launcher — Arch

### Task 12: Create `update.sh` (arch branch version)
- **Action:** Create `/home/username/jukebox/update.sh`
- **Details:**
  ```bash
  #!/bin/bash
  set -e

  echo "Pulling latest code from arch branch..."
  cd /home/username/jukebox
  git pull origin arch

  echo "Installing dependencies..."
  npm install --production

  echo "Restarting jukebox service..."
  systemctl --user restart jukebox

  echo "Done! Jukebox updated and restarted."
  ```
- **Verify:** `chmod +x update.sh`, then run it manually — service restarts, no password prompt

### Task 13: Add rofi launcher entry
- **Action:** Create a `.desktop` file in `~/.local/share/applications/`:
  ```bash
  nano ~/.local/share/applications/jukebox-update.desktop
  ```
  Contents:
  ```ini
  [Desktop Entry]
  Version=1.0
  Type=Application
  Name=Update Jukebox
  Comment=Pull latest arch branch and restart service
  Exec=bash -c '/home/username/jukebox/update.sh 2>&1 | tee /tmp/jukebox-update.log; echo "Press Enter to close"; read'
  Terminal=true
  Icon=system-software-update
  Categories=Utility;
  ```
- **Details:** Rofi picks up `.desktop` files from `~/.local/share/applications/` automatically. The `Terminal=true` line opens your default terminal emulator so you can see the output.
- **Verify:** Open rofi (your normal app launcher), type "Update Jukebox" — it appears and runs correctly when selected

---

## Phase 5b: Ubuntu Bar Machine Notes (main branch — do later, on-site)

> When you're ready to set up the bar machine, switch to `main` and use these variants instead:

- **systemd:** System-level service at `/etc/systemd/system/jukebox.service` with `User=username` and `WantedBy=multi-user.target` — enable with `sudo systemctl enable jukebox`
- **update.sh:** Change `git pull origin arch` → `git pull origin main`, change `systemctl --user restart` → `sudo systemctl restart jukebox`
- **sudoers:** Add `username ALL=(ALL) NOPASSWD: /bin/systemctl restart jukebox`
- **Shortcut:** `.desktop` file on `~/Desktop/` instead of `~/.local/share/applications/`

---

## Phase 6: Your Deploy Workflow (ongoing)

**Testing on Arch (`arch` branch):**
1. Make changes locally
2. `git add . && git commit -m "description" && git push origin arch`
3. Run "Update Jukebox" from rofi to pull and restart

**Shipping to the bar (`main` branch):**
1. When feature is stable on `arch`:
   ```bash
   git checkout main
   git merge arch
   git push origin main
   git checkout arch
   ```
2. Text the bar: "Hey, press Update Jukebox when you get a chance"
3. Done

---

## Risks / Notes

- **`node` path:** Task 9 uses `/usr/bin/node` — verify with `which node`. If using nvm, use the full resolved path (e.g. `/home/username/.nvm/versions/node/v20.x.x/bin/node`)
- **Entry point:** Replace `server.js` in the unit file with your actual server entry point filename
- **git pull auth:** Public repo + `https://` clone = no credentials needed for pull
- **Cert paths:** Make sure `.env` cert path references match where certs live (Task 8)
- **Rofi terminal:** `Terminal=true` in the `.desktop` file uses your default terminal emulator — if rofi doesn't open a terminal, check that `$TERM` or `x-terminal-emulator` is set correctly on your system
