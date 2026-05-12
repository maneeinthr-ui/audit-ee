require('dotenv').config({ override: true });
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { v4: uuidv4 } = require('uuid');
const Anthropic  = require('@anthropic-ai/sdk');
const axios      = require('axios');
const { parse: csvParse } = require('csv-parse/sync');
const mongoose   = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app  = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR  = path.join(__dirname, 'public');
const EXPORTS_DIR = path.join(__dirname, 'export');
[PUBLIC_DIR, EXPORTS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ─── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dvgxapmju',
  api_key:    process.env.CLOUDINARY_API_KEY    || '897998889774845',
  api_secret: process.env.CLOUDINARY_API_SECRET || ''
});

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost/audit-ee';
mongoose.connect(MONGODB_URI)
  .then(() => { console.log('✅ MongoDB connected'); migrateFromJSON(); })
  .catch(err => console.error('❌ MongoDB:', err.message));

// Schemas ─────────────────────────────────────────────────────────────────────
const photoSchema = new mongoose.Schema({
  url:      String,   // Cloudinary secure_url
  publicId: String,   // Cloudinary public_id (for deletion)
  name:     String
}, { _id: false });

const inspectionSchema = new mongoose.Schema({
  id:               { type: String, default: () => `INS-${Date.now()}` },
  codeId:           String,
  technicianId:     String,
  technicianName:   String,
  gps:              Object,
  measurements:     Object,
  ppeChecklist:     Object,
  mdbChecklist:     Object,
  locationInfo:     Object,
  photoFiles:       { type: mongoose.Schema.Types.Mixed, default: [] }, // [{url,publicId}] or [string]
  aiReport:         Object,
  overallStatus:    { type: String, default: 'PENDING' },
  engineerApproval: { type: String, default: null },
  engineerNotes:    { type: String, default: '' },
  engineerName:     String,
  engineerLicense:  String,
  approvedAt:       Date,
  lineSent:         { type: Boolean, default: false },
  photosDeletedAt:  Date
}, { timestamps: true });

const masterSchema = new mongoose.Schema({
  id:        { type: String, default: uuidv4 },
  codeId:    String,
  name:      String,
  location:  String,
  mediaType: String,
  phase:     { type: String, default: '1P' },
  region:    String,
  road:      String,
  lat:       Number,   // Co_Y Latitude
  lng:       Number    // Co_X Longitude
});

const settingsSchema = new mongoose.Schema({
  key:           { type: String, default: 'main', unique: true },
  engineerName:  { type: String, default: 'วิศวกรไฟฟ้า' },
  engineerLicense: String,
  companyName:   { type: String, default: 'Plan B Media' },
  sheetsUrl:     String,
  lineChannelToken: String,
  lineTargetId:  String,
  columnMapping: { type: Object, default: { mediaType: 0, codeId: 1, name: 2, road: 3, region: 4, lat: 5, lng: 6, phase: -1 } },
  lastSheetSync: Date,
  adminPin:      String,
  anthropicKey:  String
});

const Inspection = mongoose.model('Inspection', inspectionSchema);
const Master     = mongoose.model('Master',     masterSchema);
const Settings   = mongoose.model('Settings',   settingsSchema);

async function getSettings() {
  let s = await Settings.findOne({ key: 'main' });
  if (!s) s = await Settings.create({ key: 'main' });
  return s;
}

// ─── First-run migration from JSON files ──────────────────────────────────────
async function migrateFromJSON() {
  const DATA_DIR = path.join(__dirname, 'data');
  try {
    const iCount = await Inspection.countDocuments();
    const mCount = await Master.countDocuments();

    if (iCount === 0) {
      const iFile = path.join(DATA_DIR, 'inspections.json');
      if (fs.existsSync(iFile)) {
        const records = JSON.parse(fs.readFileSync(iFile, 'utf8'));
        if (records.length > 0) {
          await Inspection.insertMany(records, { ordered: false }).catch(() => {});
          console.log(`📦 Migrated ${records.length} inspections → MongoDB`);
        }
      }
    }
    if (mCount === 0) {
      const mFile = path.join(DATA_DIR, 'master.json');
      if (fs.existsSync(mFile)) {
        const records = JSON.parse(fs.readFileSync(mFile, 'utf8'));
        if (records.length > 0) {
          await Master.insertMany(records, { ordered: false }).catch(() => {});
          console.log(`📦 Migrated ${records.length} master records → MongoDB`);
        }
      }
    }
    // Migrate settings
    const sFile = path.join(DATA_DIR, 'settings.json');
    if (fs.existsSync(sFile)) {
      const s = JSON.parse(fs.readFileSync(sFile, 'utf8'));
      await Settings.findOneAndUpdate({ key: 'main' }, { $setOnInsert: s }, { upsert: true, new: true });
    }
  } catch (e) {
    console.warn('Migration warning:', e.message);
  }
}

