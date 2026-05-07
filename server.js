require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { parse: csvParse } = require('csv-parse/sync');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── directories ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

[DATA_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const DEFAULT_SETTINGS = {
  engineerName: 'วิศวกรไฟฟ้า',
  engineerLicense: '',
  companyName: 'Plan B Media',
  sheetsUrl: process.env.GOOGLE_SHEETS_URL || '',
  lineChannelToken: process.env.LINE_CHANNEL_TOKEN || '',
  lineTargetId: process.env.LINE_TARGET_ID || '',
  columnMapping: { codeId: 0, name: 1, location: 2, mediaType: 3, phase: 4, region: 5 },
  lastSheetSync: null
};

function initData(filename, def) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(def, null, 2), 'utf8');
}
initData('inspections.json', []);
initData('master.json', []);
initData('settings.json', DEFAULT_SETTINGS);

// ─── middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(null, ok);
  }
});
const uploadCSV = multer({ dest: UPLOADS_DIR, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── helpers ───────────────────────────────────────────────────────────────────
const readJSON = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const writeJSON = (f, d) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2), 'utf8');

function getAnthropic() {
  // Check env first, then settings.json as fallback
  const key = process.env.ANTHROPIC_API_KEY || readJSON('settings.json').anthropicKey || '';
  if (!key) throw new Error('ANTHROPIC_API_KEY ไม่ได้ตั้งค่า — ไปที่ Settings เพื่อใส่ API Key');
  return new Anthropic({ apiKey: key });
}

