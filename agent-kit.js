/**
 * Santi Agent Protocol v1 — เวอร์ชัน JavaScript (CommonJS) สำหรับแอป Express
 * พฤติกรรมเหมือน agent-kit.ts ทุกอย่าง (ดูคำอธิบายเต็มในไฟล์นั้น)
 *
 *   const { mountAgent, argStr, AgentError } = require('./agent-kit');
 *   mountAgent(app, { name, title, description }, [tool1, tool2]);   // → GET/POST /api/agent
 *
 * tool = { name, description, input_schema, mutating?, preview?(args), run(args) → string | {text, data} }
 * ต้องตั้ง AGENT_KEY (≥24 ตัว) ใน env · ทุกคำขอต้องมี Authorization: Bearer <AGENT_KEY>
 * mutating: เรียกครั้งแรกได้ preview + confirm_token (ผูก tool+args, 10 นาที) เรียกซ้ำพร้อม token ถึงทำจริง
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const CONFIRM_TTL_MS = 10 * 60_000;

class AgentError extends Error {}

function argStr(a, key, opts = {}) {
  const v = a[key];
  if (v == null || v === '') {
    if (opts.required) throw new AgentError(`ต้องระบุ ${key}`);
    return undefined;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new AgentError(`${key} ต้องเป็นข้อความ`);
  const s = String(v).trim();
  if (opts.max && s.length > opts.max) throw new AgentError(`${key} ยาวเกิน ${opts.max} ตัวอักษร`);
  if (opts.required && !s) throw new AgentError(`ต้องระบุ ${key}`);
  return s || undefined;
}

function argNum(a, key, opts = {}) {
  const v = a[key];
  if (v == null || v === '') {
    if (opts.required) throw new AgentError(`ต้องระบุ ${key}`);
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new AgentError(`${key} ต้องเป็นตัวเลข`);
  if (opts.int && !Number.isInteger(n)) throw new AgentError(`${key} ต้องเป็นจำนวนเต็ม`);
  if (opts.min != null && n < opts.min) throw new AgentError(`${key} ต้องไม่น้อยกว่า ${opts.min}`);
  if (opts.max != null && n > opts.max) throw new AgentError(`${key} ต้องไม่เกิน ${opts.max}`);
  return n;
}

const agentKey = () => {
  const k = process.env.AGENT_KEY;
  return k && k.length >= 24 ? k : null;
};
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function authorized(req) {
  const key = agentKey();
  if (!key) return false;
  const h = req.get('authorization') || '';
  return crypto.timingSafeEqual(sha(h.startsWith('Bearer ') ? h.slice(7) : ''), sha(key));
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const sign = p => crypto.createHmac('sha256', `confirm:${agentKey()}`).update(p).digest('base64url');
const argsHash = a => crypto.createHash('sha256').update(stable(a)).digest('base64url');

function makeToken(tool, args) {
  const body = Buffer.from(JSON.stringify({ t: tool, h: argsHash(args), e: Date.now() + CONFIRM_TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function checkToken(token, tool, args) {
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return 'confirm_token ไม่ถูกต้อง';
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return 'confirm_token ไม่ถูกต้อง';
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (p.t !== tool) return 'confirm_token นี้เป็นของคำสั่งอื่น';
  if (Date.now() > p.e) return 'confirm_token หมดอายุแล้ว (10 นาที) เรียกใหม่โดยไม่ใส่ token เพื่อขอยืนยันอีกครั้ง';
  if (p.h !== argsHash(args)) return 'อาร์กิวเมนต์ไม่ตรงกับที่ผู้ใช้ยืนยันไว้ ต้องขอยืนยันใหม่';
  return null;
}

function mountAgent(app, meta, tools, path = '/api/agent') {
  const byName = new Map(tools.map(t => [t.name, t]));
  const guard = (req, res) => {
    res.set('cache-control', 'no-store');
    if (!agentKey()) { res.status(503).json({ ok: false, error: 'แอปนี้ยังไม่ได้ตั้ง AGENT_KEY' }); return false; }
    if (!authorized(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return false; }
    return true;
  };

  app.get(path, (req, res) => {
    if (!guard(req, res)) return;
    res.json({
      protocol: PROTOCOL_VERSION,
      ...meta,
      tools: tools.map(({ name, description, input_schema, mutating }) => ({ name, description, input_schema, mutating: !!mutating })),
    });
  });

  app.post(path, async (req, res) => {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const tool = byName.get(body.tool || '');
    if (!tool) return res.status(404).json({ ok: false, error: `ไม่รู้จักเครื่องมือ ${body.tool}` });
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    try {
      if (tool.mutating) {
        if (!body.confirm_token) {
          const preview = tool.preview ? await tool.preview(args) : `จะเรียก ${tool.name}`;
          return res.json({ ok: true, needs_confirmation: true, preview, confirm_token: makeToken(tool.name, args), text: `ยังไม่ได้ทำ ต้องให้ผู้ใช้ยืนยันก่อน:\n${preview}` });
        }
        const bad = checkToken(body.confirm_token, tool.name, args);
        if (bad) return res.status(400).json({ ok: false, error: bad });
      }
      const out = await tool.run(args);
      res.json(typeof out === 'string' ? { ok: true, text: out } : { ok: true, ...out });
    } catch (e) {
      if (e instanceof AgentError) return res.status(400).json({ ok: false, error: e.message });
      console.error(`[agent] ${tool.name} ล้ม`, e);
      res.status(500).json({ ok: false, error: `ทำงานไม่สำเร็จ: ${e.message}` });
    }
  });
}

module.exports = { PROTOCOL_VERSION, AgentError, argStr, argNum, mountAgent };
