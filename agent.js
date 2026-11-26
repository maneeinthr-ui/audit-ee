/**
 * ช่องรับคำสั่งของ Orchestrator (ผู้ช่วยกลาง) — อ่านอย่างเดียว
 * การอนุมัติผลตรวจเป็นการรับรองของวิศวกร (ใช้ PIN) จึงไม่เปิดให้ผู้ช่วยทำแทน
 */
const { mountAgent, AgentError, argStr, argNum } = require('./agent-kit');

const BASE = (process.env.APP_URL || 'https://audit-ee-production-8470.up.railway.app').replace(/\/$/, '');
const th = d => (d ? new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '-');
const APPROVAL_TH = { APPROVED: 'อนุมัติแล้ว', REJECTED: 'ปฏิเสธ', AWAITING: 'รอวิศวกร' };
const approvalOf = i => i.engineerApproval || 'AWAITING';
const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function line(i) {
  const r = i.aiReport || {};
  return `${i.id} · ป้าย ${i.codeId || '-'} ${i.locationInfo?.name || ''} · ช่าง ${i.technicianName || '-'} · ${i.overallStatus || 'PENDING'} · เสี่ยง ${r.riskLevel || '-'} · ${APPROVAL_TH[approvalOf(i)]} · ${th(i.createdAt)}`;
}

