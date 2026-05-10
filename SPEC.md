# DIVI Chennai — Full Spec / Reconstruction Prompt

This is the single prompt/spec you can hand to an AI or developer to rebuild this exact app from scratch. Everything below describes what currently exists in the codebase.

---

## 1. Concept

DIVI Chennai is a hyperlocal web platform centered on **local shops** in Chennai, India. The unique twist: every shop has a **Hall of Fame** showing past people who came to "work a day" at the shop — to overcome social anxiety, learn to sell, face customers — and a **booking system** where new people can request a work-day at any shop. The platform is moderated by an **owner** (you) and **employees** (your staff).

It also keeps a private **mobile-numbers-are-staff-only** policy: posters provide a mobile, but only DIVI staff can see it. Other users can express interest and chat with staff; they cannot directly contact each other.

Underneath it also has hidden Posts (rooms / buy-sell items) and Community chat features that are dormant in the UI but can be re-enabled.

## 2. Tech stack

- **Backend**: Node.js + Express + MongoDB (Mongoose). Single-file `server.js`. Auth via JWT. File uploads via multer (local disk). Helmet + rate limiting + express-validator. Google Sign-In via `google-auth-library`.
- **Frontend**: Single-file React via CDN (`react@18`, `react-dom`, `@babel/standalone`, `axios`, Tailwind via CDN, Leaflet for maps via CDN, Google Identity Services via CDN). React 18 `createRoot`. No build step.
- **Frontend serving**: tiny zero-dep Node static server (`frontend/serve.js`) on port 5500.
- **Backend port**: 5000.
- **Free services**: MongoDB local, Leaflet+OSM (no API key), Google Sign-In Client ID (free), local disk for uploads.

## 3. Roles

1. **Public** — anyone, not signed in. Can browse approved shops, see Hall of Fame strip, see reviews. Cannot post or chat.
2. **User** — signed in via Google Sign-In OR email+password. Provides mobile number once at signup. Can: list shops (go to pending), book a work-day at any shop, write/update reviews on any shop, chat with staff, mark interest on hidden Posts.
3. **Employee** — staff entry in `backend/employees.json`. Sees private mobile numbers, can chat with users, can see all bookings/interests, cannot post listings, cannot delete users or shops.
4. **Admin (Owner)** — staff entry in `employees.json` with `isAdmin: true`. Full control: approve/reject shops (auto-assigns Shopper ID like `DIVI-SHOP-0001`), approve/reject Hall of Fame entries, manage employees (CRUD), manage users (search/suspend/delete), delete any review, list shops directly (auto-approved), create bookings on behalf of users, create users manually.

## 4. Authentication flow

- **Google Sign-In** (primary) — frontend uses Google Identity Services to get an ID token, posts to `/api/auth/google`. Backend verifies via `google-auth-library` against `GOOGLE_CLIENT_ID`. If first sign-in for a user, backend returns `{ needsMobile: true }`. Frontend asks for mobile, re-posts with mobile. Backend creates user, returns app JWT.
- **Email + password** (fallback) — for staff (matches `employees.json` entries) and any users created manually. Posts to `/api/login`. Returns JWT.
- **Staff override**: if a Google email matches a staff entry, signing in with that Google account returns a staff JWT. Staff emails cannot sign up as regular users.

## 5. Data models (MongoDB via Mongoose)

```
User       { name, email (unique), mobile, password?, googleId?, picture?, isAdmin, suspended, emailVerified }
Post       { category, title, description, price, isRent, location, mobile, contact, image, views, userId } [HIDDEN UI]
Shop       { name, description, category, location, address, lat, lng, mobile, image, status (pending|approved|rejected), shopperId, rejectReason, approvedAt, rating, reviewCount, userId }
Review     { shopId, userEmail, userName, rating (1-5), comment }  [unique on shopId+userEmail]
Interest   { postId, userEmail, userName, userMobile, note }  [unique on postId+userEmail]
Message    { from, to, postId?, body, readAt }   (1-to-1 chat between user and staff)
Community  { area, from, name, picture, body, expiresAt (TTL 30d) }  [HIDDEN UI]
HoF        { shopId, shopName, personName, personEmail?, workedFrom, workedTo, soldAmount, earnedAmount, description, image, approved, addedBy, addedByRole }
Booking    { shopId, shopName, shopOwner, requesterEmail, requesterName, requesterMobile, date, reason, status (pending|approved|rejected|done|cancelled), ownerNote }
Counter    { _id, seq }   (used for shopperId sequence)
```

## 6. Chennai areas (hardcoded list)

```
Adyar, Alwarpet, Anna Nagar, Ashok Nagar, Besant Nagar, Chetpet, Chromepet, Egmore,
George Town, Guindy, Kilpauk, Kodambakkam, Kotturpuram, Mylapore, Nungambakkam,
OMR, Pallavaram, Perungudi, Porur, Royapettah, Saidapet, Sholinganallur, T. Nagar,
Tambaram, Teynampet, Thiruvanmiyur, Tiruvallur, Triplicane, Vadapalani, Velachery,
Villivakkam, Virugambakkam, West Mambalam
```