// ─── Auto-delete Cloudinary photos older than 3 months ───────────────────────
async function deleteOldPhotos() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);
  try {
    const old = await Inspection.find({
      createdAt: { $lt: cutoff },
      photosDeletedAt: { $exists: false }
    });
    let deleted = 0;
    for (const insp of old) {
      const photos = Array.isArray(insp.photoFiles) ? insp.photoFiles : [];
      for (const p of photos) {
        const pid = (typeof p === 'object') ? p.publicId : null;
        if (pid) {
          try { await cloudinary.uploader.destroy(pid); deleted++; } catch (_) {}
        }
      }
      insp.photoFiles    = [];
      insp.photosDeletedAt = new Date();
      await insp.save();
    }
    if (old.length > 0) console.log(`🗑️  Cleaned ${deleted} photos from ${old.length} old inspections`);
  } catch (e) { console.error('[CLEANUP]', e.message); }
}
setInterval(deleteOldPhotos, 24 * 60 * 60 * 1000);
setTimeout(deleteOldPhotos, 60 * 1000); // run 1 min after start

// ─── Dual Storage: Local disk + Cloudinary ────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// 1) บันทึก local disk ก่อน
const localDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dir = path.join(UPLOADS_DIR, dateStr);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    req._uploadDateStr = dateStr;
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage: localDiskStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype))
});

// 2) อัพโหลด Cloudinary หลังจาก multer บันทึก local แล้ว (async, non-blocking)
async function uploadToCloudinary(localPath, dateStr) {
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder: `audit-ee/${dateStr}`,
      resource_type: 'image',
      transformation: [{ width: 1920, height: 1920, crop: 'limit', quality: 'auto:good' }]
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (e) {
    console.warn('[Cloudinary upload skip]', e.message);
    return null;
  }
}

const uploadCSV = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// ป้องกัน browser cache HTML/JS
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR)); // serve รูป local

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getAnthropic() {
  // ดึงคีย์จาก DB ก่อน (ถูกอัพเดทล่าสุด) → fallback env var
  const settings = await getSettings();
  const key = settings.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('ANTHROPIC_API_KEY ไม่ได้ตั้งค่า — ไปที่ Settings เพื่อใส่ API Key');
  return new Anthropic({ apiKey: key });
}

// ─── GPS Haversine Distance (เมตร) ────────────────────────────────────────────
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateGPS(techGps, billboard) {
  if (!billboard?.lat || !billboard?.lng) return { status: 'NO_REF', detail: 'ยังไม่มีพิกัดอ้างอิงป้ายนี้ใน Master Data' };
  if (!techGps?.lat || !techGps?.lng)     return { status: 'NO_GPS', detail: 'ช่างไม่ได้เปิด GPS' };
  const dist = Math.round(haversineMeters(techGps.lat, techGps.lng, billboard.lat, billboard.lng));
  const pass = dist <= 200;
  return {
    status: pass ? 'PASS' : 'FAIL',
    distance: dist,
    detail: pass
      ? `✅ อยู่ห่างป้าย ${dist} เมตร (≤200m ผ่าน)`
      : `❌ อยู่ห่างป้าย ${dist} เมตร (เกิน 200m — ช่างอาจไม่ได้อยู่หน้างาน)`
  };
}