module.exports = function mountInspectionAgent(app, { Inspection, Master }) {
  const overview = {
    name: 'inspections_overview',
    description: 'ภาพรวมการตรวจระบบไฟฟ้าป้าย: จำนวนรายการ อัตราผ่าน แยกตามผล/ความเสี่ยง/สถานะวิศวกร เดือนนี้ และรายการที่รอวิศวกรอนุมัติ (เน้นความเสี่ยงสูง)',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const all = await Inspection.find({}, { photoFiles: 0 }).sort({ createdAt: -1 }).lean();
      const now = new Date();
      const by = (f) => all.reduce((m, i) => { const k = f(i); m[k] = (m[k] || 0) + 1; return m; }, {});
      const status = by(i => i.overallStatus || 'PENDING');
      const risk = by(i => i.aiReport?.riskLevel || '-');
      const appr = by(approvalOf);
      const month = all.filter(i => { const d = new Date(i.createdAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length;
      const waiting = all.filter(i => approvalOf(i) === 'AWAITING')
        .sort((a, b) => RISKS.indexOf(b.aiReport?.riskLevel) - RISKS.indexOf(a.aiReport?.riskLevel));
      const lines = [
        `รายการตรวจทั้งหมด ${all.length} · เดือนนี้ ${month} · อัตราผ่าน ${all.length ? Math.round(((status.PASS || 0) / all.length) * 100) : 0}%`,
        `ผล: ผ่าน ${status.PASS || 0} · ไม่ผ่าน ${status.FAIL || 0} · รอผล ${status.PENDING || 0}`,
        `ความเสี่ยง: ${RISKS.map(r => `${r} ${risk[r] || 0}`).join(' · ')}`,
        `วิศวกร: อนุมัติ ${appr.APPROVED || 0} · ปฏิเสธ ${appr.REJECTED || 0} · รอ ${appr.AWAITING || 0}`,
        '',
        `รอวิศวกรอนุมัติ ${waiting.length} รายการ${waiting.length > 15 ? ' (แสดง 15 รายการเสี่ยงสูงสุด)' : ''}`,
        ...waiting.slice(0, 15).map(i => `- ${line(i)}`),
        '',
        `เปิดระบบ: ${BASE}`,
      ];
      return lines.join('\n');
    },
  };

  const list = {
    name: 'list_inspections',
    description: 'รายการผลตรวจ กรองตามสถานะวิศวกร ความเสี่ยง ผลผ่าน/ไม่ผ่าน รหัสป้าย ชื่อช่าง หรือช่วงวัน เรียงจากใหม่สุด',
    input_schema: {
      type: 'object',
      properties: {
        approval: { type: 'string', enum: ['AWAITING', 'APPROVED', 'REJECTED'], description: 'สถานะวิศวกร' },
        risk: { type: 'string', description: 'ความเสี่ยง LOW/MEDIUM/HIGH/CRITICAL (หลายค่าคั่น , ได้)' },
        status: { type: 'string', enum: ['PASS', 'FAIL', 'PENDING'], description: 'ผลการตรวจ' },
        code_id: { type: 'string', description: 'รหัสป้าย' },
        technician: { type: 'string', description: 'ชื่อหรือรหัสช่าง (ค้นบางส่วน)' },
        days: { type: 'number', description: 'ย้อนหลังกี่วัน' },
        limit: { type: 'number', description: 'จำนวนสูงสุด ค่าเริ่มต้น 20 สูงสุด 50' },
      },
    },
    async run(a) {
      const f = {};
      const approval = argStr(a, 'approval');
      if (approval === 'AWAITING') f.$or = [{ engineerApproval: null }, { engineerApproval: { $exists: false } }];
      else if (approval) f.engineerApproval = approval;
      const risk = argStr(a, 'risk', { max: 60 });
      if (risk) {
        const arr = risk.toUpperCase().split(',').map(s => s.trim()).filter(s => RISKS.includes(s));
        if (!arr.length) throw new AgentError('risk ต้องเป็น LOW, MEDIUM, HIGH หรือ CRITICAL');
        f['aiReport.riskLevel'] = { $in: arr };
      }
      const status = argStr(a, 'status');
      if (status) f.overallStatus = status;
      const code = argStr(a, 'code_id', { max: 60 });
      if (code) f.codeId = code;
      const tech = argStr(a, 'technician', { max: 60 });
      if (tech) f.$and = [{ $or: [{ technicianName: new RegExp(esc(tech), 'i') }, { technicianId: new RegExp(esc(tech), 'i') }] }];
      const days = argNum(a, 'days', { min: 1, max: 3650 });
      if (days) f.createdAt = { $gte: new Date(Date.now() - days * 86_400_000) };
      const limit = argNum(a, 'limit', { min: 1, max: 50, int: true }) || 20;
      const [rows, count] = await Promise.all([
        Inspection.find(f, { photoFiles: 0 }).sort({ createdAt: -1 }).limit(limit).lean(),
        Inspection.countDocuments(f),
      ]);
      if (!rows.length) return 'ไม่พบรายการที่ตรงเงื่อนไข';
      return [`พบ ${count} รายการ${count > rows.length ? ` (แสดง ${rows.length})` : ''}`, ...rows.map(i => `- ${line(i)}`)].join('\n');
    },
  };

  const detail = {
    name: 'inspection_detail',
    description: 'รายละเอียดผลตรวจหนึ่งรายการ: ค่าที่วัด (แรงดัน G-N, Continuity, Leakage, Voltage) PPE/MDB ผลวิเคราะห์ AI จุดบกพร่อง การตรวจ GPS/เวลาหน้างาน/ค่าผิดปกติ และการตัดสินของวิศวกร',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'รหัสรายการ เช่น INS-1763... (ดูจาก list_inspections)' } }, required: ['id'] },
    async run(a) {
      const id = argStr(a, 'id', { required: true, max: 40 });
      const i = await Inspection.findOne({ id }, { photoFiles: 0 }).lean();
      if (!i) throw new AgentError(`ไม่พบรายการ ${id}`);
      const m = i.measurements || {}, r = i.aiReport || {}, loc = i.locationInfo || {};
      const ppe = i.ppeChecklist || {}, mdb = i.mdbChecklist || {};
      const yes = v => (v ? '✓' : '✗');
      const lines = [
        `${i.id} · ${th(i.createdAt)}`,
        `ป้าย ${i.codeId || '-'} ${loc.name || ''} · ${loc.location || ''} · ${loc.mediaType || ''} · ระบบ ${m.phase || '1P'}`,
        `ช่าง ${i.technicianName || '-'} (${i.technicianId || '-'}) · เวลาหน้างาน ${i.timeOnSite != null ? Math.round(i.timeOnSite) + ' นาที' : '-'}`,
        '',
        `ค่าที่วัด: G-N ${m.groundResistance ?? '-'} V · Continuity ${m.continuityGround ?? '-'} Ω · Leakage ${m.leakageCurrent ?? '-'} mA · Voltage ${m.voltage ?? '-'} V`,
        `PPE: หมวก${yes(ppe.helmet)} ถุงมือ${yes(ppe.gloves)} รองเท้า${yes(ppe.safetyShoes)} เสื้อ${yes(ppe.vest)} แว่น${yes(ppe.glasses)} · MDB: เบรกเกอร์${yes(mdb.breaker)} ทามเมอร์${yes(mdb.timer)} แมกเนติก${yes(mdb.magnetic)} สาย${yes(mdb.wiring)}`,
        '',
        `ผล AI: ${i.overallStatus || 'PENDING'} · ความเสี่ยง ${r.riskLevel || '-'}${r.riskReason ? ` (${r.riskReason})` : ''}`,
      ];
      if (r.standardDetail) lines.push(`มาตรฐาน: ${r.standardCheck || ''} ${r.standardDetail}`);
      if (r.ocrMatchCheck) lines.push(`ค่าบนรูปมิเตอร์เทียบที่กรอก: ${r.ocrMatchCheck}${r.ocrMatchDetail ? ` — ${r.ocrMatchDetail}` : ''}`);
      if (r.photoQuality) lines.push(`รูปถ่าย: ${r.photoQuality}${r.photoQualityDetail ? ` — ${r.photoQualityDetail}` : ''}`);
      if (r.findings?.length) lines.push('จุดบกพร่อง:', ...r.findings.map(x => `- ${x}`));
      if (r.gpsValidation?.detail) lines.push(`GPS: ${r.gpsValidation.detail}`);
      if (r.timeOnSite?.detail) lines.push(`เวลา: ${r.timeOnSite.detail}`);
      if (r.measurementAnomaly?.detail) lines.push(`ค่าผิดปกติ: ${r.measurementAnomaly.detail}`);
      lines.push('', `วิศวกร: ${APPROVAL_TH[approvalOf(i)]}${i.engineerName ? ` โดย ${i.engineerName}` : ''}${i.approvedAt ? ` · ${th(i.approvedAt)}` : ''}${i.engineerNotes ? ` · หมายเหตุ: ${i.engineerNotes}` : ''}`);
      lines.push(`ส่ง LINE แล้ว: ${i.lineSent ? 'ใช่' : 'ยัง'} · เปิดระบบ: ${BASE}`);
      return lines.join('\n');
    },
  };

  const findBillboard = {
    name: 'find_billboard',
    description: 'ค้นหาป้ายในข้อมูลหลัก (Master) จากรหัส ชื่อ ถนน หรือภาค พร้อมจำนวนครั้งที่ตรวจและผลล่าสุด',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'คำค้น' } }, required: ['query'] },
    async run(a) {
      const q = new RegExp(esc(argStr(a, 'query', { required: true, max: 80 })), 'i');
      const boards = await Master.find({ $or: [{ codeId: q }, { name: q }, { road: q }, { region: q }, { location: q }, { mediaType: q }] }).limit(20).lean();
      if (!boards.length) return 'ไม่พบป้ายที่ตรงคำค้น';
      const out = [];
      for (const b of boards) {
        const [n, last] = await Promise.all([
          Inspection.countDocuments({ codeId: b.codeId }),
          Inspection.findOne({ codeId: b.codeId }, { photoFiles: 0 }).sort({ createdAt: -1 }).lean(),
        ]);
        out.push(`- ${b.codeId} · ${b.name || '-'} · ${b.road || ''} ${b.region || ''} · ${b.mediaType || ''} · ${b.phase || '1P'} · ตรวจ ${n} ครั้ง${last ? ` · ล่าสุด ${th(last.createdAt)} ${last.overallStatus} ${APPROVAL_TH[approvalOf(last)]}` : ''}`);
      }
      return out.join('\n');
    },
  };

  mountAgent(
    app,
    {
      name: 'audit',
      title: 'ตรวจสอบระบบไฟฟ้าป้าย (Audit-EE)',
      description: 'ผลตรวจระบบไฟฟ้าป้ายโฆษณาของช่าง ค่าวัดเทียบเกณฑ์ วสท. ความเสี่ยง และรายการรอวิศวกรอนุมัติ (อ่านอย่างเดียว)',
    },
    [overview, list, detail, findBillboard],
  );
};