// ─── analysis prompt ──────────────────────────────────────────────────────────
function buildPrompt(d) {
  const loc = d.locationInfo || {};
  const m = d.measurements || {};
  const ppe = d.ppeChecklist || {};
  const mdb = d.mdbChecklist || {};
  const phaseLabel = m.phase === '3P' ? '3 เฟส 380V' : '1 เฟส 220V';
  const voltStd = m.phase === '3P' ? '380V' : '220V';

  return `คุณคือ "Audit-EE" ผู้เชี่ยวชาญด้านวิศวกรรมไฟฟ้าและความปลอดภัย บริษัท Plan B Media
ตรวจสอบการซ่อมบำรุงระบบไฟฟ้าป้ายโฆษณาจากช่าง "${d.technicianName}" รหัส ${d.technicianId}

━━ ข้อมูลป้าย ━━
รหัสป้าย: ${d.codeId}  |  ชื่อสถานที่: ${loc.name || 'ไม่ระบุ'}
ที่ตั้ง: ${loc.location || 'ไม่ระบุ'}  |  ประเภทสื่อ: ${loc.mediaType || 'ไม่ระบุ'}  |  ระบบ: ${phaseLabel}

━━ ค่าที่ช่างบันทึก ━━
Ground Resistance : ${m.groundResistance ?? '-'} Ω   (เกณฑ์ วสท.: ≤ 5 Ω)
Continuity Ground : ${m.continuityGround ?? '-'} Ω   (เกณฑ์ วสท.: < 0.5 Ω)
Leakage Current   : ${m.leakageCurrent ?? '-'} mA  (เกณฑ์: <10 mA ปกติ | 10-30 mA เฝ้าระวัง | >30 mA อันตราย)
แรงดันไฟฟ้า       : ${m.voltage ?? '-'} V   (เกณฑ์: ${voltStd})

━━ PPE Checklist ━━
หมวกนิรภัย: ${ppe.helmet ? '✓' : '✗'}  ถุงมือยาง: ${ppe.gloves ? '✓' : '✗'}  รองเท้านิรภัย: ${ppe.safetyShoes ? '✓' : '✗'}
เสื้อสะท้อนแสง: ${ppe.vest ? '✓' : '✗'}  แว่นตานิรภัย: ${ppe.glasses ? '✓' : '✗'}

━━ MDB Checklist ━━
เบรกเกอร์: ${mdb.breaker ? '✓' : '✗'}  ทามเมอร์: ${mdb.timer ? '✓' : '✗'}  แมกเนติก: ${mdb.magnetic ? '✓' : '✗'}  Wiring: ${mdb.wiring ? '✓' : '✗'}

━━ รูปภาพ ━━
มีรูปภาพแนบมา ${d.photoCount || 0} รูป กรุณาวิเคราะห์ทุกรูปและอ่านค่าจากหน้าจอมิเตอร์ (OCR)

━━ เกณฑ์มาตรฐาน วสท. (ห้ามผ่อนปรน) ━━
• Ground Resistance (Earth Tester 3 Pole): ≤ 5 Ω — หากเกิน REJECT ทันที
• Continuity Ground (มัลติมิเตอร์): < 0.5 Ω
• Leakage Current (Clamp Meter Leakage Mode): < 10 mA ปกติ | > 30 mA = CRITICAL ส่งไฟฟ้ารั่วแน่นอน
• Voltage: ${voltStd} (±10%)
• PPE ต้องครบทุกชิ้นก่อนเริ่มงาน — ขาดชิ้นใดชิ้นหนึ่ง = FAIL Safety

วิเคราะห์รูปภาพทั้งหมด เปรียบเทียบค่า OCR กับค่าที่ช่างบันทึก และตรวจสอบ PPE จากรูปถ่าย

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความก่อนหรือหลัง JSON:
{
  "ppeStatus": "ผ่าน" or "ไม่ผ่าน",
  "ppeDetail": "สิ่งที่เห็นในรูปเกี่ยวกับ PPE (ถ้าไม่มีรูปให้ประเมินจาก checklist)",
  "ocrReadings": {
    "groundResistance": "ค่าที่อ่านจากรูป หรือ ไม่มีรูป",
    "continuityGround": "...",
    "leakageCurrent": "...",
    "voltage": "..."
  },
  "ocrMatchCheck": "ตรงกัน or ไม่ตรงกัน or ไม่มีรูป",
  "ocrMatchDetail": "อธิบายความแตกต่าง (ถ้ามี)",
  "standardCheck": "ผ่าน" or "ไม่ผ่าน",
  "standardDetail": "รายละเอียดค่าที่ไม่ผ่าน พร้อมตัวเลขจริงที่วัดได้",
  "locationCheck": "ผ่าน" or "ไม่สามารถยืนยันได้",
  "locationDetail": "รายละเอียดการตรวจสอบสถานที่จากรูป",
  "mdbStatus": "ผ่าน" or "ไม่ผ่าน" or "ไม่มีข้อมูล",
  "mdbDetail": "สภาพอุปกรณ์ใน MDB จากรูปหรือ checklist",
  "riskLevel": "LOW" or "MEDIUM" or "HIGH" or "CRITICAL",
  "riskReason": "เหตุผลที่กำหนดระดับความเสี่ยงนี้",
  "findings": ["ข้อบกพร่องที่พบ 1", "ข้อบกพร่องที่พบ 2"],
  "overallStatus": "PASS" or "FAIL",
  "microLesson": "ข้อสอบปรนัย 2 ข้อ (เฉพาะเมื่อ FAIL) พร้อมเฉลยและอธิบายเหตุผลวิศวกรรมอย่างละเอียด เหมาะก๊อปปี้ส่ง LINE ให้ช่างทันที"
}`;
}

// ─── LINE Notify message builder ──────────────────────────────────────────────
function buildLineMessage(inspection, report) {
  const riskEmoji = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };
  const emoji = riskEmoji[report.riskLevel] || '⚪';
  const loc = inspection.locationInfo || {};
  const dateStr = new Date(inspection.createdAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  let msg = `\n${emoji} Audit-EE — ${report.riskLevel} ALERT\n`;
  msg += `━━━━━━━━━━━━━━━━━\n`;
  msg += `ช่าง: ${inspection.technicianName} (รหัส ${inspection.technicianId})\n`;
  msg += `ป้าย: ${inspection.codeId} — ${loc.name || ''}\n`;
  msg += `วันที่: ${dateStr}\n`;
  msg += `ผล: ${report.overallStatus === 'PASS' ? '✅ ผ่าน' : '❌ ไม่ผ่าน'}\n`;

  if (report.findings?.length) {
    msg += `\n⚠️ จุดบกพร่อง:\n`;
    report.findings.forEach(f => { msg += `• ${f}\n`; });
  }

  if (report.microLesson && report.overallStatus === 'FAIL') {
    msg += `\n📚 Micro-Lesson:\n${report.microLesson}`;
  }

  return msg.slice(0, 1000); // LINE Notify limit 1000 chars
}