function buildPrompt(d) {
  const loc = d.locationInfo || {};
  const m   = d.measurements || {};
  const ppe = d.ppeChecklist || {};
  const mdb = d.mdbChecklist || {};
  const phaseLabel = m.phase === '3P' ? '3 เฟส 380V' : '1 เฟส 220V';
  const voltStd    = m.phase === '3P' ? '380V' : '220V';
  return `คุณคือ "Audit-EE" ผู้เชี่ยวชาญด้านวิศวกรรมไฟฟ้าและความปลอดภัย บริษัท Plan B Media
ตรวจสอบการซ่อมบำรุงระบบไฟฟ้าป้ายโฆษณาจากช่าง "${d.technicianName}" รหัส ${d.technicianId}

━━ ข้อมูลป้าย ━━
รหัสป้าย: ${d.codeId}  |  ชื่อสถานที่: ${loc.name||'ไม่ระบุ'}
ที่ตั้ง: ${loc.location||'ไม่ระบุ'}  |  ประเภทสื่อ: ${loc.mediaType||'ไม่ระบุ'}  |  ระบบ: ${phaseLabel}

━━ ค่าที่ช่างบันทึก ━━
Ground Resistance : ${m.groundResistance??'-'} Ω   (เกณฑ์ วสท.: ≤ 5 Ω)
Continuity Ground : ${m.continuityGround??'-'} Ω   (เกณฑ์ วสท.: < 0.5 Ω)
Leakage Current   : ${m.leakageCurrent??'-'} mA  (เกณฑ์: <10 ปกติ | 10-30 เฝ้าระวัง | >30 อันตราย)
แรงดันไฟฟ้า       : ${m.voltage??'-'} V   (เกณฑ์: ${voltStd})

━━ PPE Checklist ━━
หมวกนิรภัย: ${ppe.helmet?'✓':'✗'}  ถุงมือยาง: ${ppe.gloves?'✓':'✗'}  รองเท้านิรภัย: ${ppe.safetyShoes?'✓':'✗'}
เสื้อสะท้อนแสง: ${ppe.vest?'✓':'✗'}  แว่นตานิรภัย: ${ppe.glasses?'✓':'✗'}

━━ MDB Checklist ━━
เบรกเกอร์: ${mdb.breaker?'✓':'✗'}  ทามเมอร์: ${mdb.timer?'✓':'✗'}  แมกเนติก: ${mdb.magnetic?'✓':'✗'}  Wiring: ${mdb.wiring?'✓':'✗'}

━━ รูปภาพ ━━
มีรูปภาพแนบมา ${d.photoCount||0} รูป กรุณาวิเคราะห์ทุกรูปและอ่านค่าจากหน้าจอมิเตอร์ (OCR)

━━ เกณฑ์มาตรฐาน วสท. (ห้ามผ่อนปรน) ━━
• Ground Resistance ≤ 5 Ω — หากเกิน REJECT ทันที
• Continuity Ground < 0.5 Ω
• Leakage Current < 10 mA ปกติ | > 30 mA = CRITICAL
• Voltage ${voltStd} (±10%)
• PPE ต้องครบทุกชิ้นก่อนเริ่มงาน — ขาดชิ้นใดชิ้นหนึ่ง = FAIL Safety

วิเคราะห์รูปภาพทั้งหมด เปรียบเทียบค่า OCR กับค่าที่ช่างบันทึก และตรวจสอบ PPE จากรูปถ่าย
ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความก่อนหรือหลัง JSON:
{
  "ppeStatus": "ผ่าน" or "ไม่ผ่าน",
  "ppeDetail": "...",
  "ocrReadings": { "groundResistance": "...", "continuityGround": "...", "leakageCurrent": "...", "voltage": "..." },
  "ocrMatchCheck": "ตรงกัน or ไม่ตรงกัน or ไม่มีรูป",
  "ocrMatchDetail": "...",
  "standardCheck": "ผ่าน" or "ไม่ผ่าน",
  "standardDetail": "...",
  "locationCheck": "ผ่าน" or "ไม่สามารถยืนยันได้",
  "locationDetail": "...",
  "mdbStatus": "ผ่าน" or "ไม่ผ่าน" or "ไม่มีข้อมูล",
  "mdbDetail": "...",
  "riskLevel": "LOW" or "MEDIUM" or "HIGH" or "CRITICAL",
  "riskReason": "...",
  "findings": ["..."],
  "overallStatus": "PASS" or "FAIL",
  "microLesson": "ข้อสอบปรนัย 2 ข้อ (เฉพาะเมื่อ FAIL) พร้อมเฉลยและเหตุผลวิศวกรรม เหมาะก๊อปปี้ส่ง LINE"
}`;
}

