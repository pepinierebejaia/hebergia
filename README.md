# Hebergia

Local Electron application for university residence management.

## Project layout

- `src/main/` contains Electron startup, IPC handlers, and the Realm database.
- `src/preload/` exposes the renderer's restricted Electron bridge.
- `src/renderer/index.html` contains the application UI.
- `src/renderer/performance-utils.mjs` contains small, independently tested render helpers.
- `test/` contains Node.js regression tests.

## Development

- `npm run dev` starts the Vite renderer server.
- `npm start` builds the renderer and launches Electron.
- `npm run build:renderer` builds the renderer for packaging.
- `npm test` runs the regression tests.

The resident list renders 50 rows per page by default and supports 25- or 100-row pages.

## Data backups

New and changed passwords are stored as salted PBKDF2-SHA256 hashes rather than plaintext. Existing plaintext passwords are upgraded to hashes after the account signs in successfully. Until then, backups may still contain plaintext passwords for accounts that have not signed in since this protection was added; store all backup files securely. Password hashes are not a replacement for operating-system access controls or encrypted backups.

Use **Settings → Data and Backups** to export or restore a complete JSON backup. Restore validates the backup structure, duplicate identifiers and matricules, room capacities, and resident room assignments before asking to replace local data. Resident photo files stored in the separate photo directory are not included; restore files are limited to 100 MB.

## Annual renewals

The **Renouvellements** view manages university-year campaigns and each resident’s annual housing dossier. “À renouveler” is shown only while a campaign is open; when a campaign is closed, unfinished dossier states display as “Traité / renouvelé” without erasing the recorded workflow or explicit decisions. An active resident assigned to a room is considered already installed, so the displayed assignment is confirmed and the key status is **Clé remise**. Closing an accepted dossier records the resident’s current room as the renewed assignment when no move is pending. The app does not maintain a separate key inventory; any later key return is recorded on the renewal dossier.

When the Realm schema is upgraded for campaigns, the app first preserves the existing database as `hebergia.realm.pre-renewal-v15.bak` in the application’s user-data folder and verifies it against a SHA-256 sidecar file. If the backup is missing or fails verification, startup stops before migration. Keep both files until the upgraded data has been verified. Legacy campaign dates are left blank rather than inferred; an administrator can enter the current campaign’s dates before opening it.