// ─── ROUTES ────────────────────────────────────────────────────────────────────

// Settings
app.get('/api/settings', (req, res) => res.json(readJSON('settings.json')));

app.put('/api/settings', (req, res) => {
  const current = readJSON('settings.json');
  const body = req.body;
  // Update env vars live
  if (body.anthropicKey) {
    process.env.ANTHROPIC_API_KEY = body.anthropicKey;
    // Persist key in settings.json so it survives server restart
    body.anthropicKey = body.anthropicKey;
  }
  if (body.lineChannelToken !== undefined) process.env.LINE_CHANNEL_TOKEN = body.lineChannelToken;
  if (body.lineTargetId !== undefined) process.env.LINE_TARGET_ID = body.lineTargetId;
  if (body.sheetsUrl !== undefined) process.env.GOOGLE_SHEETS_URL = body.sheetsUrl;
  const updated = { ...current, ...body };
  writeJSON('settings.json', updated);
  res.json({ success: true, settings: updated });
});

// Master data
app.get('/api/master', (req, res) => res.json(readJSON('master.json')));

app.post('/api/master', (req, res) => {
  const master = readJSON('master.json');
  const item = { ...req.body, id: uuidv4() };
  master.push(item);
  writeJSON('master.json', master);
  res.status(201).json(item);
});

app.put('/api/master/:id', (req, res) => {
  const master = readJSON('master.json');
  const idx = master.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  master[idx] = { ...master[idx], ...req.body };
  writeJSON('master.json', master);
  res.json(master[idx]);
});

app.delete('/api/master/:id', (req, res) => {
  const master = readJSON('master.json');
  writeJSON('master.json', master.filter(m => m.id !== req.params.id));
  res.json({ success: true });
});

// Sync from Google Sheets via CSV export URL
app.post('/api/master/sync', async (req, res) => {
  try {
    const settings = readJSON('settings.json');
    const url = req.body.url || settings.sheetsUrl || process.env.GOOGLE_SHEETS_URL;
    if (!url) return res.status(400).json({ error: 'ไม่ได้ตั้งค่า Google Sheets URL ใน Settings' });

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { Accept: 'text/csv' }
    });

    const csvText = Buffer.from(response.data).toString('utf8');
    const records = csvParse(csvText, { skip_empty_lines: true, relax_column_count: true });
    const mapping = settings.columnMapping;

    const master = records.slice(1)
      .map(row => ({
        id: uuidv4(),
        codeId: String(row[mapping.codeId] || '').trim(),
        name: String(row[mapping.name] || '').trim(),
        location: String(row[mapping.location] || '').trim(),
        mediaType: String(row[mapping.mediaType] || '').trim(),
        phase: String(row[mapping.phase] || '1P').trim(),
        region: String(row[mapping.region] || '').trim()
      }))
      .filter(r => r.codeId);

    writeJSON('master.json', master);
    const syncedAt = new Date().toISOString();
    writeJSON('settings.json', { ...settings, lastSheetSync: syncedAt, sheetsUrl: url });

    res.json({ success: true, count: master.length, syncedAt });
  } catch (err) {
    res.status(500).json({ error: `Sync ล้มเหลว: ${err.message}` });
  }
});

