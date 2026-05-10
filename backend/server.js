// DIVI backend — shops-focused, with map / hall of fame / bookings / image upload

require('dotenv').config();

const fs       = require('fs');
const path     = require('path');
const express  = require('express');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const multer   = require('multer');
const { OAuth2Client } = require('google-auth-library');
const { body, param, query, validationResult } = require('express-validator');

const PORT       = Number(process.env.PORT) || 5000;
const MONGO_URI  = process.env.MONGO_URI || 'mongodb://localhost:27017/divi';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS  = Number(process.env.BCRYPT_ROUNDS) || 10;
const CORS_ORIGINS   = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET is not set.'); process.exit(1); }

const POST_CATEGORIES = ['rooms','electronics','furniture','vehicles','clothing','services','others'];
const SHOP_CATEGORIES = ['street-food','fruits-raw','tiffin'];

const CHENNAI_AREAS = [
  'Adyar','Alwarpet','Anna Nagar','Ashok Nagar','Besant Nagar',
  'Chetpet','Chromepet','Egmore','George Town','Guindy',
  'Kilpauk','Kodambakkam','Kotturpuram','Mylapore','Nungambakkam',
  'OMR','Pallavaram','Perungudi','Porur','Royapettah',
  'Saidapet','Sholinganallur','T. Nagar','Tambaram','Teynampet',
  'Thiruvanmiyur','Tiruvallur','Triplicane','Vadapalani','Velachery',
  'Villivakkam','Virugambakkam','West Mambalam'
];
const CHENNAI_AREAS_SET = new Set(CHENNAI_AREAS.map(a => a.toLowerCase()));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
// helmet but allow cross-origin resources for /uploads
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// Static serve uploads
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', fallthrough: false }));

