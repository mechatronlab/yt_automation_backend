# VPN Controller (Node.js)

Connect and disconnect a VPN from Node.js or the command line. Supports:

| Provider   | Platform   | Requires                          |
|-----------|------------|-----------------------------------|
| `macos`   | macOS      | VPN profile in System Settings    |
| `wireguard` | Linux/macOS | `wg-quick`, often `sudo`        |
| `openvpn` | Linux/macOS | `openvpn` installed             |

## Setup

1. Copy the example config:

   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` for your VPN type.

### macOS (built-in VPN profile)

List VPN service names:

```bash
scutil --nc list
```

`config.json`:

```json
{
  "provider": "macos",
  "serviceName": "My VPN"
}
```

### WireGuard

```json
{
  "provider": "wireguard",
  "wireguard": {
    "configPath": "/etc/wireguard/wg0.conf"
  }
}
```

WireGuard usually needs root: `sudo npm run connect`

### OpenVPN

Homebrew installs `openvpn` under `sbin`, which is often not on your `PATH`. The app auto-detects `/usr/local/opt/openvpn/sbin/openvpn` and `/opt/homebrew/opt/openvpn/sbin/openvpn`, or set `binary` explicitly:

```json
{
  "provider": "openvpn",
  "openvpn": {
    "binary": "/usr/local/opt/openvpn/sbin/openvpn",
    "configPath": "./client.ovpn",
    "pidFile": "./.openvpn.pid"
  }
}
```

Optional: add to `~/.zshrc` so `which openvpn` works in the terminal:

```bash
export PATH="/usr/local/opt/openvpn/sbin:$PATH"
```

## Commands

```bash
npm run connect
npm run disconnect
npm run status
```

Or use the module:

```js
import { connect, disconnect, status } from "./src/vpn.js";

await connect();
await disconnect();
const { connected } = await status();
```

## OpenVPN Cloud / Connect (recommended for meclayt.openvpn.com)

Profiles from **OpenVPN Cloud** use SSO and do **not** work with community `openvpn` (Homebrew). Use the **OpenVPN Connect** app instead.

1. Install [OpenVPN Connect](https://openvpn.net/client/) for macOS.
2. List profiles and copy the `id`:

   ```bash
   "/Applications/OpenVPN Connect/OpenVPN Connect.app/Contents/MacOS/OpenVPN Connect" --list-profiles
   ```

3. Set `config.json`:

   ```json
   {
     "provider": "connect",
     "connect": {
       "profileId": "1780337196184",
       "profilePath": "./your-profile.ovpn"
     }
   }
   ```

4. Connect / disconnect:

   ```bash
   npm run connect
   npm run disconnect
   ```

This uses `--connect-shortcut` / `--disconnect-shortcut` (opens the Connect app briefly).

## OpenVPN Access Server (e.g. meclayt.openvpn.com)

Your server URL is the **user portal**, not the config file itself. You need a **profile** (`.ovpn`) tied to your account.

### Option A — Browser (recommended first time)

1. Open [https://meclayt.openvpn.com/](https://meclayt.openvpn.com/) in a browser.
2. Sign in with the username/password from your VPN admin.
3. Download your connection profile (wording varies: **Yourself**, **User-locked profile**, **Download profile**, etc.).
4. Save the file as `client.ovpn` in this project folder.
5. Run `npm run connect`.

If the profile uses username/password, create `auth.txt` (two lines: username, then password) and add to `client.ovpn`:

```
auth-user-pass auth.txt
```

Add `auth.txt` to `.gitignore` (already ignored if you use `*.ovpn` patterns — add `auth.txt` explicitly).

### Option B — Script (Access Server REST API)

If your server allows API login for your user:

```bash
export OPENVPN_SERVER="https://meclayt.openvpn.com"
export OPENVPN_USER="your_username"
export OPENVPN_PASS="your_password"
chmod +x scripts/download-profile.sh
./scripts/download-profile.sh
npm run connect
```

If the script fails, use Option A — some servers disable REST profile download.

## Permissions

- **macOS system VPN**: no extra install; profile must exist in System Settings → VPN.
- **WireGuard / OpenVPN**: CLI tools on `PATH`; WireGuard often needs `sudo`.
- **OpenVPN client profiles** may require `sudo npm run connect` on macOS for tun device access.