// Import master from CSV file
app.post('/api/master/import', uploadCSV.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ไม่มีไฟล์' });
    const csvText = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);
    const settings = readJSON('settings.json');
    const records = csvParse(csvText, { skip_empty_lines: true, relax_column_count: true });
    const mapping = settings.columnMapping;
    const master = records.slice(1)
      .map(row => ({
        id: uuidv4(),
        codeId: String(row[mapping.codeId] || '').trim(),
        name: String(row[mapping.name] || '').trim(),
        location: String(row[mapping.location] || '').trim(),
        mediaType: String(row[mapping.mediaType] || '').trim(),
        phase: String(row[mapping.phase] || '1P').trim(),
        region: String(row[mapping.region] || '').trim()
      }))
      .filter(r => r.codeId);
    writeJSON('master.json', master);
    res.json({ success: true, count: master.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspections
app.get('/api/inspections', (req, res) => {
  let data = readJSON('inspections.json');
  const { status, techId, codeId, from, to, risk } = req.query;
  if (status) data = data.filter(i => i.overallStatus === status);
  if (techId) data = data.filter(i => i.technicianId === techId);
  if (codeId) data = data.filter(i => i.codeId === codeId);
  if (risk) data = data.filter(i => (i.aiReport?.riskLevel || '') === risk);
  if (from) data = data.filter(i => new Date(i.createdAt) >= new Date(from));
  if (to) data = data.filter(i => new Date(i.createdAt) <= new Date(to + 'T23:59:59'));
  data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(data);
});

app.post('/api/inspections', (req, res) => {
  const inspections = readJSON('inspections.json');
  const rec = {
    id: `INS-${Date.now()}`,
    ...req.body,
    overallStatus: req.body.aiReport?.overallStatus || 'PENDING',
    engineerApproval: null,
    engineerNotes: '',
    lineSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  inspections.unshift(rec);
  writeJSON('inspections.json', inspections);
  res.status(201).json(rec);
});

app.get('/api/inspections/:id', (req, res) => {
  const rec = readJSON('inspections.json').find(i => i.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  res.json(rec);
});

app.put('/api/inspections/:id/approve', (req, res) => {
  const data = readJSON('inspections.json');
  const idx = data.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  const settings = readJSON('settings.json');
  data[idx] = {
    ...data[idx],
    engineerApproval: req.body.decision,
    engineerNotes: req.body.notes || '',
    engineerName: settings.engineerName,
    engineerLicense: settings.engineerLicense,
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeJSON('inspections.json', data);
  res.json(data[idx]);
});

app.delete('/api/inspections/:id', (req, res) => {
  const data = readJSON('inspections.json');
  writeJSON('inspections.json', data.filter(i => i.id !== req.params.id));
  res.json({ success: true });
});

// AI Analysis — receives photos + inspection data
app.post('/api/analyze', upload.array('photos', 10), async (req, res) => {
  const uploadedFiles = req.files || [];
  try {
    const client = getAnthropic();
    const inspData = JSON.parse(req.body.inspectionData || '{}');
    inspData.photoCount = uploadedFiles.length;

    const content = [];

    // Add images as base64 (auto-resize if > 4MB)
    const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
    for (const photo of uploadedFiles) {
      let imgBuf = fs.readFileSync(photo.path);
      try {
        if (imgBuf.length > MAX_BYTES) {
          // Resize to max 1920px wide/tall, quality 85
          imgBuf = await sharp(imgBuf)
            .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        }
      } catch (sharpErr) {
        console.warn('sharp resize failed, using original:', sharpErr.message);
      }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imgBuf.length < fs.statSync(photo.path).size ? 'image/jpeg' : photo.mimetype,
          data: imgBuf.toString('base64')
        }
      });
    }

    content.push({ type: 'text', text: buildPrompt(inspData) });

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content }]
    });

    const raw = message.content[0].text;
    console.log('[AI RAW]', raw.slice(0, 300)); // debug first 300 chars

    // Extract JSON — handle possible markdown code fences and extra text
    let report;
    try {
      // Strip markdown fences
      let stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      // Find the outermost JSON object (greedy from first { to last })
      const firstBrace = stripped.indexOf('{');
      const lastBrace = stripped.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        stripped = stripped.slice(firstBrace, lastBrace + 1);
      }
      report = JSON.parse(stripped);
    } catch (parseErr) {
      console.error('[AI PARSE ERROR]', parseErr.message);
      console.error('[AI RAW FULL]', raw);
      report = { rawResponse: raw, overallStatus: 'FAIL', riskLevel: 'MEDIUM', findings: [`AI ตอบกลับแต่ parse JSON ไม่สำเร็จ: ${parseErr.message}`] };
    }

    res.json({ success: true, report, photoFiles: uploadedFiles.map(f => f.filename) });
  } catch (err) {
    // Keep uploaded files so they can be referenced after manual save
    res.status(500).json({ error: err.message });
  }
});