const authLimiter  = rateLimit({ windowMs: 15*60*1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many auth attempts.' } });
const writeLimiter = rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many requests.' } });
const chatLimiter  = rateLimit({ windowMs: 60*1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Slow down.' } });
const uploadLimiter = rateLimit({ windowMs: 60*1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many uploads.' } });

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  next();
};

mongoose.set('strictQuery', true);
mongoose.connect(MONGO_URI)
  .then(() => { console.log('[mongo] connected'); migrateOldData(); })
  .catch(err => { console.error('[mongo] connection error:', err.message); process.exit(1); });

// ---------- Schemas ----------
const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 80 },
  email:    { type: String, unique: true, required: true, lowercase: true, trim: true, index: true },
  mobile:   { type: String, trim: true, maxlength: 20 },
  password: { type: String },
  googleId: { type: String, index: true, sparse: true },
  picture:  { type: String, maxlength: 500 },
  isAdmin:  { type: Boolean, default: false },
  suspended:{ type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },
}, { timestamps: true });

// Posts unchanged (kept but UI will hide for now)
const postSchema = new mongoose.Schema({
  category:    { type: String, required: true, enum: POST_CATEGORIES, index: true },
  title:       { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  price:       { type: Number, required: true, min: 0 },
  isRent:      { type: Boolean, default: false },
  location:    { type: String, required: true, trim: true, maxlength: 120, index: true },
  mobile:      { type: String, required: true, trim: true, maxlength: 20 },
  contact:     { type: String, trim: true, maxlength: 80 },
  image:       { type: String, trim: true, maxlength: 500 },
  views:       { type: Number, default: 0 },
  userId:      { type: String, required: true, index: true },
}, { timestamps: true });
postSchema.index({ title: 'text', description: 'text', location: 'text' });

// Shop with map (lat/lng), street address, hours, online toggle, and shopperId
const shopSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  category:    { type: String, default: 'fruits-raw', enum: SHOP_CATEGORIES, index: true },
  location:    { type: String, required: true, trim: true, maxlength: 120, index: true },
  address:     { type: String, trim: true, maxlength: 300 },
  lat:         { type: Number, min: -90, max: 90 },
  lng:         { type: Number, min: -180, max: 180 },
  mobile:      { type: String, required: true, trim: true, maxlength: 20 },
  image:       { type: String, trim: true, maxlength: 500 },
  // Hours stored as HH:MM (24-hour). isOnline flips when manually toggled.
  openAt:      { type: String, trim: true, maxlength: 5 },
  closeAt:     { type: String, trim: true, maxlength: 5 },
  isOnline:    { type: Boolean, default: true },
  status:      { type: String, default: 'pending', enum: ['pending','approved','rejected'], index: true },
  shopperId:   { type: String, index: true, sparse: true },
  rejectReason:{ type: String, trim: true, maxlength: 280 },
  approvedAt:  { type: Date },
  rating:      { type: Number, default: 0, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0 },
  userId:      { type: String, required: true, index: true },
}, { timestamps: true });
shopSchema.index({ name: 'text', description: 'text' });

const reviewSchema = new mongoose.Schema({
  shopId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userEmail: { type: String, required: true, index: true },
  userName:  { type: String, required: true },
  rating:    { type: Number, required: true, min: 1, max: 5 },
  comment:   { type: String, trim: true, maxlength: 1000 },
  likes:     [{ type: String, lowercase: true }], // User emails
  replies:   [{
    from: String, name: String, body: String, createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });
reviewSchema.index({ shopId: 1, userEmail: 1 }, { unique: true });

const interestSchema = new mongoose.Schema({
  postId:    { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userEmail: { type: String, required: true, index: true },
  userName:  { type: String, required: true },
  userMobile:{ type: String, required: true },
  note:      { type: String, trim: true, maxlength: 280 },
}, { timestamps: true });
interestSchema.index({ postId: 1, userEmail: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
  from:      { type: String, required: true, lowercase: true, index: true },
  to:        { type: String, required: true, lowercase: true, index: true },
  postId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  body:      { type: String, required: true, trim: true, maxlength: 2000 },
  readAt:    { type: Date, default: null },
}, { timestamps: true });
messageSchema.index({ from: 1, to: 1, createdAt: -1 });

const communitySchema = new mongoose.Schema({
  area:      { type: String, default: '', index: true },
  from:      { type: String, required: true, lowercase: true, index: true },
  name:      { type: String, required: true, maxlength: 80 },
  picture:   { type: String, maxlength: 500 },
  body:      { type: String, required: true, trim: true, maxlength: 1000 },
  sticker:   { type: String, trim: true, maxlength: 20 },
  likes:     [{ type: String, lowercase: true }], // User emails
  replies:   [{
    from: String, name: String, body: String, sticker: String, createdAt: { type: Date, default: Date.now },
  }],
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30*24*3600*1000), index: { expires: 0 } },
}, { timestamps: true });

// New: Hall of Fame entries (people who worked at a shop for a day)
const hofSchema = new mongoose.Schema({
  shopId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  shopName:    { type: String, required: true },         // snapshot
  personName:  { type: String, required: true, trim: true, maxlength: 80 },
  personEmail: { type: String, lowercase: true, trim: true, maxlength: 120 },
  profession:  { type: String, required: true, trim: true, maxlength: 120 },
  workedFrom:  { type: Date },
  workedTo:    { type: Date },
  soldAmount:  { type: Number, min: 0 },
  earnedAmount:{ type: Number, min: 0 },
  description: { type: String, required: true, trim: true, maxlength: 1500 },
  image:       { type: String, trim: true, maxlength: 500 },
  approved:    { type: Boolean, default: false, index: true },        // admin approves
  addedBy:     { type: String, required: true },                       // email of who added
  addedByRole: { type: String, enum: ['owner','admin','user'], default: 'owner' },
}, { timestamps: true });

// New: Bookings (work-a-day)
const bookingSchema = new mongoose.Schema({
  shopId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  shopName:    { type: String, required: true },
  shopOwner:   { type: String, required: true, lowercase: true },
  requesterEmail: { type: String, required: true, lowercase: true, index: true },
  requesterName:  { type: String, required: true },
  requesterMobile:{ type: String, required: true },
  date:        { type: Date, required: true },
  reason:      { type: String, trim: true, maxlength: 1000 },
  status:      { type: String, default: 'pending', enum: ['pending','approved','rejected','done','cancelled'], index: true },
  ownerNote:   { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

// Events (admin-approved)
const eventSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  area:        { type: String, required: true, trim: true, maxlength: 120, index: true },
  date:        { type: Date, required: true, index: true },
  endDate:     { type: Date },
  image:       { type: String, trim: true, maxlength: 500 },
  approved:    { type: Boolean, default: false, index: true },
  createdBy:   { type: String, required: true },
  venue:       { type: String, trim: true, maxlength: 200 },
}, { timestamps: true });

// Counter for sequential shopper IDs
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});

// Notifications
const notificationSchema = new mongoose.Schema({
  recipientEmail: { type: String, required: true, lowercase: true, index: true },
  type:           { type: String, required: true, enum: ['booking', 'reply', 'like', 'system'] },
  message:        { type: String, required: true },
  read:           { type: Boolean, default: false },
  relatedId:      { type: mongoose.Schema.Types.ObjectId, default: null }, // could be booking ID, review ID, etc.
}, { timestamps: true });

const User      = mongoose.model('User', userSchema);
const Post      = mongoose.model('Post', postSchema);
const Shop      = mongoose.model('Shop', shopSchema);
const Review    = mongoose.model('Review', reviewSchema);
const Interest  = mongoose.model('Interest', interestSchema);
const Message   = mongoose.model('Message', messageSchema);
const Community = mongoose.model('Community', communitySchema);
const HoF       = mongoose.model('HoF', hofSchema);
const Booking   = mongoose.model('Booking', bookingSchema);
const Event     = mongoose.model('Event', eventSchema);
const Counter   = mongoose.model('Counter', counterSchema);
const Notification = mongoose.model('Notification', notificationSchema);

// Site-wide editable config (singleton)
const siteConfigSchema = new mongoose.Schema({
  ownerName:   { type: String, default: '', maxlength: 120 },
  ownerPhone:  { type: String, default: '', maxlength: 20 },
  ownerEmail:  { type: String, default: '', maxlength: 120 },
  instagram:   { type: String, default: '', maxlength: 80 },
  facebook:    { type: String, default: '', maxlength: 200 },
  youtube:     { type: String, default: '', maxlength: 200 },
  tagline:     { type: String, default: '', maxlength: 200 },
  footerNote:  { type: String, default: '', maxlength: 500 },
  address:     { type: String, default: '', maxlength: 300 },
  sections:    [{ title: String, body: String }],
}, { timestamps: true });
const SiteConfig = mongoose.model('SiteConfig', siteConfigSchema);

const Room  = mongoose.connection.collection('rooms');
const Item  = mongoose.connection.collection('items');

async function migrateOldData() {
  try {
    const havePosts = await Post.estimatedDocumentCount();
    if (havePosts > 0) return;
    const oldRooms = await Room.find({}).toArray().catch(() => []);
    const oldItems = await Item.find({}).toArray().catch(() => []);
    if (oldRooms.length === 0 && oldItems.length === 0) return;
    console.log(`[migrate] copying ${oldRooms.length} rooms + ${oldItems.length} items into Posts`);
    const docs = [];
    for (const r of oldRooms) docs.push({
      category: 'rooms', title: r.title, description: r.description, price: r.rent, isRent: true,
      location: r.location, mobile: r.mobile || '', contact: r.contact, image: r.image,
      views: r.views || 0, userId: r.userId, createdAt: r.createdAt, updatedAt: r.updatedAt,
    });
    for (const it of oldItems) docs.push({
      category: it.category && POST_CATEGORIES.includes(it.category) ? it.category : 'others',
      title: it.title, description: it.description, price: it.price, isRent: false,
      location: it.location, mobile: it.mobile || '', contact: it.contact, image: it.image,
      userId: it.userId, createdAt: it.createdAt, updatedAt: it.updatedAt,
    });
    if (docs.length) await Post.insertMany(docs, { ordered: false });
    console.log(`[migrate] done`);
  } catch (err) { console.warn('[migrate] failed:', err.message); }
}

async function nextShopperId() {
  const c = await Counter.findOneAndUpdate({ _id: 'shop' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return 'DIVI-SHOP-' + String(c.seq).padStart(4, '0');
}

// ---------- Employees ----------
const EMPLOYEES_FILE = path.join(__dirname, 'employees.json');
let EMPLOYEES = [];
function loadEmployees() {
  try {
    const json = JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
    const list = Array.isArray(json.employees) ? json.employees : [];
    EMPLOYEES = list.filter(e => e && e.email && e.password).map(e => ({
      name: String(e.name || e.email),
      email: String(e.email).toLowerCase().trim(),
      password: String(e.password),
      isAdmin: !!e.isAdmin,
    }));
    console.log(`[employees] loaded ${EMPLOYEES.length} staff account(s)`);
  } catch (err) { console.warn('[employees] could not load:', err.message); EMPLOYEES = []; }
}
function saveEmployees(list) {
  const payload = {
    _comment: 'DIVI staff. Edit via the owner dashboard. Plaintext - keep off git/cloud.',
    employees: list.map(e => ({ name: e.name, email: e.email, password: e.password, isAdmin: !!e.isAdmin })),
  };
  const tmp = EMPLOYEES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, EMPLOYEES_FILE);
}
loadEmployees();
try { fs.watchFile(EMPLOYEES_FILE, { interval: 2000 }, () => { console.log('[employees] reload'); loadEmployees(); }); } catch {}

const findEmployeeByEmail = (e) => EMPLOYEES.find(x => x.email === String(e || '').toLowerCase().trim());
const isStaffEmail = (e) => !!findEmployeeByEmail(e);

// ---------- Google ----------
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
console.log(googleClient ? '[google] Sign-In enabled' : '[google] GOOGLE_CLIENT_ID not set');

// ---------- Auth helpers ----------
const signUserToken  = (u) => jwt.sign({ sub: String(u._id), email: u.email, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
const signStaffToken = (e) => jwt.sign({ email: e.email, role: e.isAdmin ? 'admin' : 'employee' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const authenticate = async (req, res, next) => {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'admin' || decoded.role === 'employee') {
      const emp = findEmployeeByEmail(decoded.email);
      if (!emp) return res.status(401).json({ message: 'Staff account no longer exists' });
      req.user = { _id: 'staff:' + emp.email, name: emp.name, email: emp.email,
        isAdmin: !!emp.isAdmin, role: emp.isAdmin ? 'admin' : 'employee', isStaff: true };
      return next();
    }
    const user = await User.findById(decoded.sub).select('-password');
    if (!user) return res.status(401).json({ message: 'User no longer exists' });
    if (user.suspended) return res.status(403).json({ message: 'Account suspended.' });
    req.user = { _id: user._id, name: user.name, email: user.email, mobile: user.mobile,
      isAdmin: !!user.isAdmin, role: user.isAdmin ? 'admin' : 'user', isStaff: !!user.isAdmin, picture: user.picture };
    next();
  } catch { res.status(401).json({ message: 'Invalid or expired token' }); }
};
const requireAdmin = (req, res, next) => req.user?.isAdmin ? next() : res.status(403).json({ message: 'Admin only' });
const requireStaff = (req, res, next) => req.user?.isStaff ? next() : res.status(403).json({ message: 'Staff only' });

const parsePagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};
const ownsOrAdmin = (resource, req) => req.user.isAdmin || (resource.userId && resource.userId === req.user.email);
const publicListing = (doc, viewerIsStaff) => {
  if (!doc) return doc;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  if (!viewerIsStaff) { delete o.mobile; delete o.contact; }
  return o;
};
const isChennaiArea = (val) => CHENNAI_AREAS_SET.has(String(val || '').trim().toLowerCase());

async function viewerStaffOptional(req) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role === 'admin' || d.role === 'employee') return !!findEmployeeByEmail(d.email);
    if (d.role === 'user' && d.sub) {
      const u = await User.findById(d.sub).select('isAdmin').lean();
      return !!u?.isAdmin;
    }
  } catch {}
  return false;
}
async function viewerInfo(req) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role === 'admin' || d.role === 'employee') {
      const emp = findEmployeeByEmail(d.email);
      if (!emp) return null;
      return { email: emp.email, isStaff: true, isAdmin: !!emp.isAdmin };
    }
    if (d.role === 'user' && d.sub) {
      const u = await User.findById(d.sub).select('email isAdmin').lean();
      if (!u) return null;
      return { email: u.email, isStaff: !!u.isAdmin, isAdmin: !!u.isAdmin };
    }
  } catch {}
  return null;
}
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- multer for file uploads ----------
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const safe = String(file.originalname || 'file').toLowerCase().replace(/[^a-z0-9.\-]/g, '_').slice(-40);
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + '-' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image files allowed'));
    cb(null, true);
  },
});

