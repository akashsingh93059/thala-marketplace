# DIVI Chennai

DIVI is a hyperlocal marketplace for Chennai with three things in one place:

- **Rooms** — list and find rooms for rent
- **Shops** — discover local shops and services
- **Buy/Sell** — post and browse second-hand items

What makes it different from the usual classifieds:

- **Mobile numbers are private.** Posters provide a mobile to DIVI, but other users never see it. Only DIVI staff (you and your employees) can see and contact posters.
- **"Interested" button** sends an interested user's name + mobile to staff.
- **Built-in chat** between staff and any user (poster or interested). Two regular users cannot chat each other.
- **Service area locked to Chennai.** Locations are picked from a list of areas (T. Nagar, Adyar, Velachery, etc.) — extend the list in `backend/server.js`.

## Folder layout

```
divi-project/
├── backend/                   Node.js + Express API + MongoDB
│   ├── server.js
│   ├── package.json
│   ├── .env.example           copy to .env and fill in
│   ├── .env                   local config — never commit
│   └── employees.json         staff accounts (plaintext, never commit)
├── frontend/
│   ├── public/
│   │   └── index.html         the whole UI (React via CDN)
│   ├── serve.js               zero-dep static server
│   └── package.json
├── start.bat                  one-click Windows launcher
└── README.md
```

## Prerequisites

- Node.js LTS (18 or newer)
- MongoDB (local install, or MongoDB Atlas and update `MONGO_URI`)

## Quick start (Windows)

1. Make sure MongoDB is running (`net start MongoDB` as admin, or run `mongod`).
2. Edit `backend/.env` and set a strong `JWT_SECRET`. Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
3. Edit `backend/employees.json` and change the default passwords for your staff.
4. Double-click `start.bat`. It installs the backend, starts both servers, and opens the browser.

## Manual start

```
cd backend
npm install
npm start                      # http://localhost:5000

cd ../frontend
npm start                      # http://localhost:5500
```

## Staff accounts (`backend/employees.json`)

Staff log in with the same form as regular users. There are two roles:

- `isAdmin: true` — you, the owner. Full admin panel.
- `isAdmin: false` — employee. Sees private mobile numbers, can chat with users, can see interest lists. Cannot delete users.

To add or remove staff, just edit `backend/employees.json` and save it. The server reloads automatically (no restart needed).

```json
{
  "employees": [
    { "name": "Akash (Owner)", "email": "akash@divi.local", "password": "change-me", "isAdmin": true },
    { "name": "Employee 1",    "email": "emp1@divi.local",  "password": "change-me", "isAdmin": false }
  ]
}
```

**Important:** passwords are stored plaintext in this file by design (so you can edit it). Keep the file off git, off cloud sync, off shared drives. The file is gitignored.

## Roles cheat sheet

| Action                                | Public | Logged-in user | Employee | Admin (owner) |
| ------------------------------------- | :----: | :------------: | :------: | :-----------: |
| Browse listings                       |   ✓    |       ✓        |    ✓     |       ✓       |
| Post / edit own listing               |   —    |       ✓        |    —     |       —       |
| See listers' mobile numbers           |   —    |       —        |    ✓     |       ✓       |
| Mark "Interested" on a listing        |   —    |       ✓        |    —     |       —       |
| See interested users' names + mobiles |   —    |       —        |    ✓     |       ✓       |
| Chat with users                       |   —    |   only with staff   |    ✓     |       ✓       |
| Delete any listing                    |   —    |       —        |    —     |       ✓       |
| Delete users                          |   —    |       —        |    —     |       ✓       |

## API surface (short version)

Public:
- `GET  /api/health`, `GET /api/areas`, `GET /api/staff/list`
- `POST /api/register`, `POST /api/login`
- `GET  /api/rooms` (filters: `search`, `city`, `maxRent`, `minRent`)
- `GET  /api/rooms/:id` (increments `views`)
- `GET  /api/shops` (filters: `search`, `city`)
- `GET  /api/buy-sell` (filters: `category`, `search`, `city`)

Authenticated user:
- `GET  /api/verify-token`, `GET /api/user/listings`, `PUT /api/me`
- `POST /api/rooms`, `PUT/DELETE /api/rooms/:id`
- `POST /api/shops`, `PUT/DELETE /api/shops/:id`
- `POST /api/buy-sell`, `PUT/DELETE /api/buy-sell/:id`
- `POST /api/listings/:type/:id/interest`, `DELETE /api/listings/:type/:id/interest`
- `GET  /api/my-interests`
- `POST /api/messages`, `GET /api/messages/threads`, `GET /api/messages/with/:peer`

Staff (employee or admin):
- `GET  /api/listings/:type/:id/interests`
- `GET  /api/staff/contacts`

Admin only:
- `GET  /api/admin/users`, `DELETE /api/admin/users/:id`

All list endpoints return `{ data, page, limit, total, totalPages }`.

## Adding more Chennai areas

Open `backend/server.js`, find the `CHENNAI_AREAS` array near the top, add your area name, save, restart. The frontend pulls the list from the API automatically.

## What's *not* in here

This is a working business MVP, not a finished product. Before going live you'll want at least:

- HTTPS termination (a reverse proxy like nginx or a host like Render / Railway / Fly)
- A managed MongoDB (Atlas) with real backups
- File/image upload (currently image URLs only)
- SMS OTP for mobile verification (Msg91 / Twilio) so the mobiles you collect are actually real
- Email verification on signup + password reset
- Logging / monitoring (pino, Sentry)

The code is structured so each of those can be added without rewriting what's here.