// LINE Messaging API — push message
app.post('/api/line/send', async (req, res) => {
  try {
    const settings = readJSON('settings.json');
    const token = req.body.token || settings.lineChannelToken || process.env.LINE_CHANNEL_TOKEN;
    const targetId = req.body.targetId || settings.lineTargetId || process.env.LINE_TARGET_ID;
    if (!token) return res.status(400).json({ error: 'ไม่ได้ตั้งค่า LINE Channel Access Token' });
    if (!targetId) return res.status(400).json({ error: 'ไม่ได้ตั้งค่า LINE Target ID (User ID หรือ Group ID)' });

    let message = req.body.message;
    if (!message && req.body.inspectionId) {
      const rec = readJSON('inspections.json').find(i => i.id === req.body.inspectionId);
      if (rec && rec.aiReport) message = buildLineMessage(rec, rec.aiReport);
    }
    if (!message) return res.status(400).json({ error: 'ไม่มีข้อความ' });

    // Split into ≤2 messages: alert + micro-lesson (Messaging API limit: 5000 chars/message, 5 msg/push)
    const messages = [];
    const LESSON_MARKER = '\n\n📚 Micro-Lesson:';
    const splitAt = message.indexOf(LESSON_MARKER);
    if (splitAt !== -1 && message.length > 1000) {
      messages.push({ type: 'text', text: message.slice(0, splitAt).trim() });
      messages.push({ type: 'text', text: message.slice(splitAt).trim() });
    } else {
      messages.push({ type: 'text', text: message });
    }

    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: targetId, messages },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        timeout: 10000
      }
    );

    // Mark as sent
    if (req.body.inspectionId) {
      const data = readJSON('inspections.json');
      const idx = data.findIndex(i => i.id === req.body.inspectionId);
      if (idx !== -1) { data[idx].lineSent = true; writeJSON('inspections.json', data); }
    }

    res.json({ success: true });
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    res.status(500).json({ error: `LINE ส่งไม่สำเร็จ: ${detail}` });
  }
});

// LINE Webhook — รับ event เพื่อดึง Group ID / User ID อัตโนมัติ
let lastLineEvents = [];
app.post('/webhook/line', (req, res) => {
  res.sendStatus(200); // ต้องตอบ 200 ก่อนเสมอ
  const events = req.body?.events || [];
  events.forEach(ev => {
    const src = ev.source || {};
    const entry = {
      type: src.type,             // 'user', 'group', 'room'
      id: src.groupId || src.roomId || src.userId,
      userId: src.userId,
      eventType: ev.type,         // 'message', 'join', etc.
      text: ev.message?.text || '',
      timestamp: new Date().toISOString()
    };
    lastLineEvents.unshift(entry);
    lastLineEvents = lastLineEvents.slice(0, 20); // keep last 20
    console.log(`[LINE Webhook] ${entry.type} ID: ${entry.id} | User: ${entry.userId} | "${entry.text}"`);
  });
});

// Return captured IDs so Settings UI can show them
app.get('/api/line/discovered-ids', (req, res) => res.json(lastLineEvents));