app.post('/api/upload', authenticate, uploadLimiter, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ message: 'No file' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ ok: true, url });
  });
});

// ---------- Public meta ----------
app.get('/api/health', (req, res) => res.json({
  ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'down',
  employees: EMPLOYEES.length, areas: CHENNAI_AREAS.length, googleSignIn: !!googleClient,
}));
app.get('/api/areas', (req, res) => res.json(CHENNAI_AREAS));
app.get('/api/categories', (req, res) => res.json({ posts: POST_CATEGORIES, shops: SHOP_CATEGORIES }));
app.get('/api/staff/list', (req, res) => res.json(EMPLOYEES.map(e => ({ name: e.name, email: e.email, isAdmin: e.isAdmin }))));
app.get('/api/auth/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, googleEnabled: !!googleClient }));

// ---------- Auth: email/password + Google ----------
app.post('/api/login', authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 1, max: 128 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const emp = findEmployeeByEmail(email);
      if (emp) {
        if (emp.password !== password) return res.status(401).json({ message: 'Invalid email or password' });
        return res.json({ token: signStaffToken(emp), user: { name: emp.name, email: emp.email, isAdmin: !!emp.isAdmin, role: emp.isAdmin ? 'admin' : 'employee', isStaff: true } });
      }
      const user = await User.findOne({ email });
      if (!user || !user.password) return res.status(401).json({ message: 'Invalid email or password' });
      if (user.suspended) return res.status(403).json({ message: 'Account suspended.' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
      res.json({ token: signUserToken(user), user: { id: user._id, name: user.name, email: user.email, mobile: user.mobile, isAdmin: !!user.isAdmin, role: user.isAdmin ? 'admin' : 'user', isStaff: !!user.isAdmin } });
    } catch (err) { console.error('login:', err); res.status(500).json({ message: 'Server error' }); }
  }
);

app.post('/api/auth/google', authLimiter,
  body('credential').isString().notEmpty(),
  body('mobile').optional({ checkFalsy: true }).trim().matches(/^[0-9+\-\s]{10,20}$/),
  handleValidation,
  async (req, res) => {
    if (!googleClient) return res.status(503).json({ message: 'Google Sign-In is not configured.' });
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) return res.status(400).json({ message: 'Could not read Google account email' });
      if (!payload.email_verified) return res.status(400).json({ message: 'Your Google email is not verified' });
      const email = payload.email.toLowerCase();
      const name = payload.name || payload.given_name || email.split('@')[0];
      const picture = payload.picture || '';
      const googleId = payload.sub;
      if (isStaffEmail(email)) {
        const emp = findEmployeeByEmail(email);
        return res.json({ token: signStaffToken(emp), user: { name: emp.name, email: emp.email, isAdmin: !!emp.isAdmin, role: emp.isAdmin ? 'admin' : 'employee', isStaff: true } });
      }
      let user = await User.findOne({ email });
      if (user && user.suspended) return res.status(403).json({ message: 'Account suspended.' });
      if (!user) {
        if (!req.body.mobile) return res.status(200).json({ needsMobile: true, email, name });
        user = await User.create({ name, email, googleId, picture, mobile: req.body.mobile, emailVerified: true });
      } else {
        let dirty = false;
        if (!user.googleId) { user.googleId = googleId; dirty = true; }
        if (picture && user.picture !== picture) { user.picture = picture; dirty = true; }
        if (!user.emailVerified) { user.emailVerified = true; dirty = true; }
        if (!user.mobile && req.body.mobile) { user.mobile = req.body.mobile; dirty = true; }
        if (dirty) await user.save();
        if (!user.mobile) return res.status(200).json({ needsMobile: true, email: user.email, name: user.name });
      }
      res.json({ token: signUserToken(user), user: { id: user._id, name: user.name, email: user.email, mobile: user.mobile, picture: user.picture, isAdmin: !!user.isAdmin, role: user.isAdmin ? 'admin' : 'user', isStaff: !!user.isAdmin } });
    } catch (err) {
      console.error('google sign-in:', err.message);
      res.status(401).json({ message: 'Google Sign-In failed: ' + (err.message || 'invalid token') });
    }
  }
);

app.get('/api/verify-token', authenticate, (req, res) => res.json({ user: req.user }));

app.put('/api/me', authenticate,
  body('name').optional().trim().isLength({ min: 1, max: 80 }),
  body('mobile').optional().trim().matches(/^[0-9+\-\s]{10,20}$/),
  handleValidation,
  async (req, res) => {
    if (req.user.isStaff) return res.status(400).json({ message: 'Staff profiles in employees.json' });
    try {
      const updates = {};
      if (req.body.name)   updates.name = req.body.name;
      if (req.body.mobile) updates.mobile = req.body.mobile;
      const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
      res.json({ user });
    } catch (err) { res.status(400).json({ message: 'Update failed' }); }
  }
);

app.patch('/api/me/password', authenticate,
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  handleValidation,
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      
      if (user.password && req.body.currentPassword) {
        const match = await bcrypt.compare(req.body.currentPassword, user.password);
        if (!match) return res.status(400).json({ message: 'Incorrect current password' });
      } else if (user.password && !req.body.currentPassword) {
        return res.status(400).json({ message: 'Current password is required' });
      }
      
      user.password = await bcrypt.hash(req.body.newPassword, BCRYPT_ROUNDS);
      await user.save();
      res.json({ message: 'Password updated successfully' });
    } catch (err) { res.status(400).json({ message: 'Failed to update password' }); }
  }
);