Locations in shops/posts must be in this list (validated by backend).

## 7. Backend endpoints

Public:
- `GET /api/health`, `GET /api/areas`, `GET /api/categories`, `GET /api/staff/list`, `GET /api/auth/config`
- `GET /api/shops` (filters: category, city, search), `GET /api/shops/:id`, `GET /api/shops/:id/reviews`
- `GET /api/hall-of-fame?shopId=` (only approved)
- `GET /api/posts` (hidden in UI but works), `GET /api/posts/:id`, `GET /api/community?area=`

Auth:
- `POST /api/login`, `POST /api/auth/google`, `GET /api/verify-token`, `PUT /api/me`

User:
- `GET /api/user/listings`, `GET /api/my-interests`
- `POST /api/posts`, `PUT/DELETE /api/posts/:id`, `POST/DELETE /api/posts/:id/interest`
- `POST /api/shops`, `PUT/DELETE /api/shops/:id`
- `POST/DELETE /api/shops/:id/reviews`(/me)
- `POST /api/hall-of-fame` (shop owner OR admin), `DELETE /api/hall-of-fame/:id`
- `PUT /api/hall-of-fame/:id/approve` (shop owner OR admin)
- `POST /api/bookings`, `PUT /api/bookings/:id`
- `POST /api/messages`, `GET /api/messages/threads`, `GET /api/messages/with/:peer`
- `POST /api/community`, `DELETE /api/community/:id`
- `POST /api/upload` (multer image upload, 5MB max, returns `{url}` like `/uploads/<file>`)

Staff (admin OR employee):
- `GET /api/staff/contacts`
- `GET /api/posts/:id/interests`, `GET /api/listings/:type/:id/interests`
- `GET /api/shops/:id/bookings`

Admin only:
- `GET /api/admin/shops/pending`, `PUT /api/admin/shops/:id/approve` (auto-assigns shopperId), `PUT /api/admin/shops/:id/reject`
- `GET /api/admin/hall-of-fame/pending`, `PUT /api/admin/hall-of-fame/:id/approve`
- `GET /api/admin/bookings`, `POST /api/admin/bookings` (create on behalf)
- `GET /api/admin/users`, `POST /api/admin/users` (create manually), `PUT /api/admin/users/:id/suspend`, `DELETE /api/admin/users/:id` (cascades all data)
- `GET /api/admin/employees`, `POST /api/admin/employees`, `PUT /api/admin/employees/:email`, `DELETE /api/admin/employees/:email`
- `DELETE /api/admin/reviews/:id` (recomputes shop rating)
- `GET /api/admin/stats`

All list endpoints return `{ data, page, limit, total, totalPages }` with `?page=&limit=` (max 50).

## 8. Frontend pages / components

**Header**: DIVI logo (inline SVG), name + tagline. When logged in: Browse, My Listings, Staff (staff only), Owner (admin only), Chat (with unread badge), Logout. When logged out: Sign in.

**Home (`view='main'`)**:
- Hero gradient banner with "Local shops. Real people. Step out of comfort zone."
- **Hall of Fame strip** — horizontal scroll, max 12 approved entries with photo, name, shop, description, sold/earned amounts.
- Search bar + Chennai area dropdown + max-price filter (max-price hidden in shops mode).
- Category chips (All + shop categories: food, grocery, salon, pharmacy, clothing, electronics, services, other).
- Shops grid (3 columns) showing card with image, category badge, Shopper ID badge, name, description, ⭐ rating, review count, area.
- Click card → ShopDetailModal.

**ShopDetailModal**:
- Name, Shopper ID (mono font), star rating + count, category badge, image
- Description, area, address, mobile (only if staff)
- Read-only Leaflet map with marker
- Action buttons: "+ Book a work-day" (regular users), "+ Add Hall of Fame" (shop owner or admin), "Message DIVI staff" (regular users)
- Booking form (collapsible): date picker, reason textarea
- HoFForm (collapsible, owner/admin): person name, email, dates, sold ₹, earned ₹, description, photo upload
- Hall of Fame entries grid for this shop (approved only)
- Review form (regular users): 5-star picker, comment, submit/update/delete
- Reviews list with admin-only Delete link per review

**Modal (post or shop)**:
- For shop: name, description, category, area dropdown, address, **Leaflet map with draggable pin**, mobile, image upload (file picker → POST /api/upload → URL), pending notice (or "auto-approved" notice for owner)
- For post: title, description, category, price, area, mobile, contact, image — hidden from UI in current mode

**My Listings (`view='profile'`)**:
- Profile (name + mobile editable, email read-only)
- My posts list
- My shops list with status badges (pending/approved/rejected) and reject reason if any
- My interests
- My bookings (date, shop, status)

