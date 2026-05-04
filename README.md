Roll & Roam — White Elephant

Quick Start (run on macOS with Node + Expo CLI installed)

1. Install dependencies

```bash
cd /Users/u0183748/Documents/Symposium_App
npm install
```

2. Start Expo (LAN mode)

```bash
npm run start
```

Open in Expo Go on iOS/Android or run on simulators with `npm run ios` / `npm run android`.
Make sure your device is on the same Wi-Fi network for LAN mode.

Web App (local)

```bash
npm run web
```

Open http://localhost:19006

Notes
- Colors approximate vib.ai; tweak `vibColors` in `App.js` to match exact hexes.
- This prototype stores state locally via `AsyncStorage`. For production, add a backend to coordinate registrations, persistent leaderboards, and admin scheduling.
- Admin mode is toggled by the small button next to the name input.

Features implemented
- 4 rooms (A-D), 10 slots each
- 4 sessions (S1-S4) with separate rooms and leaderboards
- Join/Leave registration per session (local)
- 15-minute session timer with Start/Stop
- In-app `ROLL` with outcomes for 1 (CLAIM) and 6 (STEAL)
- Leaderboard per session (local)
- Admin controls for active session, registration open/close, session reset
- Admin topics per room and registration scheduling

Next steps I can implement
- Real-time backend (Firebase or socket server) for multi-device sync
- Sound playback for reveal using Expo AV
- Permanent user accounts and registration verification

Supabase real-time sync (multi-browser)

1. Create a Supabase project and copy the Project URL and anon key.
2. Add env vars before running the web app:

```bash
export EXPO_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export EXPO_PUBLIC_SUPABASE_ANON_KEY="YOUR_ANON_KEY"
```

3. Create the state table in Supabase SQL editor:

```sql
create table if not exists game_state (
	id int primary key,
	state jsonb not null,
	updated_at timestamptz default now()
);

alter table game_state enable row level security;

create policy "public read" on game_state for select using (true);
create policy "public insert" on game_state for insert with check (true);
create policy "public update" on game_state for update using (true);
```

GitHub Pages deploy

1. Ensure `app.json` has `web.publicPath` set to `./` for relative assets.
2. Push to GitHub and enable Pages (GitHub Actions) in repo settings.
3. Add repo secrets:
	- `EXPO_PUBLIC_SUPABASE_URL`
	- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
4. The workflow builds and deploys the web app automatically.