// Dashboard stats
app.get('/api/dashboard', (req, res) => {
  const data = readJSON('inspections.json');
  const settings = readJSON('settings.json');
  const now = new Date();

  const byStatus = { PASS: 0, FAIL: 0, PENDING: 0 };
  const byRisk = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const monthly = {};
  let thisMonth = 0;

  data.forEach(i => {
    const s = i.overallStatus || 'PENDING';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const r = i.aiReport?.riskLevel || 'MEDIUM';
    byRisk[r] = (byRisk[r] || 0) + 1;
    const d = new Date(i.createdAt);
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) thisMonth++;
    const key = i.createdAt.slice(0, 7);
    monthly[key] = (monthly[key] || 0) + 1;
  });

  const passRate = data.length > 0 ? Math.round((byStatus.PASS / data.length) * 100) : 0;

  res.json({
    total: data.length,
    passRate,
    critical: byRisk.CRITICAL,
    thisMonth,
    byStatus,
    byRisk,
    monthly: Object.entries(monthly).sort().slice(-6).map(([month, count]) => ({ month, count })),
    lastSheetSync: settings.lastSheetSync,
    recent: data.slice(0, 8)
  });
});

// Export inspections as Excel (.xlsx)
app.get('/api/export/excel', async (req, res) => {
  const ExcelJS = require('exceljs');
  const data = readJSON('inspections.json');
  const settings = readJSON('settings.json');

  const wb = new ExcelJS.Workbook();
  wb.creator = settings.engineerName || 'Audit-EE';
  wb.created = new Date();

  // ── Sheet 1: รายงานการตรวจสอบ ──────────────────────────────────────────────
  const ws = wb.addWorksheet('รายงานการตรวจสอบ');

  // Header row styling
  ws.columns = [
    { header: 'วันที่ตรวจ', key: 'date', width: 14 },
    { header: 'Code ID', key: 'codeId', width: 10 },
    { header: 'ชื่อสถานที่', key: 'name', width: 28 },
    { header: 'ที่ตั้ง', key: 'location', width: 30 },
    { header: 'ช่าง', key: 'tech', width: 12 },
    { header: 'รหัสช่าง', key: 'techId', width: 10 },
    { header: 'Ground(Ω)', key: 'ground', width: 12 },
    { header: 'Continuity(Ω)', key: 'continuity', width: 14 },
    { header: 'Leakage(mA)', key: 'leakage', width: 13 },
    { header: 'Voltage(V)', key: 'voltage', width: 12 },
    { header: 'Phase', key: 'phase', width: 8 },
    { header: 'PPE', key: 'ppe', width: 8 },
    { header: 'ผล', key: 'status', width: 10 },
    { header: 'Risk', key: 'risk', width: 10 },
    { header: 'วิศวกรอนุมัติ', key: 'eng', width: 14 },
    { header: 'หมายเหตุ', key: 'notes', width: 30 },
  ];

  // Style header
  const headerRow = ws.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF60A5FA' } } };
  });
  headerRow.height = 28;

  // Data rows
  const PASS_GREEN = 'FFD1FAE5'; const FAIL_RED = 'FFFEE2E2'; const MED_ORANGE = 'FFFEF3C7';
  data.forEach(i => {
    const ppeCount = Object.values(i.ppeChecklist || {}).filter(Boolean).length;
    const isFail = i.overallStatus === 'FAIL';
    const risk = i.aiReport?.riskLevel || '';
    const row = ws.addRow({
      date: i.createdAt ? i.createdAt.slice(0, 10) : '',
      codeId: i.codeId,
      name: i.locationInfo?.name || '',
      location: i.locationInfo?.location || '',
      tech: i.technicianName,
      techId: i.technicianId,
      ground: i.measurements?.groundResistance,
      continuity: i.measurements?.continuityGround,
      leakage: i.measurements?.leakageCurrent,
      voltage: i.measurements?.voltage,
      phase: i.measurements?.phase,
      ppe: `${ppeCount}/5`,
      status: i.overallStatus || '',
      risk,
      eng: i.engineerApproval || 'รอ',
      notes: i.engineerNotes || '',
    });

    // Ground Resistance — red if > 5Ω
    const gCell = row.getCell('ground');
    if ((i.measurements?.groundResistance ?? 0) > 5) {
      gCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCA5A5' } };
      gCell.font = { bold: true, color: { argb: 'FF991B1B' } };
    }

    // Status color
    const sCell = row.getCell('status');
    sCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isFail ? 'FFFCA5A5' : 'FF86EFAC' } };
    sCell.font = { bold: true };
    sCell.alignment = { horizontal: 'center' };

    // Risk color
    const rCell = row.getCell('risk');
    const rColor = risk === 'CRITICAL' ? 'FFEF4444' : risk === 'HIGH' ? 'FFFB923C' : risk === 'MEDIUM' ? 'FFFBBF24' : 'FF4ADE80';
    rCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColor } };
    rCell.font = { bold: true, color: { argb: risk === 'LOW' ? 'FF166534' : 'FFFFFFFF' } };
    rCell.alignment = { horizontal: 'center' };

    row.eachCell(cell => {
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
    });
    row.height = 20;
  });

  // Freeze header
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'P1' };

  // ── Sheet 2: สรุปรายช่าง ───────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('สรุปรายช่าง');
  const techMap = {};
  data.forEach(i => {
    const k = `${i.technicianName} (${i.technicianId})`;
    if (!techMap[k]) techMap[k] = { total: 0, pass: 0, fail: 0, high: 0 };
    techMap[k].total++;
    if (i.overallStatus === 'PASS') techMap[k].pass++;
    else techMap[k].fail++;
    if (['HIGH','CRITICAL'].includes(i.aiReport?.riskLevel)) techMap[k].high++;
  });
  ws2.columns = [
    { header: 'ช่าง', key: 'tech', width: 20 },
    { header: 'ทั้งหมด', key: 'total', width: 10 },
    { header: 'ผ่าน', key: 'pass', width: 10 },
    { header: 'ไม่ผ่าน', key: 'fail', width: 10 },
    { header: '% ผ่าน', key: 'pct', width: 10 },
    { header: 'HIGH Risk', key: 'high', width: 12 },
  ];
  ws2.getRow(1).eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center' };
  });
  Object.entries(techMap).forEach(([tech, s]) => {
    const pct = s.total ? Math.round(s.pass / s.total * 100) : 0;
    const r = ws2.addRow({ tech, total: s.total, pass: s.pass, fail: s.fail, pct: pct + '%', high: s.high });
    r.getCell('pct').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pct >= 80 ? 'FF86EFAC' : pct >= 60 ? 'FFFBBF24' : 'FFFCA5A5' } };
    r.getCell('fail').font = s.fail > 0 ? { color: { argb: 'FFB91C1C' }, bold: true } : {};
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="AuditEE-${new Date().toISOString().slice(0,10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Export inspections as CSV
app.get('/api/export/csv', (req, res) => {
  const data = readJSON('inspections.json');
  const header = ['ID', 'Date', 'Code ID', 'Location', 'Technician', 'Tech ID', 'Ground(Ω)', 'Continuity(Ω)', 'Leakage(mA)', 'Voltage(V)', 'Phase', 'PPE', 'Status', 'Risk', 'Engineer Approval'];
  const rows = data.map(i => [
    i.id, i.createdAt?.slice(0, 10), i.codeId,
    (i.locationInfo?.name || ''), i.technicianName, i.technicianId,
    i.measurements?.groundResistance, i.measurements?.continuityGround,
    i.measurements?.leakageCurrent, i.measurements?.voltage, i.measurements?.phase,
    Object.values(i.ppeChecklist || {}).filter(Boolean).length + '/5',
    i.overallStatus, i.aiReport?.riskLevel || '', i.engineerApproval || ''
  ]);
  const csv = [header, ...rows].map(r => r.map(c => `"${c ?? ''}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-ee-${Date.now()}.csv"`);
  res.send('﻿' + csv); // BOM for Excel
});

// ─── network info ──────────────────────────────────────────────────────────────
const os = require('os');
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

app.get('/api/network-info', (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT });
});

// ─── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  🔌 Audit-EE  |  Plan B Media               ║`);
  console.log(`║  💻 PC:     http://localhost:${PORT}              ║`);
  console.log(`║  📱 มือถือ: http://${localIP}:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  ANTHROPIC_API_KEY ไม่ได้ตั้งค่า — ไปที่ Settings ในแอป');
  }
});