// ---------- Notifications ----------
app.get('/api/notifications', authenticate, async (req, res) => {
  try {
    const notifs = await Notification.find({ recipientEmail: req.user.email }).sort('-createdAt').limit(50);
    res.json(notifs);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.patch('/api/notifications/read', authenticate, async (req, res) => {
  try {
    await Notification.updateMany({ recipientEmail: req.user.email, read: false }, { read: true });
    res.json({ message: 'Marked as read' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Posts (kept; UI hides for now) ----------
const modelFor = (type) => ({ post: Post, shop: Shop }[type]);

app.get('/api/posts', async (req, res) => {
  try {
    const { category, city, search, maxPrice, minPrice } = req.query;
    const { page, limit, skip } = parsePagination(req);
    const filter = {};
    if (category && POST_CATEGORIES.includes(category)) filter.category = category;
    if (city)    filter.location = new RegExp(escapeRegex(city), 'i');
    if (maxPrice) filter.price = { ...(filter.price||{}), $lte: Number(maxPrice) };
    if (minPrice) filter.price = { ...(filter.price||{}), $gte: Number(minPrice) };
    if (search) { const re = new RegExp(escapeRegex(search), 'i'); filter.$or = [{ title: re }, { description: re }]; }
    const [posts, total] = await Promise.all([
      Post.find(filter).sort('-createdAt').skip(skip).limit(limit),
      Post.countDocuments(filter),
    ]);
    const isStaff = await viewerStaffOptional(req);
    res.json({ data: posts.map(p => publicListing(p, isStaff)), page, limit, total, totalPages: Math.ceil(total/limit) });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/posts/:id', param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
    if (!post) return res.status(404).json({ message: 'Not found' });
    const isStaff = await viewerStaffOptional(req);
    res.json(publicListing(post, isStaff));
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/posts', authenticate, writeLimiter,
  body('category').isIn(POST_CATEGORIES),
  body('title').trim().isLength({ min: 1, max: 120 }),
  body('description').trim().isLength({ min: 1, max: 2000 }),
  body('price').isFloat({ min: 0 }),
  body('location').trim().custom(v => isChennaiArea(v)).withMessage('Pick a Chennai area'),
  body('mobile').trim().matches(/^[0-9+\-\s]{10,20}$/),
  body('image').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  handleValidation,
  async (req, res) => {
    try {
      if (req.user.isStaff) return res.status(403).json({ message: 'Staff cannot post' });
      const isRent = req.body.category === 'rooms';
      const post = await Post.create({ ...req.body, isRent, userId: req.user.email });
      res.status(201).json(post);
    } catch (err) { res.status(400).json({ message: 'Failed to post' }); }
  }
);
app.put('/api/posts/:id', authenticate, writeLimiter, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Not found' });
    if (!ownsOrAdmin(post, req)) return res.status(403).json({ message: 'Not your post' });
    const allowed = ['category','title','description','price','location','mobile','contact','image'];
    for (const k of allowed) if (k in req.body) post[k] = req.body[k];
    if (req.body.location && !isChennaiArea(req.body.location)) return res.status(400).json({ message: 'Pick a Chennai area' });
    if (req.body.category) post.isRent = req.body.category === 'rooms';
    await post.save();
    res.json(post);
  } catch (err) { res.status(400).json({ message: 'Update failed' }); }
});
app.delete('/api/posts/:id', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Not found' });
    if (!ownsOrAdmin(post, req)) return res.status(403).json({ message: 'Not your post' });
    await post.deleteOne();
    await Interest.deleteMany({ postId: post._id });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(400).json({ message: 'Delete failed' }); }
});

app.get('/api/user/listings', authenticate, async (req, res) => {
  if (req.user.isStaff) return res.json({ posts: [], shops: [], bookings: [] });
  try {
    const [posts, shops, bookings] = await Promise.all([
      Post.find({ userId: req.user.email }).sort('-createdAt'),
      Shop.find({ userId: req.user.email }).sort('-createdAt'),
      Booking.find({ requesterEmail: req.user.email }).sort('-date').limit(50),
    ]);
    res.json({ posts, shops, bookings });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/my-interests', authenticate, async (req, res) => {
  if (req.user.isStaff) return res.json([]);
  try { res.json(await Interest.find({ userEmail: req.user.email }).sort('-createdAt')); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/posts/:id/interest', authenticate, writeLimiter,
  param('id').isMongoId(),
  body('note').optional().trim().isLength({ max: 280 }),
  handleValidation,
  async (req, res) => {
    if (req.user.isStaff) return res.status(400).json({ message: 'Staff cannot mark interest' });
    if (!req.user.mobile) return res.status(400).json({ message: 'Add your mobile in your profile first' });
    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: 'Not found' });
      if (post.userId === req.user.email) return res.status(400).json({ message: 'You posted this' });
      const interest = await Interest.findOneAndUpdate(
        { postId: post._id, userEmail: req.user.email },
        { postId: post._id, userEmail: req.user.email, userName: req.user.name, userMobile: req.user.mobile, note: req.body.note || '' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.status(201).json({ ok: true, interest });
    } catch (err) { res.status(400).json({ message: 'Could not record' }); }
  }
);
app.delete('/api/posts/:id/interest', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try { await Interest.deleteOne({ postId: req.params.id, userEmail: req.user.email }); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ message: 'Failed' }); }
});
app.get('/api/posts/:id/interests', authenticate, requireStaff, param('id').isMongoId(), handleValidation, async (req, res) => {
  try { res.json(await Interest.find({ postId: req.params.id }).sort('-createdAt')); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Shops ----------
app.get('/api/shops', async (req, res) => {
  try {
    const { category, city, search } = req.query;
    const { page, limit, skip } = parsePagination(req);
    const filter = { status: 'approved' };
    if (category && SHOP_CATEGORIES.includes(category)) filter.category = category;
    if (city)   filter.location = new RegExp(escapeRegex(city), 'i');
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: re }, { description: re }];
    }
    const [shops, total] = await Promise.all([
      Shop.find(filter).sort({ rating: -1, reviewCount: -1, createdAt: -1 }).skip(skip).limit(limit),
      Shop.countDocuments(filter),
    ]);
    const isStaff = await viewerStaffOptional(req);
    res.json({ data: shops.map(s => publicListing(s, isStaff)), page, limit, total, totalPages: Math.ceil(total/limit) });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/shops/:id', param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    const viewer = await viewerInfo(req);
    const ownsThis = viewer && viewer.email === shop.userId;
    if (shop.status !== 'approved') {
      if (!viewer || (!viewer.isAdmin && !ownsThis)) return res.status(404).json({ message: 'Not found' });
    }
    // Show full record (including mobile) to staff and to the shop's own owner
    const showFull = !!viewer?.isStaff || ownsThis;
    res.json(publicListing(shop, showFull));
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/shops', authenticate, writeLimiter,
  body('name').trim().isLength({ min: 1, max: 120 }),
  body('description').trim().isLength({ min: 1, max: 2000 }),
  body('category').optional().isIn(SHOP_CATEGORIES),
  body('location').trim().custom(v => isChennaiArea(v)).withMessage('Pick a Chennai area'),
  body('address').optional().trim().isLength({ max: 300 }),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
  body('mobile').trim().matches(/^[0-9+\-\s]{10,20}$/),
  body('image').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  body('openAt').optional().trim().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('closeAt').optional().trim().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  handleValidation,
  async (req, res) => {
    try {
      // Admin (owner) posting bypasses approval and gets a shopperId immediately
      const isAdmin = !!req.user.isAdmin;
      const initialStatus = isAdmin ? 'approved' : 'pending';
      const shopperId = isAdmin ? await nextShopperId() : undefined;
      const shop = await Shop.create({
        ...req.body, userId: req.user.email,
        status: initialStatus,
        ...(shopperId ? { shopperId, approvedAt: new Date() } : {}),
      });
      res.status(201).json(shop);
    } catch (err) { res.status(400).json({ message: 'Failed to submit shop' }); }
  }
);

app.put('/api/shops/:id', authenticate, writeLimiter, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    if (!ownsOrAdmin(shop, req)) return res.status(403).json({ message: 'Not your shop' });
    const allowed = ['name','description','category','location','address','lat','lng','mobile','image','openAt','closeAt'];
    for (const k of allowed) if (k in req.body) shop[k] = req.body[k];
    if (req.body.location && !isChennaiArea(req.body.location)) return res.status(400).json({ message: 'Pick a Chennai area' });
    // Editing approved → back to pending (unless admin)
    if (!req.user.isAdmin && shop.status === 'approved') shop.status = 'pending';
    await shop.save();
    res.json(shop);
  } catch (err) { res.status(400).json({ message: 'Update failed' }); }
});

app.patch('/api/shops/:id/online', authenticate, writeLimiter, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    if (!ownsOrAdmin(shop, req)) return res.status(403).json({ message: 'Not your shop' });
    shop.isOnline = !!req.body.isOnline;
    await shop.save();
    res.json({ isOnline: shop.isOnline });
  } catch (err) { res.status(400).json({ message: 'Toggle failed' }); }
});

app.post('/api/shops/:id/reviews', authenticate, writeLimiter,
  param('id').isMongoId(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().trim().isLength({ max: 1000 }),
  handleValidation,
  async (req, res) => {
    try {
      const shop = await Shop.findById(req.params.id);
      if (!shop) return res.status(404).json({ message: 'Shop not found' });
      if (shop.userId === req.user.email) return res.status(400).json({ message: 'Cannot review your own shop' });

      // Upsert review
      await mongoose.model('Review').findOneAndUpdate(
        { shopId: shop._id, userEmail: req.user.email },
        { shopId: shop._id, userEmail: req.user.email, userName: req.user.name, rating: req.body.rating, comment: req.body.comment },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Recalculate average
      const Review = mongoose.model('Review');
      const allReviews = await Review.find({ shopId: shop._id });
      const avg = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
      shop.rating = Number(avg.toFixed(1));
      shop.reviewCount = allReviews.length;
      await shop.save();

      // Notify owner if it's not their own review (which is blocked anyway)
      await Notification.create({
          recipientEmail: shop.userId, type: 'system', 
          message: `${req.user.name} reviewed your shop "${shop.name}" with ${req.body.rating} stars.` 
      });

      res.status(201).json({ message: 'Review added', rating: shop.rating, reviewCount: shop.reviewCount });
    } catch (err) {
      res.status(400).json({ message: 'Failed to add review' });
    }
  }
);

app.patch('/api/shops/:id/reviews/:reviewId/like', authenticate, writeLimiter, param('id').isMongoId(), param('reviewId').isMongoId(), handleValidation, async (req, res) => {
  try {
    const r = await Review.findById(req.params.reviewId);
    if (!r) return res.status(404).json({ message: 'Review not found' });
    if (!r.likes.includes(req.user.email)) {
      r.likes.push(req.user.email);
      await r.save();
      if (r.userEmail !== req.user.email) {
        await Notification.create({ recipientEmail: r.userEmail, type: 'like', message: `${req.user.name} liked your review.` });
      }
    } else {
      r.likes = r.likes.filter(e => e !== req.user.email);
      await r.save();
    }
    res.json({ likes: r.likes });
  } catch(err) { res.status(400).json({ message: 'Like failed' }); }
});

app.post('/api/shops/:id/reviews/:reviewId/reply', authenticate, writeLimiter, param('id').isMongoId(), param('reviewId').isMongoId(), body('body').trim().isLength({min:1, max: 500}), handleValidation, async (req, res) => {
  try {
    const r = await Review.findById(req.params.reviewId);
    if (!r) return res.status(404).json({ message: 'Review not found' });
    r.replies.push({ from: req.user.email, name: req.user.name, body: req.body.body });
    await r.save();
    if (r.userEmail !== req.user.email) {
      await Notification.create({ recipientEmail: r.userEmail, type: 'reply', message: `${req.user.name} replied to your review: "${req.body.body.substring(0,30)}..."` });
    }
    const shop = await Shop.findById(req.params.id);
    if (shop && shop.userId !== req.user.email && shop.userId !== r.userEmail) {
       await Notification.create({ recipientEmail: shop.userId, type: 'reply', message: `${req.user.name} replied to a review on your shop "${shop.name}".` });
    }
    res.json({ replies: r.replies });
  } catch(err) { res.status(400).json({ message: 'Reply failed' }); }
});

app.delete('/api/shops/:id', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    if (!ownsOrAdmin(shop, req)) return res.status(403).json({ message: 'Not your shop' });
    await shop.deleteOne();
    await Review.deleteMany({ shopId: shop._id });
    await HoF.deleteMany({ shopId: shop._id });
    await Booking.deleteMany({ shopId: shop._id });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(400).json({ message: 'Delete failed' }); }
});

// Admin: ALL shops (any status) — for management / delete tab
app.get('/api/admin/shops/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};
    if (search) { const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'); filter.$or = [{ name: re }, { description: re }]; }
    const shops = await Shop.find(filter).sort('-createdAt').limit(500);
    res.json(shops);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Admin shop queue
app.get('/api/admin/shops/pending', authenticate, requireAdmin, async (req, res) => {

  try { res.json(await Shop.find({ status: 'pending' }).sort('-createdAt')); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.put('/api/admin/shops/:id/approve', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    shop.status = 'approved';
    shop.approvedAt = new Date();
    shop.rejectReason = '';
    if (!shop.shopperId) shop.shopperId = await nextShopperId();
    await shop.save();
    res.json(shop);
  } catch (err) { console.error('approve:', err); res.status(400).json({ message: 'Failed' }); }
});

app.put('/api/admin/shops/:id/reject', authenticate, requireAdmin, param('id').isMongoId(),
  body('reason').optional().trim().isLength({ max: 280 }),
  handleValidation,
  async (req, res) => {
    try {
      const shop = await Shop.findByIdAndUpdate(req.params.id, { status: 'rejected', rejectReason: req.body.reason || '' }, { new: true });
      if (!shop) return res.status(404).json({ message: 'Not found' });
      res.json(shop);
    } catch (err) { res.status(400).json({ message: 'Failed' }); }
  }
);

// Reviews
async function recomputeShopRating(shopId) {
  const r = await Review.aggregate([
    { $match: { shopId } },
    { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  const data = r[0] || { avg: 0, n: 0 };
  await Shop.findByIdAndUpdate(shopId, { rating: data.avg || 0, reviewCount: data.n || 0 });
}

app.get('/api/shops/:id/reviews', param('id').isMongoId(), handleValidation, async (req, res) => {
  try { res.json(await Review.find({ shopId: req.params.id }).sort('-createdAt').limit(100)); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/shops/:id/reviews', authenticate, writeLimiter,
  param('id').isMongoId(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().trim().isLength({ max: 1000 }),
  handleValidation,
  async (req, res) => {
    if (req.user.isStaff) return res.status(400).json({ message: 'Staff do not review' });
    try {
      const shop = await Shop.findById(req.params.id);
      if (!shop || shop.status !== 'approved') return res.status(404).json({ message: 'Not found' });
      const review = await Review.findOneAndUpdate(
        { shopId: shop._id, userEmail: req.user.email },
        { shopId: shop._id, userEmail: req.user.email, userName: req.user.name, rating: Number(req.body.rating), comment: req.body.comment || '' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await recomputeShopRating(shop._id);
      res.status(201).json(review);
    } catch (err) { res.status(400).json({ message: 'Could not save review' }); }
  }
);

app.delete('/api/shops/:id/reviews/me', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shopId = new mongoose.Types.ObjectId(req.params.id);
    await Review.deleteOne({ shopId, userEmail: req.user.email });
    await recomputeShopRating(shopId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

// ---------- Hall of Fame ----------
// Public list (only approved entries shown)
app.get('/api/hall-of-fame', async (req, res) => {
  try {
    const { shopId } = req.query;
    const { page, limit, skip } = parsePagination(req);
    const filter = { approved: true };
    if (shopId && /^[a-f0-9]{24}$/i.test(shopId)) filter.shopId = new mongoose.Types.ObjectId(shopId);
    const [data, total] = await Promise.all([
      HoF.find(filter).sort('-createdAt').skip(skip).limit(limit),
      HoF.countDocuments(filter),
    ]);
    res.json({ data, page, limit, total, totalPages: Math.ceil(total/limit) });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Add entry: shop owner OR admin
app.post('/api/hall-of-fame', authenticate, writeLimiter,
  body('shopId').isMongoId(),
  body('personName').trim().isLength({ min: 1, max: 80 }),
  body('personEmail').optional({ checkFalsy: true }).isEmail().normalizeEmail(),
  body('description').trim().isLength({ min: 1, max: 1500 }),
  body('workedFrom').optional({ checkFalsy: true }).isISO8601().toDate(),
  body('workedTo').optional({ checkFalsy: true }).isISO8601().toDate(),
  body('soldAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('earnedAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('image').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  handleValidation,
  async (req, res) => {
    try {
      const shop = await Shop.findById(req.body.shopId);
      if (!shop) return res.status(404).json({ message: 'Shop not found' });
      const isOwner = !req.user.isStaff && shop.userId === req.user.email;
      const isAdmin = !!req.user.isAdmin;
      if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only shop owner or admin can add' });
      const entry = await HoF.create({
        ...req.body,
        shopId: shop._id, shopName: shop.name,
        addedBy: req.user.email,
        addedByRole: isAdmin ? 'admin' : 'owner',
        approved: isAdmin, // admin entries auto-approved; owner entries pending
      });
      res.status(201).json(entry);
    } catch (err) { console.error('hof add:', err); res.status(400).json({ message: 'Could not add' }); }
  }
);

// Approve HoF: admin OR the shop's owner
app.put('/api/hall-of-fame/:id/approve', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const e = await HoF.findById(req.params.id);
    if (!e) return res.status(404).json({ message: 'Not found' });
    if (!req.user.isAdmin) {
      const shop = await Shop.findById(e.shopId);
      if (!shop || shop.userId !== req.user.email) return res.status(403).json({ message: 'Not allowed' });
    }
    e.approved = true;
    await e.save();
    res.json(e);
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});
// Backwards-compat alias for admin
app.put('/api/admin/hall-of-fame/:id/approve', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const e = await HoF.findByIdAndUpdate(req.params.id, { approved: true }, { new: true });
    if (!e) return res.status(404).json({ message: 'Not found' });
    res.json(e);
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.delete('/api/hall-of-fame/:id', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const e = await HoF.findById(req.params.id);
    if (!e) return res.status(404).json({ message: 'Not found' });
    const shop = await Shop.findById(e.shopId);
    const isOwner = !req.user.isStaff && shop && shop.userId === req.user.email;
    if (!req.user.isAdmin && !isOwner) return res.status(403).json({ message: 'Not allowed' });
    await e.deleteOne();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.get('/api/admin/hall-of-fame/pending', authenticate, requireAdmin, async (req, res) => {
  try { res.json(await HoF.find({ approved: false }).sort('-createdAt').limit(200)); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Bookings (work-a-day) ----------
app.post('/api/bookings', authenticate, writeLimiter,
  body('shopId').isMongoId(),
  body('date').isISO8601().toDate(),
  body('reason').optional().trim().isLength({ max: 1000 }),
  handleValidation,
  async (req, res) => {
    if (req.user.isStaff) return res.status(403).json({ message: 'Staff cannot request bookings' });
    if (!req.user.mobile) return res.status(400).json({ message: 'Add your mobile in your profile first' });
    try {
      const shop = await Shop.findById(req.body.shopId);
      if (!shop || shop.status !== 'approved') return res.status(404).json({ message: 'Shop not found' });
      if (shop.userId === req.user.email) return res.status(400).json({ message: 'You own this shop' });
      const booking = await Booking.create({
        shopId: shop._id, shopName: shop.name, shopOwner: shop.userId,
        requesterEmail: req.user.email, requesterName: req.user.name, requesterMobile: req.user.mobile,
        date: req.body.date, reason: req.body.reason || '',
      });
      await Notification.create({
        recipientEmail: shop.userId, type: 'booking',
        message: `${req.user.name} requested to book a work-day (MBA in Sales) at your shop "${shop.name}".`,
        relatedId: booking._id
      });
      // Notify Admin
      const admin = await mongoose.model('User').findOne({ isAdmin: true });
      if (admin && admin.email !== shop.userId) {
        await Notification.create({
          recipientEmail: admin.email, type: 'booking',
          message: `New MBA in Sales booking: ${req.user.name} at "${shop.name}".`,
          relatedId: booking._id
        });
      }
      res.status(201).json(booking);
    } catch (err) { console.error('booking:', err); res.status(400).json({ message: 'Could not create' }); }
  }
);

// Owner of the shop: list bookings for a shop
app.get('/api/shops/:id/bookings', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ message: 'Not found' });
    const isOwner = !req.user.isStaff && shop.userId === req.user.email;
    if (!req.user.isAdmin && !isOwner) return res.status(403).json({ message: 'Not allowed' });
    const list = await Booking.find({ shopId: shop._id }).sort('-date');
    res.json(list);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Owner / admin updates booking status
app.put('/api/bookings/:id', authenticate, param('id').isMongoId(),
  body('status').isIn(['approved','rejected','done','cancelled','pending']),
  body('ownerNote').optional().trim().isLength({ max: 500 }),
  handleValidation,
  async (req, res) => {
    try {
      const b = await Booking.findById(req.params.id);
      if (!b) return res.status(404).json({ message: 'Not found' });
      const shop = await Shop.findById(b.shopId);
      const isOwner = !req.user.isStaff && shop && shop.userId === req.user.email;
      const isRequester = b.requesterEmail === req.user.email;
      // Requester can cancel; owner/admin can do all transitions
      if (!req.user.isAdmin && !isOwner && !(isRequester && req.body.status === 'cancelled')) {
        return res.status(403).json({ message: 'Not allowed' });
      }
      b.status = req.body.status;
      if (req.body.ownerNote != null) b.ownerNote = req.body.ownerNote;
      await b.save();
      
      if (req.body.status !== 'pending' && req.body.status !== 'cancelled') {
        await Notification.create({
          recipientEmail: b.requesterEmail, type: 'booking',
          message: `Your booking request at "${shop?.name || b.shopName}" is now ${req.body.status}.`,
          relatedId: b._id
        });
      }
      res.json(b);
    } catch (err) { res.status(400).json({ message: 'Failed' }); }
  }
);

// ---------- Site Config ----------
app.get('/api/site-config', async (req, res) => {
  try {
    const cfg = await SiteConfig.findOne({}) || {};
    res.json(cfg);
  } catch { res.json({}); }
});

app.put('/api/admin/site-config', authenticate, requireAdmin, async (req, res) => {
  try {
    const allowed = ['ownerName','ownerPhone','ownerEmail','instagram','facebook','youtube','tagline','footerNote','address','sections'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const cfg = await SiteConfig.findOneAndUpdate({}, update, { upsert: true, new: true });
    res.json(cfg);
  } catch (err) { res.status(400).json({ message: 'Failed to save' }); }
});

// ---------- Events ----------
// Public: approved upcoming events
app.get('/api/events', async (req, res) => {
  try {
    const area = String(req.query.area || '').trim();
    const filter = { approved: true, date: { $gte: new Date(Date.now() - 24*3600*1000) } };
    if (area) filter.area = new RegExp(escapeRegex(area), 'i');
    const events = await Event.find(filter).sort('date').limit(50);
    res.json(events);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Admin: all events
app.get('/api/admin/events', authenticate, requireAdmin, async (req, res) => {
  try { res.json(await Event.find({}).sort('-createdAt').limit(200)); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Create event (admin only)
app.post('/api/events', authenticate, requireAdmin, writeLimiter,
  body('title').trim().isLength({ min: 1, max: 120 }),
  body('description').trim().isLength({ min: 1, max: 2000 }),
  body('area').trim().custom(v => isChennaiArea(v)).withMessage('Pick a Chennai area'),
  body('date').isISO8601().toDate(),
  body('endDate').optional({ checkFalsy: true }).isISO8601().toDate(),
  body('venue').optional().trim().isLength({ max: 200 }),
  body('image').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  handleValidation,
  async (req, res) => {
    try {
      const ev = await Event.create({ ...req.body, createdBy: req.user.email, approved: true });
      res.status(201).json(ev);
    } catch (err) { res.status(400).json({ message: 'Failed to create event' }); }
  }
);

app.put('/api/events/:id', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const ev = await Event.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!ev) return res.status(404).json({ message: 'Not found' });
    res.json(ev);
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.delete('/api/events/:id', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ message: 'Not found' });
    await ev.deleteOne();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

// All bookings across shops (admin)
app.get('/api/admin/bookings', authenticate, requireAdmin, async (req, res) => {
  try { res.json(await Booking.find({}).sort('-createdAt').limit(200)); }
  catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Community chat ----------
app.get('/api/community', async (req, res) => {
  try {
    const area = String(req.query.area || '').trim();
    const filter = area ? { area } : {};
    const messages = await Community.find(filter).sort('-createdAt').limit(200);
    res.json(messages.reverse());
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/community', authenticate, chatLimiter,
  body('body').optional({ checkFalsy: true }).trim().isLength({ max: 1000 }),
  body('sticker').optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
  body('area').optional().trim().isLength({ max: 80 }),
  handleValidation,
  async (req, res) => {
    try {
      const area = String(req.body.area || '').trim();
      if (area && !isChennaiArea(area)) return res.status(400).json({ message: 'Invalid area' });
      if (!req.body.body && !req.body.sticker) return res.status(400).json({ message: 'Message or sticker required' });
      const msg = await Community.create({
        area, from: req.user.email, name: req.user.name,
        picture: req.user.picture || '', body: req.body.body || '',
        sticker: req.body.sticker || '',
      });
      res.status(201).json(msg);
    } catch (err) { res.status(400).json({ message: 'Could not post' }); }
  }
);

// Reply to community post
app.post('/api/community/:id/reply', authenticate, chatLimiter,
  param('id').isMongoId(),
  body('body').optional({ checkFalsy: true }).trim().isLength({ max: 1000 }),
  body('sticker').optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
  handleValidation,
  async (req, res) => {
    try {
      if (!req.body.body && !req.body.sticker) return res.status(400).json({ message: 'Reply or sticker required' });
      const msg = await Community.findByIdAndUpdate(
        req.params.id,
        { $push: { replies: { from: req.user.email, name: req.user.name, body: req.body.body || '', sticker: req.body.sticker || '', createdAt: new Date() } } },
        { new: true }
      );
      if (!msg) return res.status(404).json({ message: 'Not found' });
      if (msg.from !== req.user.email) {
        await Notification.create({ recipientEmail: msg.from, type: 'reply', message: `${req.user.name} replied to your community post.` });
      }
      res.json(msg);
    } catch (err) { res.status(400).json({ message: 'Could not reply' }); }
  }
);

app.patch('/api/community/:id/like', authenticate, chatLimiter, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const msg = await Community.findById(req.params.id);
    if (!msg) return res.status(404).json({ message: 'Not found' });
    if (!msg.likes.includes(req.user.email)) {
      msg.likes.push(req.user.email);
      await msg.save();
      if (msg.from !== req.user.email) {
        await Notification.create({ recipientEmail: msg.from, type: 'like', message: `${req.user.name} liked your community post.` });
      }
    } else {
      msg.likes = msg.likes.filter(e => e !== req.user.email);
      await msg.save();
    }
    res.json({ likes: msg.likes });
  } catch(err) { res.status(400).json({ message: 'Like failed' }); }
});

app.delete('/api/community/:id', authenticate, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const m = await Community.findById(req.params.id);
    if (!m) return res.status(404).json({ message: 'Not found' });
    if (!req.user.isAdmin && m.from !== req.user.email) return res.status(403).json({ message: 'Not your message' });
    await m.deleteOne();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

// ---------- 1-1 chat ----------
app.post('/api/messages', authenticate, writeLimiter,
  body('to').isEmail().normalizeEmail(),
  body('body').trim().isLength({ min: 1, max: 2000 }),
  body('postId').optional({ checkFalsy: true }).isMongoId(),
  handleValidation,
  async (req, res) => {
    try {
      const from = req.user.email, to = req.body.to.toLowerCase();
      if (from === to) return res.status(400).json({ message: "Can't message yourself" });
      const fromStaff = req.user.isStaff, toStaff = isStaffEmail(to);
      if (!fromStaff && !toStaff) return res.status(403).json({ message: 'You can only chat with DIVI staff' });
      if (fromStaff && !toStaff) {
        const exists = await User.exists({ email: to });
        if (!exists) return res.status(404).json({ message: 'User not found' });
      }
      const msg = await Message.create({ from, to, postId: req.body.postId || null, body: req.body.body });
      res.status(201).json(msg);
    } catch (err) { res.status(400).json({ message: 'Could not send' }); }
  }
);

app.get('/api/messages/threads', authenticate, async (req, res) => {
  try {
    const me = req.user.email;
    const threads = await Message.aggregate([
      { $match: { $or: [{ from: me }, { to: me }] } },
      { $addFields: { peer: { $cond: [{ $eq: ['$from', me] }, '$to', '$from'] } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$peer', lastMessage: { $first: '$body' }, lastAt: { $first: '$createdAt' },
        lastFrom: { $first: '$from' },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ['$to', me] }, { $eq: ['$readAt', null] }] }, 1, 0] } } } },
      { $sort: { lastAt: -1 } }, { $limit: 100 },
    ]);
    res.json(threads.map(t => ({ peer: t._id, lastMessage: t.lastMessage, lastAt: t.lastAt, lastFrom: t.lastFrom, unread: t.unread })));
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/messages/with/:peer', authenticate, param('peer').isEmail(), handleValidation, async (req, res) => {
  try {
    const me = req.user.email, peer = String(req.params.peer).toLowerCase();
    const fromStaff = req.user.isStaff, peerStaff = isStaffEmail(peer);
    if (!fromStaff && !peerStaff) return res.status(403).json({ message: 'Not allowed' });
    const messages = await Message.find({ $or: [{ from: me, to: peer }, { from: peer, to: me }] }).sort('createdAt').limit(500);
    await Message.updateMany({ from: peer, to: me, readAt: null }, { $set: { readAt: new Date() } });
    res.json(messages);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Staff helpers ----------
app.get('/api/staff/contacts', authenticate, requireStaff, async (req, res) => {
  try {
    const [posters, ints, owners] = await Promise.all([Post.distinct('userId'), Interest.distinct('userEmail'), Shop.distinct('userId')]);
    const emails = [...new Set([...posters, ...ints, ...owners])];
    const users = await User.find({ email: { $in: emails } }).select('name email mobile suspended createdAt');
    res.json(users);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// ---------- Admin: users + employees + stats ----------
app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const filter = search ? { $or: [
      { name: new RegExp(escapeRegex(search), 'i') },
      { email: new RegExp(escapeRegex(search), 'i') },
      { mobile: new RegExp(escapeRegex(search), 'i') },
    ] } : {};
    const users = await User.find(filter).select('-password').sort('-createdAt').lean();
    const emails = users.map(u => u.email);
    const [posts, shops, interests] = await Promise.all([
      Post.aggregate([{ $match: { userId: { $in: emails } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
      Shop.aggregate([{ $match: { userId: { $in: emails } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
      Interest.aggregate([{ $match: { userEmail: { $in: emails } } }, { $group: { _id: '$userEmail', n: { $sum: 1 } } }]),
    ]);
    const counts = (arr) => Object.fromEntries(arr.map(x => [x._id, x.n]));
    const p = counts(posts), s = counts(shops), i = counts(interests);
    res.json(users.map(u => ({ ...u, counts: { posts: p[u.email]||0, shops: s[u.email]||0, interests: i[u.email]||0 } })));
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.put('/api/admin/users/:id/suspend', authenticate, requireAdmin, param('id').isMongoId(), body('suspended').isBoolean(), handleValidation, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { suspended: !!req.body.suspended }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'Not found' });
    res.json(user);
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.delete('/api/admin/users/:id', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Not found' });
    await Promise.all([
      Post.deleteMany({ userId: user.email }),
      Shop.deleteMany({ userId: user.email }),
      Review.deleteMany({ userEmail: user.email }),
      Interest.deleteMany({ userEmail: user.email }),
      Message.deleteMany({ $or: [{ from: user.email }, { to: user.email }] }),
      Community.deleteMany({ from: user.email }),
      Booking.deleteMany({ requesterEmail: user.email }),
      user.deleteOne(),
    ]);
    res.json({ message: 'User and data deleted' });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.get('/api/admin/employees', authenticate, requireAdmin, (req, res) =>
  res.json(EMPLOYEES.map(e => ({ name: e.name, email: e.email, isAdmin: !!e.isAdmin })))
);

app.post('/api/admin/employees', authenticate, requireAdmin,
  body('name').trim().isLength({ min: 1, max: 80 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6, max: 128 }),
  body('isAdmin').optional().isBoolean(),
  handleValidation,
  async (req, res) => {
    try {
      const email = req.body.email.toLowerCase();
      if (EMPLOYEES.find(e => e.email === email)) return res.status(409).json({ message: 'Already a staff member' });
      const list = [...EMPLOYEES, { name: req.body.name, email, password: req.body.password, isAdmin: !!req.body.isAdmin }];
      saveEmployees(list); loadEmployees();
      res.status(201).json({ ok: true });
    } catch (err) { res.status(500).json({ message: 'Could not add' }); }
  }
);

app.put('/api/admin/employees/:email', authenticate, requireAdmin,
  param('email').isEmail(),
  body('name').optional().trim().isLength({ min: 1, max: 80 }),
  body('password').optional().isLength({ min: 6, max: 128 }),
  body('isAdmin').optional().isBoolean(),
  handleValidation,
  async (req, res) => {
    try {
      const email = String(req.params.email).toLowerCase();
      const idx = EMPLOYEES.findIndex(e => e.email === email);
      if (idx < 0) return res.status(404).json({ message: 'Not found' });
      const updated = { ...EMPLOYEES[idx] };
      if (req.body.name)     updated.name = req.body.name;
      if (req.body.password) updated.password = req.body.password;
      if ('isAdmin' in req.body) updated.isAdmin = !!req.body.isAdmin;
      const list = [...EMPLOYEES]; list[idx] = updated;
      if (list.filter(e => e.isAdmin).length === 0) return res.status(400).json({ message: 'Need at least one owner' });
      saveEmployees(list); loadEmployees();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ message: 'Could not update' }); }
  }
);

app.delete('/api/admin/employees/:email', authenticate, requireAdmin, param('email').isEmail(), handleValidation, async (req, res) => {
  try {
    const email = String(req.params.email).toLowerCase();
    if (email === req.user.email) return res.status(400).json({ message: "Can't remove yourself" });
    const list = EMPLOYEES.filter(e => e.email !== email);
    if (list.length === EMPLOYEES.length) return res.status(404).json({ message: 'Not found' });
    if (list.filter(e => e.isAdmin).length === 0) return res.status(400).json({ message: 'Need at least one owner' });
    saveEmployees(list); loadEmployees();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: 'Could not remove' }); }
});

// Admin: create a user manually (no password — they'll Google sign-in)
app.post('/api/admin/users', authenticate, requireAdmin,
  body('name').trim().isLength({ min: 1, max: 80 }),
  body('email').isEmail().normalizeEmail(),
  body('mobile').trim().matches(/^[0-9+\-\s]{10,20}$/),
  handleValidation,
  async (req, res) => {
    try {
      if (isStaffEmail(req.body.email)) return res.status(409).json({ message: 'Email is staff in employees.json' });
      const existing = await User.findOne({ email: req.body.email });
      if (existing) return res.status(409).json({ message: 'Email already registered' });
      const user = await User.create({
        name: req.body.name, email: req.body.email, mobile: req.body.mobile,
        emailVerified: true,
      });
      res.status(201).json({ ok: true, user: { id: user._id, name: user.name, email: user.email, mobile: user.mobile } });
    } catch (err) { console.error('admin create user:', err); res.status(400).json({ message: 'Failed' }); }
  }
);

// Admin: create a booking on behalf of someone
app.post('/api/admin/bookings', authenticate, requireAdmin,
  body('shopId').isMongoId(),
  body('date').isISO8601().toDate(),
  body('requesterName').trim().isLength({ min: 1, max: 80 }),
  body('requesterEmail').isEmail().normalizeEmail(),
  body('requesterMobile').trim().matches(/^[0-9+\-\s]{10,20}$/),
  body('reason').optional().trim().isLength({ max: 1000 }),
  body('status').optional().isIn(['pending','approved','rejected','done','cancelled']),
  handleValidation,
  async (req, res) => {
    try {
      const shop = await Shop.findById(req.body.shopId);
      if (!shop) return res.status(404).json({ message: 'Shop not found' });
      const booking = await Booking.create({
        shopId: shop._id, shopName: shop.name, shopOwner: shop.userId,
        requesterEmail: req.body.requesterEmail, requesterName: req.body.requesterName, requesterMobile: req.body.requesterMobile,
        date: req.body.date, reason: req.body.reason || '',
        status: req.body.status || 'approved',
      });
      res.status(201).json(booking);
    } catch (err) { console.error('admin booking:', err); res.status(400).json({ message: 'Failed' }); }
  }
);

// Admin: delete any review (and recompute shop rating)
app.delete('/api/admin/reviews/:id', authenticate, requireAdmin, param('id').isMongoId(), handleValidation, async (req, res) => {
  try {
    const r = await Review.findById(req.params.id);
    if (!r) return res.status(404).json({ message: 'Not found' });
    const shopId = r.shopId;
    await r.deleteOne();
    await recomputeShopRating(shopId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ message: 'Failed' }); }
});

app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [users, posts, shops, pending, reviews, interests, messages, community, hof, hofPending, bookings] = await Promise.all([
      User.countDocuments(), Post.countDocuments(), Shop.countDocuments({ status: 'approved' }),
      Shop.countDocuments({ status: 'pending' }),
      Review.countDocuments(), Interest.countDocuments(), Message.countDocuments(), Community.countDocuments(),
      HoF.countDocuments({ approved: true }), HoF.countDocuments({ approved: false }), Booking.countDocuments(),
    ]);
    res.json({ users, posts, shops, pending, reviews, interests, messages, community, hof, hofPending, bookings, employees: EMPLOYEES.length });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// Serve static frontend files in production
const frontendPath = path.join(__dirname, 'public');
console.log('[static] check frontend path:', frontendPath);
if (fs.existsSync(frontendPath)) {
  console.log('[static] serving frontend from:', frontendPath);
  app.use(express.static(frontendPath));
  // Catch-all to serve index.html for React routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
} else {
  console.error('[static] CRITICAL: frontend folder NOT FOUND at:', frontendPath);
  console.log('[static] current __dirname:', __dirname);
  console.log('[static] listing parent directory contents...');
  try {
    const parentDir = path.join(__dirname, '..');
    console.log('[static] contents of', parentDir, ':', fs.readdirSync(parentDir));
  } catch (e) { console.error('[static] could not read parent dir'); }
}

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Internal server error' });
});

const server = app.listen(PORT, () => console.log(`[divi] server listening on http://localhost:${PORT}`));
const shutdown = (signal) => {
  console.log(`[divi] received ${signal}, shutting down...`);
  server.close(() => mongoose.connection.close(false).then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
