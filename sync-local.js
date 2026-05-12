/**
 * sync-local.js — ดึงรูปจาก Cloudinary → เครื่องตัวเอง
 * วิธีใช้:  node sync-local.js
 *           (หรือดับเบิ้ลคลิก sync-local.bat)
 */
require('dotenv').config({ override: true });

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const mongoose = require('mongoose');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost/audit-ee';

// ─── Schema (เฉพาะที่ต้องใช้) ──────────────────────────────────────────────
const Inspection = mongoose.model('Inspection', new mongoose.Schema({
  id:         String,
  photoFiles: mongoose.Schema.Types.Mixed,
  createdAt:  Date
}, { strict: false, timestamps: true }));

// ─── Helper: download URL → file ────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) { resolve('skip'); return; }
    const file   = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve('ok')));
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ─── Helper: date folder (YYYY-MM-DD) ───────────────────────────────────────
function dateFolder(inspection) {
  const d = inspection.createdAt || new Date();
  return new Date(d).toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔄  Audit-EE Sync — ดึงรูปจาก Cloud → เครื่องตัวเอง\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅  MongoDB connected');

  const inspections = await Inspection.find({}).lean();
  console.log(`📋  พบ ${inspections.length} inspection(s)\n`);

  let totalNew = 0, totalSkip = 0, totalErr = 0;

  for (const ins of inspections) {
    const photos = ins.photoFiles || [];
    if (!photos.length) continue;

    const folder = path.join(UPLOADS_DIR, dateFolder(ins));
    fs.mkdirSync(folder, { recursive: true });

    for (const photo of photos) {
      const url  = typeof photo === 'string' ? photo : photo.url;
      const name = typeof photo === 'string'
        ? path.basename(url.split('?')[0])
        : (photo.name || path.basename(url.split('?')[0]));

      if (!url || !url.startsWith('http')) continue;

      const dest = path.join(folder, name);
      try {
        const result = await downloadFile(url, dest);
        if (result === 'skip') {
          process.stdout.write('·');
          totalSkip++;
        } else {
          process.stdout.write('↓');
          totalNew++;
        }
      } catch (e) {
        process.stdout.write('✗');
        totalErr++;
      }
    }
  }

  await mongoose.disconnect();

  console.log(`\n\n✅  Sync เสร็จแล้ว!`);
  console.log(`   ↓  ดาวน์โหลดใหม่ : ${totalNew} ไฟล์`);
  console.log(`   ·  มีแล้ว (skip)  : ${totalSkip} ไฟล์`);
  if (totalErr) console.log(`   ✗  เกิดข้อผิดพลาด : ${totalErr} ไฟล์`);
  console.log(`\n📁  รูปทั้งหมดอยู่ใน: ${UPLOADS_DIR}\n`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