function buildLineMessage(inspection, report) {
  const riskEmoji = { LOW:'🟢', MEDIUM:'🟡', HIGH:'🟠', CRITICAL:'🔴' };
  const emoji = riskEmoji[report.riskLevel] || '⚪';
  const loc   = inspection.locationInfo || {};
  const dateStr = new Date(inspection.createdAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  let msg = `\n${emoji} Audit-EE — ${report.riskLevel} ALERT\n━━━━━━━━━━━━━━━━━\n`;
  msg += `ช่าง: ${inspection.technicianName} (รหัส ${inspection.technicianId})\n`;
  msg += `ป้าย: ${inspection.codeId} — ${loc.name||''}\nวันที่: ${dateStr}\n`;
  msg += `ผล: ${report.overallStatus==='PASS'?'✅ ผ่าน':'❌ ไม่ผ่าน'}\n`;
  if (report.findings?.length) { msg += `\n⚠️ จุดบกพร่อง:\n`; report.findings.forEach(f => { msg += `• ${f}\n`; }); }
  if (report.microLesson && report.overallStatus==='FAIL') msg += `\n📚 Micro-Lesson:\n${report.microLesson}`;
  return msg.slice(0, 1000);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try { res.json(await getSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const body = req.body;
    if (body.anthropicKey)      process.env.ANTHROPIC_API_KEY  = body.anthropicKey;
    if (body.lineChannelToken)  process.env.LINE_CHANNEL_TOKEN = body.lineChannelToken;
    if (body.lineTargetId)      process.env.LINE_TARGET_ID     = body.lineTargetId;
    if (body.sheetsUrl)         process.env.GOOGLE_SHEETS_URL  = body.sheetsUrl;
    const s = await Settings.findOneAndUpdate({ key: 'main' }, { $set: body }, { upsert: true, new: true });
    res.json({ success: true, settings: s });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Master data ───────────────────────────────────────────────────────────────
app.get('/api/master', async (req, res) => {
  try { res.json(await Master.find({}).lean()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/master', async (req, res) => {
  try { const item = await Master.create({ ...req.body, id: uuidv4() }); res.status(201).json(item); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/master/:id', async (req, res) => {
  try {
    const item = await Master.findOneAndUpdate({ id: req.params.id }, { $set: req.body }, { new: true });
    if (!item) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/master/:id', async (req, res) => {
  try { await Master.deleteOne({ id: req.params.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync from Google Sheets
app.post('/api/master/sync', async (req, res) => {
  try {
    const settings = await getSettings();
    const url = req.body.url || settings.sheetsUrl || process.env.GOOGLE_SHEETS_URL;
    if (!url) return res.status(400).json({ error: 'ไม่ได้ตั้งค่า Google Sheets URL' });
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const csvText  = Buffer.from(response.data).toString('utf8');
    const records  = csvParse(csvText, { skip_empty_lines: true, relax_column_count: true });
    const mapping  = settings.columnMapping || { codeId:0,name:1,location:2,mediaType:3,phase:4,region:5 };
    const items    = records.slice(1).map(row => {
      const latVal = mapping.lat >= 0 ? parseFloat(row[mapping.lat]) : NaN;
      const lngVal = mapping.lng >= 0 ? parseFloat(row[mapping.lng]) : NaN;
      return {
      id: uuidv4(), codeId: String(row[mapping.codeId]||'').trim(),
      name: String(row[mapping.name]||'').trim(), location: String(row[mapping.location]||'').trim(),
      mediaType: String(row[mapping.mediaType]||'').trim(),
      phase: mapping.phase >= 0 ? String(row[mapping.phase]||'1P').trim() : '1P',
      region: String(row[mapping.region >= 0 ? mapping.region : 5]||'').trim(),
      road: mapping.road >= 0 ? String(row[mapping.road]||'').trim() : '',
      lat: isNaN(latVal) ? undefined : latVal,
      lng: isNaN(lngVal) ? undefined : lngVal
    };}).filter(r => r.codeId);
    await Master.deleteMany({});
    if (items.length > 0) await Master.insertMany(items);
    const syncedAt = new Date();
    const withGps  = items.filter(i => i.lat && i.lng).length;
    await Settings.findOneAndUpdate({ key: 'main' }, { $set: { lastSheetSync: syncedAt, sheetsUrl: url } });
    res.json({ success: true, count: items.length, withGps, syncedAt });
  } catch (e) { res.status(500).json({ error: `Sync ล้มเหลว: ${e.message}` }); }
});

// Import CSV
app.post('/api/master/import', uploadCSV.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ไม่มีไฟล์' });
    const csvText = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);
    const settings = await getSettings();
    const mapping  = settings.columnMapping || { codeId:0,name:1,location:2,mediaType:3,phase:4,region:5 };
    const records  = csvParse(csvText, { skip_empty_lines: true, relax_column_count: true });
    const items    = records.slice(1).map(row => {
      const latVal = mapping.lat >= 0 ? parseFloat(row[mapping.lat]) : NaN;
      const lngVal = mapping.lng >= 0 ? parseFloat(row[mapping.lng]) : NaN;
      return {
        id: uuidv4(), codeId: String(row[mapping.codeId]||'').trim(), name: String(row[mapping.name]||'').trim(),
        location: String(row[mapping.location]||'').trim(), mediaType: String(row[mapping.mediaType]||'').trim(),
        phase: mapping.phase >= 0 ? String(row[mapping.phase]||'1P').trim() : '1P',
        region: String(row[mapping.region >= 0 ? mapping.region : 5]||'').trim(),
        road: mapping.road >= 0 ? String(row[mapping.road]||'').trim() : '',
        lat: isNaN(latVal) ? undefined : latVal,
        lng: isNaN(lngVal) ? undefined : lngVal
      };
    }).filter(r => r.codeId);
    await Master.deleteMany({});
    if (items.length > 0) await Master.insertMany(items);
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inspections ───────────────────────────────────────────────────────────────
app.get('/api/inspections', async (req, res) => {
  try {
    const { status, techId, codeId, from, to, risk, approval } = req.query;
    const filter = {};
    if (status) filter.overallStatus = status;
    if (techId) filter.technicianId  = techId;
    if (codeId) filter.codeId        = codeId;
    if (risk) {
      // รองรับหลายค่า: "HIGH,CRITICAL" → $in
      const arr = String(risk).split(',').filter(Boolean);
      filter['aiReport.riskLevel'] = arr.length > 1 ? { $in: arr } : arr[0];
    }
    // กรองตามสถานะวิศวกร: APPROVED / REJECTED / AWAITING (null)
    if (approval === 'AWAITING') {
      filter.$or = [{ engineerApproval: null }, { engineerApproval: { $exists: false } }];
    } else if (approval) {
      filter.engineerApproval = approval;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to + 'T23:59:59');
    }
    const data = await Inspection.find(filter).sort({ createdAt: -1 }).lean();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inspections', async (req, res) => {
  try {
    // GPS Validation ก่อนบันทึก
    const billboard = await Master.findOne({ codeId: req.body.codeId }).lean();
    const gpsResult = validateGPS(req.body.gps, billboard);

    // แทรก gpsValidation เข้า aiReport
    const aiReport = { ...(req.body.aiReport || {}), gpsValidation: gpsResult };

    const rec = await Inspection.create({
      ...req.body,
      aiReport,
      id: `INS-${Date.now()}`,
      overallStatus:    req.body.aiReport?.overallStatus || 'PENDING',
      engineerApproval: null,
      engineerNotes:    '',
      lineSent:         false
    });
    res.status(201).json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inspections/:id', async (req, res) => {
  try {
    const rec = await Inspection.findOne({ id: req.params.id }).lean();
    if (!rec) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/inspections/:id/approve', async (req, res) => {
  try {
    const settings = await getSettings();
    const rec = await Inspection.findOneAndUpdate(
      { id: req.params.id },
      { $set: {
          engineerApproval: req.body.decision,
          engineerNotes:    req.body.notes || '',
          engineerName:     settings.engineerName,
          engineerLicense:  settings.engineerLicense,
          approvedAt:       new Date()
        }
      },
      { new: true }
    );
    if (!rec) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/inspections/:id', async (req, res) => {
  try {
    const rec = await Inspection.findOne({ id: req.params.id });
    if (rec) {
      // Delete photos from Cloudinary
      const photos = Array.isArray(rec.photoFiles) ? rec.photoFiles : [];
      for (const p of photos) {
        const pid = (typeof p === 'object') ? p.publicId : null;
        if (pid) { try { await cloudinary.uploader.destroy(pid); } catch (_) {} }
      }
      await rec.deleteOne();
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI Analysis ───────────────────────────────────────────────────────────────
app.post('/api/analyze', upload.array('photos', 10), async (req, res) => {
  const uploadedFiles = req.files || [];
  try {
    // PIN check
    const settings = await getSettings();
    const adminPin  = settings.adminPin || process.env.ADMIN_PIN || '';
    if (adminPin && (req.body.adminPin || '') !== adminPin) {
      return res.status(403).json({ error: 'PIN ไม่ถูกต้อง — เฉพาะวิศวกรเท่านั้นที่วิเคราะห์ได้' });
    }

    const client   = await getAnthropic();
    const inspData = JSON.parse(req.body.inspectionData || '{}');
    inspData.photoCount = uploadedFiles.length;

    // อัพโหลด Cloudinary แบบ parallel (รูปถูก save local แล้ว)
    const cldResults = await Promise.all(
      uploadedFiles.map(f => uploadToCloudinary(f.path, f.destination.split(path.sep).pop()))
    );

    // Build content: ใช้ base64 จาก local file ส่งให้ Claude (เร็วกว่า URL)
    const content = [];
    for (const file of uploadedFiles) {
      try {
        const data = fs.readFileSync(file.path).toString('base64');
        const mime = file.mimetype || 'image/jpeg';
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
      } catch (_) {}
    }
    content.push({ type: 'text', text: buildPrompt(inspData) });

    const message = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 4096,
      messages:   [{ role: 'user', content }]
    });

    const raw = message.content[0].text;
    let report;
    try {
      let stripped = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
      const fb = stripped.indexOf('{'), lb = stripped.lastIndexOf('}');
      if (fb !== -1 && lb > fb) stripped = stripped.slice(fb, lb + 1);
      report = JSON.parse(stripped);
    } catch (parseErr) {
      report = { rawResponse: raw, overallStatus: 'FAIL', riskLevel: 'MEDIUM', findings: [`AI parse error: ${parseErr.message}`] };
    }

    // สร้าง photoFiles: local path + Cloudinary url (ถ้ามี)
    const dateStr = uploadedFiles[0]?.destination.split(path.sep).pop() || '';
    const photoFiles = uploadedFiles.map((f, i) => ({
      localPath: `${dateStr}/${f.filename}`,          // path local สำหรับ serve /uploads/
      url:       cldResults[i]?.url || `/uploads/${dateStr}/${f.filename}`,
      publicId:  cldResults[i]?.publicId || '',
      name:      f.originalname || ''
    }));

    res.json({ success: true, report, photoFiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload photos only (no AI)
app.post('/api/upload-photos', upload.array('photos', 10), async (req, res) => {
  const files = req.files || [];
  const dateStr = files[0]?.destination.split(path.sep).pop() || '';
  const cldResults = await Promise.all(files.map(f => uploadToCloudinary(f.path, dateStr)));
  const photoFiles = files.map((f, i) => ({
    localPath: `${dateStr}/${f.filename}`,
    url:       cldResults[i]?.url || `/uploads/${dateStr}/${f.filename}`,
    publicId:  cldResults[i]?.publicId || '',
    name:      f.originalname || ''
  }));
  res.json({ photoFiles });
});

// ── LINE ──────────────────────────────────────────────────────────────────────
app.post('/api/line/send', async (req, res) => {
  try {
    const settings  = await getSettings();

    // ── PIN verification (เมื่อ score < 80 ระบบจะส่ง pin มาด้วย) ────────────
    const adminPin = settings.adminPin || process.env.ADMIN_PIN || '';
    if (req.body.requirePin) {
      if (!adminPin) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า PIN ใน Settings' });
      if ((req.body.pin || '') !== adminPin) {
        return res.status(403).json({ error: 'PIN ไม่ถูกต้อง', wrongPin: true });
      }
    }

    const token     = req.body.token    || settings.lineChannelToken || process.env.LINE_CHANNEL_TOKEN;
    const targetId  = req.body.targetId || settings.lineTargetId    || process.env.LINE_TARGET_ID;
    if (!token)    return res.status(400).json({ error: 'ไม่ได้ตั้งค่า LINE Channel Access Token' });
    if (!targetId) return res.status(400).json({ error: 'ไม่ได้ตั้งค่า LINE Target ID' });

    let message = req.body.message;
    if (!message && req.body.inspectionId) {
      const rec = await Inspection.findOne({ id: req.body.inspectionId }).lean();
      if (rec?.aiReport) message = buildLineMessage(rec, rec.aiReport);
    }
    if (!message) return res.status(400).json({ error: 'ไม่มีข้อความ' });

    const messages = [];
    const MARKER   = '\n\n📚 Micro-Lesson:';
    const splitAt  = message.indexOf(MARKER);
    if (splitAt !== -1 && message.length > 1000) {
      messages.push({ type: 'text', text: message.slice(0, splitAt).trim() });
      messages.push({ type: 'text', text: message.slice(splitAt).trim() });
    } else {
      messages.push({ type: 'text', text: message });
    }

    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: targetId, messages },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: 10000 }
    );

    if (req.body.inspectionId) {
      await Inspection.findOneAndUpdate({ id: req.body.inspectionId }, { $set: { lineSent: true } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `LINE ส่งไม่สำเร็จ: ${err.response?.data?.message || err.message}` });
  }
});

// LINE Webhook
let lastLineEvents = [];
app.post('/webhook/line', (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];
  events.forEach(ev => {
    const src = ev.source || {};
    const entry = { type: src.type, id: src.groupId||src.roomId||src.userId, userId: src.userId,
      eventType: ev.type, text: ev.message?.text||'', timestamp: new Date().toISOString() };
    lastLineEvents.unshift(entry);
    lastLineEvents = lastLineEvents.slice(0, 20);
    console.log(`[LINE Webhook] ${entry.type} ID: ${entry.id} | "${entry.text}"`);
  });
});
app.get('/api/line/discovered-ids', (req, res) => res.json(lastLineEvents));

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [data, settings] = await Promise.all([
      Inspection.find({}).sort({ createdAt: -1 }).lean(),
      getSettings()
    ]);
    const now      = new Date();
    const byStatus = { PASS:0, FAIL:0, PENDING:0 };
    const byRisk   = { LOW:0, MEDIUM:0, HIGH:0, CRITICAL:0 };
    const byApproval = { APPROVED:0, REJECTED:0, AWAITING:0 };
    const monthly  = {};
    let thisMonth  = 0;

    data.forEach(i => {
      const s = i.overallStatus || 'PENDING';
      byStatus[s] = (byStatus[s]||0) + 1;
      const r = i.aiReport?.riskLevel || 'MEDIUM';
      byRisk[r]   = (byRisk[r]||0) + 1;
      // นับสถานะวิศวกร: APPROVED / REJECTED / AWAITING (ยังไม่ดำเนินการ)
      if (i.engineerApproval === 'APPROVED')      byApproval.APPROVED++;
      else if (i.engineerApproval === 'REJECTED') byApproval.REJECTED++;
      else                                          byApproval.AWAITING++;
      const d = new Date(i.createdAt);
      if (d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear()) thisMonth++;
      const key = new Date(i.createdAt).toISOString().slice(0,7);
      monthly[key] = (monthly[key]||0) + 1;
    });

    res.json({
      total:    data.length,
      passRate: data.length > 0 ? Math.round((byStatus.PASS/data.length)*100) : 0,
      critical: byRisk.CRITICAL,
      thisMonth,
      byStatus,
      byRisk,
      byApproval,    // ← ใหม่: สถิติการอนุมัติของวิศวกร
      monthly:  Object.entries(monthly).sort().slice(-6).map(([month,count])=>({ month,count })),
      lastSheetSync: settings.lastSheetSync,
      recent:   data.slice(0, 8)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export Excel ──────────────────────────────────────────────────────────────
app.get('/api/export/excel', async (req, res) => {
  const ExcelJS = require('exceljs');
  try {
    const [data, settings] = await Promise.all([Inspection.find({}).sort({createdAt:-1}).lean(), getSettings()]);
    const wb = new ExcelJS.Workbook();
    wb.creator = settings.engineerName || 'Audit-EE';
    wb.created = new Date();

    const ws = wb.addWorksheet('รายงานการตรวจสอบ');
    ws.columns = [
      {header:'วันที่ตรวจ',key:'date',width:14},{header:'Code ID',key:'codeId',width:10},
      {header:'ชื่อสถานที่',key:'name',width:28},{header:'ที่ตั้ง',key:'location',width:30},
      {header:'ช่าง',key:'tech',width:12},{header:'รหัสช่าง',key:'techId',width:10},
      {header:'Ground(Ω)',key:'ground',width:12},{header:'Continuity(Ω)',key:'continuity',width:14},
      {header:'Leakage(mA)',key:'leakage',width:13},{header:'Voltage(V)',key:'voltage',width:12},
      {header:'Phase',key:'phase',width:8},{header:'PPE',key:'ppe',width:8},
      {header:'ผล',key:'status',width:10},{header:'Risk',key:'risk',width:10},
      {header:'วิศวกรอนุมัติ',key:'eng',width:14},{header:'หมายเหตุ',key:'notes',width:30}
    ];
    ws.getRow(1).eachCell(cell => {
      cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A5F'}};
      cell.font = {bold:true,color:{argb:'FFFFFFFF'},size:11};
      cell.alignment = {vertical:'middle',horizontal:'center',wrapText:true};
    });
    ws.getRow(1).height = 28;

    data.forEach(i => {
      const ppeCount = Object.values(i.ppeChecklist||{}).filter(Boolean).length;
      const risk     = i.aiReport?.riskLevel || '';
      const row = ws.addRow({
        date: i.createdAt ? new Date(i.createdAt).toISOString().slice(0,10) : '',
        codeId: i.codeId, name: i.locationInfo?.name||'', location: i.locationInfo?.location||'',
        tech: i.technicianName, techId: i.technicianId,
        ground: i.measurements?.groundResistance, continuity: i.measurements?.continuityGround,
        leakage: i.measurements?.leakageCurrent, voltage: i.measurements?.voltage,
        phase: i.measurements?.phase, ppe: `${ppeCount}/5`,
        status: i.overallStatus||'', risk, eng: i.engineerApproval||'รอ', notes: i.engineerNotes||''
      });
      const gc = row.getCell('ground');
      if ((i.measurements?.groundResistance??0) > 5) {
        gc.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFCA5A5'}};
        gc.font = {bold:true,color:{argb:'FF991B1B'}};
      }
      const sc = row.getCell('status');
      sc.fill = {type:'pattern',pattern:'solid',fgColor:{argb:i.overallStatus==='FAIL'?'FFFCA5A5':'FF86EFAC'}};
      sc.font = {bold:true}; sc.alignment = {horizontal:'center'};
      const rc = row.getCell('risk');
      rc.fill = {type:'pattern',pattern:'solid',fgColor:{argb:risk==='CRITICAL'?'FFEF4444':risk==='HIGH'?'FFFB923C':risk==='MEDIUM'?'FFFBBF24':'FF4ADE80'}};
      rc.font = {bold:true,color:{argb:risk==='LOW'?'FF166534':'FFFFFFFF'}}; rc.alignment={horizontal:'center'};
      row.eachCell(c => { c.border={bottom:{style:'hair',color:{argb:'FFE2E8F0'}}}; });
      row.height = 20;
    });
    ws.views = [{state:'frozen',ySplit:1}];
    ws.autoFilter = {from:'A1',to:'P1'};

    const ws2 = wb.addWorksheet('สรุปรายช่าง');
    const techMap = {};
    data.forEach(i => {
      const k = `${i.technicianName} (${i.technicianId})`;
      if (!techMap[k]) techMap[k] = {total:0,pass:0,fail:0,high:0};
      techMap[k].total++;
      if (i.overallStatus==='PASS') techMap[k].pass++; else techMap[k].fail++;
      if (['HIGH','CRITICAL'].includes(i.aiReport?.riskLevel)) techMap[k].high++;
    });
    ws2.columns = [{header:'ช่าง',key:'tech',width:20},{header:'ทั้งหมด',key:'total',width:10},
      {header:'ผ่าน',key:'pass',width:10},{header:'ไม่ผ่าน',key:'fail',width:10},
      {header:'% ผ่าน',key:'pct',width:10},{header:'HIGH Risk',key:'high',width:12}];
    ws2.getRow(1).eachCell(c => {
      c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A5F'}};
      c.font={bold:true,color:{argb:'FFFFFFFF'}}; c.alignment={horizontal:'center'};
    });
    Object.entries(techMap).forEach(([tech,s]) => {
      const pct = s.total ? Math.round(s.pass/s.total*100) : 0;
      const r   = ws2.addRow({tech,total:s.total,pass:s.pass,fail:s.fail,pct:pct+'%',high:s.high});
      r.getCell('pct').fill={type:'pattern',pattern:'solid',fgColor:{argb:pct>=80?'FF86EFAC':pct>=60?'FFFBBF24':'FFFCA5A5'}};
    });

    const dateStr  = new Date().toISOString().slice(0,10);
    const fileName = `AuditEE-${dateStr}.xlsx`;
    const filePath = path.join(EXPORTS_DIR, fileName);
    const buffer   = await wb.xlsx.writeBuffer();

    // บันทึกลง local เสมอ
    fs.writeFileSync(filePath, buffer);
    console.log(`📊 Export saved: export\\${fileName}`);

    // ส่งให้ browser download เสมอ + บันทึก local ไว้ด้วย
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Saved-Path', `export\\${fileName}`);
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export CSV
app.get('/api/export/csv', async (req, res) => {
  try {
    const data   = await Inspection.find({}).sort({createdAt:-1}).lean();
    const header = ['ID','Date','Code ID','Location','Technician','Tech ID','Ground(Ω)','Continuity(Ω)','Leakage(mA)','Voltage(V)','Phase','PPE','Status','Risk','Engineer Approval'];
    const rows   = data.map(i => [
      i.id, new Date(i.createdAt).toISOString().slice(0,10), i.codeId,
      i.locationInfo?.name||'', i.technicianName, i.technicianId,
      i.measurements?.groundResistance, i.measurements?.continuityGround,
      i.measurements?.leakageCurrent, i.measurements?.voltage, i.measurements?.phase,
      Object.values(i.ppeChecklist||{}).filter(Boolean).length+'/5',
      i.overallStatus, i.aiReport?.riskLevel||'', i.engineerApproval||''
    ]);
    const csv = [header,...rows].map(r=>r.map(c=>`"${c??''}"`).join(',')).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="audit-ee-${Date.now()}.csv"`);
    res.send('﻿'+csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cloudinary status check
app.get('/api/cloudinary/usage', async (req, res) => {
  try {
    const ping = await cloudinary.api.ping();
    res.json({ status: ping.status, cloud_name: cloudinary.config().cloud_name, connected: true });
  } catch (e) { res.status(500).json({ error: e.message, connected: false }); }
});

// Network info
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family==='IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
app.get('/api/network-info', (req, res) => res.json({ ip: getLocalIP(), port: PORT }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  ⚡ Audit-EE  |  Plan B Media                    ║`);
  console.log(`║  💻 PC:     http://localhost:${PORT}                ║`);
  console.log(`║  📱 มือถือ: http://${ip}:${PORT}           ║`);
  console.log(`║  ☁️  DB:     MongoDB Atlas (shared)               ║`);
  console.log(`║  🖼️  Photos: Cloudinary (auto-delete 3 months)   ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
  if (!process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_API_SECRET.includes('ใส่')) {
    console.log('⚠️  CLOUDINARY_API_SECRET ยังไม่ได้ตั้งค่า — ใส่ใน .env');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  ANTHROPIC_API_KEY ไม่ได้ตั้งค่า — ไปที่ Settings ในแอป');
  }
});