**Staff dashboard (`view='staff'`)**:
- Tabs: Posts & interests / Shops / All contacts
- Each row: details + 📞 mobile + Chat button + WhatsApp link (`https://wa.me/<mobile>`)
- Expandable "Show interests" per post

**Owner dashboard (`view='admin'`)**:
- Tabs: Overview / Pending shops / Hall of Fame / Bookings / Users / Employees
- **Overview**: stats cards for users, employees, shops, pending, reviews, hof, hofPending, bookings
- **Pending shops**: yellow cards with shop info, map coords if any, Approve (assigns shopperId) / Reject (with reason prompt)
- **Hall of Fame**: pending entries, Approve to feature on home / Delete
- **Bookings**: full table across shops, Approve/Reject/Mark-done buttons + WhatsApp
- **Users**: searchable table, post/shop counts, Suspend toggle, Delete (cascades)
- **Employees**: CRUD form (add/edit/remove), reflects in `employees.json`

**Auth Modal**: Google Sign-In button (auto-rendered via GIS) + email/password fallback. After Google sign-in, asks for mobile if first time.

**Chat Drawer**: floating panel bottom-right. Threads list + click → 1-to-1 chat with polling every 4s. Unread badge in header.

## 9. Configuration

`backend/.env`:
```
PORT=5000
MONGO_URI=mongodb://localhost:27017/divi
JWT_SECRET=<long random>
JWT_EXPIRES_IN=7d
CORS_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
BCRYPT_ROUNDS=10
GOOGLE_CLIENT_ID=<your Google OAuth Web Client ID>
```

`backend/employees.json` (gitignored, plaintext passwords):
```json
{
  "_comment": "DIVI staff. Edit via Owner dashboard.",
  "employees": [
    { "name": "Owner Name", "email": "owner@example.com", "password": "...", "isAdmin": true },
    { "name": "Employee 1",  "email": "emp1@example.com",  "password": "...", "isAdmin": false }
  ]
}
```
File is hot-reloaded (`fs.watchFile`).

`backend/uploads/` — directory for uploaded images, served at `/uploads/<file>`. Created on boot if missing.

## 10. Build / run

```
cd backend
npm install
npm start          # http://localhost:5000

cd ../frontend
npm start          # http://localhost:5500
```

Windows convenience: `start.bat` at repo root opens both terminals + browser.

## 11. Google Cloud setup (one-time)

1. console.cloud.google.com → New Project "DIVI"
2. APIs & Services → OAuth consent screen → External → fill details → Save
3. Credentials → CREATE CREDENTIALS → OAuth client ID → Web application → name "DIVI Web"
4. Authorized JavaScript origins: `http://localhost:5500` and `http://127.0.0.1:5500`
5. Copy Client ID into `backend/.env` as `GOOGLE_CLIENT_ID`
6. (Production) Add deployed origin too. Publish OAuth consent screen.

## 12. Deployment notes (not yet done)

- Backend → Render / Railway / Fly (free or ~₹600/mo)
- Frontend → Vercel / Netlify (free)
- DB → MongoDB Atlas free tier (512 MB)
- Update `CORS_ORIGINS` and Google Authorized origins to deployed URLs
- Set `window.DIVI_API_BASE` in `frontend/public/index.html` to deployed backend URL

## 13. Key business rules / behaviors

- Staff email cannot register as a regular user (reserved).
- Mobile is private to staff. Public listing endpoints strip `mobile` and `contact`.
- Editing an approved shop sends it back to pending unless edited by admin.
- Deleting a user cascades all their posts, shops, reviews, interests, messages, community posts, bookings.
- Deleting a shop deletes its reviews, HoF entries, bookings.
- Shop owner posting HoF for own shop and admin posting HoF auto-approve. Anyone else's HoF goes to admin pending queue.
- Approving a shop assigns sequential `DIVI-SHOP-NNNN` via Counter collection.
- Owner posting a shop directly skips pending and gets shopperId immediately.
- 1-to-1 chat is enforced: at least one of (sender, recipient) must be staff.
- Community chat (hidden) has 30-day TTL via Mongo expires index.

## 14. Known limitations

- Tailwind CDN + Babel-in-browser → ~2-3s first load. For production, convert to Vite build.
- Local file uploads → tied to backend disk. For multi-instance deployment, switch to S3 / Cloudinary.
- No email notifications (could add nodemailer for booking approvals etc).
- No SMS verification (mobile is collected but unverified).
- Owner can edit all shops, but no audit log of who edited what.
- Reviews don't allow images.
- No image cropping / optimization on upload.

---

## How to use this as a prompt

To rebuild this app from scratch with another AI, paste sections 1–13 above and tell it: "Build a single-file Express backend (`server.js`) and a single-file React-via-CDN frontend (`index.html`) implementing the spec above. Backend on port 5000, frontend on port 5500. Output the full files."

That will get you ~95% there. The remaining 5% is fine-tuning the UX details (tab transitions, exact wording, etc.).
