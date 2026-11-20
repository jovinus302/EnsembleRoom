#!/usr/bin/env node
// S14: 3D용 외부 에셋 가져오기 (소품 GLB, HDRI, 모래 텍스처, 폰트)
//
//   npm run assets:props                  assets-src/ 의 원본을 골라 apps/web/public/assets/ 로 복사·생성한다 (재실행 가능)
//   npm run assets:props -- --download    없는 원본을 공식 배포처에서 assets-src/<출처>/ 로 받은 뒤 가져온다
//   npm run assets:props -- --force       이미 있는 폰트 서브셋도 다시 만든다
//
// 보안: 받은 파일은 신뢰할 수 없는 데이터다. 실행하지 않고, zip은 경로 이탈(zip slip)을 막으며
//       GLB/HDR/JPG/TTF/라이선스 텍스트만 꺼낸다. TLS 검증은 끄지 않는다. 요청에는 일반 User-Agent만 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets-src');
const OUT = path.join(ROOT, 'apps/web/public/assets');
const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/props-manifest.json'), 'utf8'));
const ARGS = new Set(process.argv.slice(2));
const DOWNLOAD = ARGS.has('--download');
const FORCE = ARGS.has('--force');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const ALLOWED_HOSTS = new Set([
  'kenney.nl', 'www.kenney.nl',
  'dl.polyhaven.org', 'api.polyhaven.com', 'polyhaven.com',
  'github.com', 'raw.githubusercontent.com',
]);

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('[warn]', ...a);
const problems = []; // 가져오지 못한 출처

// ───────────────────────── 파일 유틸 ─────────────────────────
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function writeIfChanged(dest, buf) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), buf) === 0) return false;
  fs.writeFileSync(dest, buf);
  return true;
}

function startsWith(buf, bytes) {
  return bytes.every((b, i) => buf[i] === b);
}
const MAGIC = {
  glb: (b) => b.toString('latin1', 0, 4) === 'glTF',
  hdr: (b) => /^#\?(RADIANCE|RGBE)/.test(b.toString('latin1', 0, 10)),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  ttf: (b) => startsWith(b, [0, 1, 0, 0]) || b.toString('latin1', 0, 4) === 'OTTO',
};

// ───────────────────────── 안전한 다운로드 ─────────────────────────
function checkUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new Error(`https가 아닌 URL 거부: ${u}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`허용되지 않은 호스트 거부: ${url.hostname}`);
  return url;
}

// 리다이렉트를 수동으로 따라가며 매 홉마다 호스트 허용 목록을 검사한다.
async function httpGet(u, { headers = {}, timeoutMs = 120000, maxBytes = 64 * 1024 * 1024 } = {}) {
  let url = checkUrl(u);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = checkUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.href}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`응답이 너무 큼(${buf.length}B): ${url.href}`);
    return { buf, headers: res.headers };
  }
  throw new Error(`리다이렉트가 너무 많음: ${u}`);
}

function describeNetError(e) {
  const c = e?.cause?.code || e?.cause?.message || e?.code || '';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(c) + e.message)) return `인증서 오류(${c}). 검증을 끄지 않고 건너뜀`;
  if (e.name === 'TimeoutError' || /timeout|ETIMEDOUT/i.test(String(c) + e.message)) return '타임아웃(사내망/프록시 차단 가능)';
  return `${e.message}${c ? ` (${c})` : ''}`;
}

async function downloadKenney(destZip) {
  const page = 'https://kenney.nl/assets/furniture-kit';
  const first = await fetch(page, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!first.ok) throw new Error(`HTTP ${first.status} ${page}`);
  const html = await first.text();
  const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const id = /data-download-id='([0-9a-f]+)'/.exec(html)?.[1];
  if (!id) throw new Error('Kenney 페이지에서 다운로드 id를 찾지 못함(페이지 구조 변경)');
  const { buf: linkBuf } = await httpGet(`https://kenney.nl/download-link/${id}`, {
    headers: { cookie, referer: page }, timeoutMs: 30000, maxBytes: 1 << 20,
  });
  const link = JSON.parse(linkBuf.toString('utf8'));
  if (!link.url) throw new Error('Kenney 다운로드 링크 응답에 url 없음');
  const { buf } = await httpGet(link.url, { timeoutMs: 180000 });
  if (buf.toString('latin1', 0, 2) !== 'PK') throw new Error('Kenney 응답이 zip이 아님');
  ensureDir(path.dirname(destZip));
  fs.writeFileSync(destZip, buf);
}

async function downloadChecked(url, dest, expectMd5) {
  const { buf } = await httpGet(url);
  if (expectMd5 && md5(buf) !== expectMd5) throw new Error(`md5 불일치: ${url}`);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
}

// ───────────────────────── 최소 zip 리더 (의존성 없음) ─────────────────────────
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 끝 레코드를 찾지 못함');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 중앙 디렉터리 손상');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  const read = (e) => {
    if (e.usize > 32 * 1024 * 1024) throw new Error(`항목이 너무 큼: ${e.name}`);
    const nlen = buf.readUInt16LE(e.lho + 26);
    const elen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + elen;
    const raw = buf.subarray(start, start + e.csize);
    const out = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: e.usize + 1 }) : null;
    if (!out) throw new Error(`지원하지 않는 압축 방식(${e.method}): ${e.name}`);
    if (out.length !== e.usize) throw new Error(`크기 불일치: ${e.name}`);
    return out;
  };
  return { entries, read };
}

// 허용 확장자만 꺼내고, 목적지가 destDir 밖이면 거부한다 (zip slip 방지).
function extractAllowed(zipPath, destDir, { prefix, exts, extra = [] }) {
  const { entries, read } = readZipEntries(zipPath);
  const base = path.resolve(destDir) + path.sep;
  let n = 0;
  for (const e of entries) {
    const name = e.name;
    if (name.endsWith('/')) continue;
    if (name.includes('\\') || name.split('/').includes('..') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
      warn(`경로 이탈 의심 항목 건너뜀: ${name}`);
      continue;
    }
    const wanted = (name.startsWith(prefix) && exts.includes(path.extname(name).toLowerCase())) || extra.includes(name);
    if (!wanted) continue;
    const dest = path.resolve(destDir, path.basename(name));
    if (!dest.startsWith(base)) { warn(`경로 이탈 거부: ${name}`); continue; }
    if (writeIfChanged(dest, read(e))) n++;
  }
  return n;
}

// ───────────────────────── GLB 바운딩 박스 ─────────────────────────
function parseGlb(buf) {
  if (!MAGIC.glb(buf)) throw new Error('GLB magic 불일치');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.toString('latin1', 16, 20) !== 'JSON') throw new Error('첫 청크가 JSON이 아님');
  return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
}

const matMul = (a, b) => { // column-major 4x4
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function glbBounds(buf) {
  const g = parseGlb(buf);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (idx, parent) => {
    const node = g.nodes[idx];
    const m = matMul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of g.meshes[node.mesh].primitives) {
        const acc = g.accessors[prim.attributes.POSITION];
        if (!acc?.min || !acc?.max) continue;
        for (let i = 0; i < 8; i++) {
          const v = [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]];
          for (let a = 0; a < 3; a++) {
            const t = m[a] * v[0] + m[4 + a] * v[1] + m[8 + a] * v[2] + m[12 + a];
            min[a] = Math.min(min[a], t);
            max[a] = Math.max(max[a], t);
          }
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = g.scenes?.[g.scene ?? 0];
  for (const r of scene?.nodes ?? g.nodes.map((_, i) => i)) visit(r, I);
  if (!isFinite(min[0])) throw new Error('POSITION min/max 없음');
  const r = (v) => Math.round(v * 1000) / 1000;
  return {
    min: min.map(r), max: max.map(r),
    size: max.map((v, i) => r(v - min[i])),
    external: (g.images ?? []).some((im) => im.uri && !im.uri.startsWith('data:')) || (g.buffers ?? []).some((b) => b.uri && !b.uri.startsWith('data:')),
  };
}

// ───────────────────────── 단계 ─────────────────────────
const dirOf = (name) => path.join(SRC, name);
const results = { props: {}, hdri: false, textures: {}, fonts: false };
const written = [];

function copyAsset(srcPath, outRel, kind) {
  const buf = fs.readFileSync(srcPath);
  if (!MAGIC[kind](buf)) throw new Error(`${kind} 형식 확인 실패(magic): ${rel(srcPath)}`);
  const dest = path.join(OUT, outRel);
  if (writeIfChanged(dest, buf)) written.push(outRel);
}

async function stepKenney() {
  const k = PLAN.kenney;
  const dir = dirOf(k.dir);
  const zip = path.join(dir, k.zip);
  const glbDir = path.join(dir, 'glb');
  if (DOWNLOAD && !fs.existsSync(zip) && !fs.existsSync(glbDir)) {
    try { log('Kenney Furniture Kit 다운로드...'); await downloadKenney(zip); }
    catch (e) { problems.push({ source: 'kenney', reason: describeNetError(e) }); }
  }
  if (fs.existsSync(zip)) {
    const n = extractAllowed(zip, glbDir, {
      prefix: k.zipGlbPrefix, exts: ['.glb'], extra: ['License.txt'],
    });
    if (n) log(`  zip에서 ${n}개 파일 추출 -> ${rel(glbDir)}`);
  }
  if (!fs.existsSync(glbDir)) {
    if (!problems.some((p) => p.source === 'kenney')) problems.push({ source: 'kenney', reason: `원본 없음: ${rel(zip)}` });
    return;
  }
  for (const p of PLAN.props) {
    const src = path.join(glbDir, p.src);
    if (!fs.existsSync(src)) { warn(`소품 원본 없음: ${p.src}`); continue; }
    const buf = fs.readFileSync(src);
    if (buf.length > 1024 * 1024) { warn(`1MB 초과로 건너뜀: ${p.src}`); continue; }
    copyAsset(src, `props/${p.out}`, 'glb');
  }
}

async function stepHdri() {
  const h = PLAN.hdri;
  const src = path.join(dirOf(h.srcDir), h.srcFile);
  if (DOWNLOAD && !fs.existsSync(src)) {
    try { log('HDRI 다운로드...'); await downloadChecked(h.url, src, h.md5); }
    catch (e) { problems.push({ source: 'polyhaven-hdri', reason: describeNetError(e) }); }
  }
  if (fs.existsSync(src)) copyAsset(src, h.out, 'hdr');
  else if (!problems.some((p) => p.source === 'polyhaven-hdri')) problems.push({ source: 'polyhaven-hdri', reason: `원본 없음: ${rel(src)}` });
}

async function stepTextures() {
  const t = PLAN.textures;
  for (const f of t.files) {
    const src = path.join(dirOf(t.srcDir), f.srcFile);
    if (DOWNLOAD && !fs.existsSync(src)) {
      try { log(`텍스처 다운로드 ${f.srcFile}...`); await downloadChecked(f.url, src, f.md5); }
      catch (e) { if (!problems.some((p) => p.source === 'polyhaven-textures')) problems.push({ source: 'polyhaven-textures', reason: describeNetError(e) }); }
    }
    if (fs.existsSync(src)) copyAsset(src, f.out, 'jpg');
  }
  if (!t.files.every((f) => fs.existsSync(path.join(dirOf(t.srcDir), f.srcFile))) && !problems.some((p) => p.source === 'polyhaven-textures')) {
    problems.push({ source: 'polyhaven-textures', reason: `원본 없음: ${rel(dirOf(t.srcDir))}` });
  }
}

// KS X 1001 한글 2350자 + ASCII/Latin-1/기호 (간판용). euc-kr 디코딩으로 생성한다.
function signText() {
  const chars = new Set();
  for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCodePoint(c));
  for (let c = 0xa0; c <= 0xff; c++) chars.add(String.fromCodePoint(c));
  for (let c = 0x2010; c <= 0x2027; c++) chars.add(String.fromCodePoint(c));
  for (let c = 0x3131; c <= 0x3163; c++) chars.add(String.fromCodePoint(c)); // 호환 자모
  const dec = new TextDecoder('euc-kr');
  for (let lead = 0xb0; lead <= 0xc8; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const s = dec.decode(Uint8Array.of(lead, trail));
      if (s.length === 1 && s >= '가' && s <= '힣') chars.add(s);
    }
  }
  return [...chars].sort().join('');
}

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['-I', '-c', 'import fontTools'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

async function stepFonts() {
  const f = PLAN.fonts;
  const dir = dirOf(f.srcDir);
  const src = path.join(dir, f.srcFile);
  const lic = path.join(dir, f.licenseFile);
  if (DOWNLOAD) {
    try {
      if (!fs.existsSync(src)) { log('폰트 다운로드(약 10MB)...'); await downloadChecked(f.url, src); }
      if (!fs.existsSync(lic)) await downloadChecked(f.licenseUrl, lic);
    } catch (e) { problems.push({ source: 'noto-sans-kr', reason: describeNetError(e) }); }
  }
  if (fs.existsSync(lic)) {
    const dest = path.join(OUT, f.licenseOut);
    if (writeIfChanged(dest, fs.readFileSync(lic))) written.push(f.licenseOut);
  }
  const dest = path.join(OUT, f.out);
  if (fs.existsSync(dest) && !FORCE) return; // 서브셋 결과는 커밋 대상이므로 재생성하지 않는다
  if (!fs.existsSync(src)) {
    if (!problems.some((p) => p.source === 'noto-sans-kr')) problems.push({ source: 'noto-sans-kr', reason: `원본 없음: ${rel(src)}` });
    return;
  }
  if (!MAGIC.ttf(fs.readFileSync(src))) throw new Error('폰트 magic 확인 실패');
  const py = findPython();
  if (!py) {
    problems.push({ source: 'noto-sans-kr', reason: '서브셋에 Python fontTools 필요(`pip install fonttools`). 원본은 받아 둠' });
    return;
  }
  // 작업 파일은 원본 디렉터리가 아닌 임시 위치에 만든다.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'ensemble-font-'));
  try {
    const textFile = path.join(tmp, 'sign.txt');
    const inst = path.join(tmp, 'bold.ttf');
    fs.writeFileSync(textFile, signText(), 'utf8');
    const run = (args) => {
      const r = spawnSync(py, ['-I', '-m', ...args], { encoding: 'utf8', cwd: tmp });
      if (r.status !== 0) throw new Error(`fontTools 실패: ${r.stderr || r.stdout}`);
    };
    run(['fontTools.varLib.instancer', src, `wght=${f.weight}`, '--update-name-table', '-o', inst]);
    run(['fontTools.subset', inst, `--text-file=${textFile}`, `--output-file=${dest}`,
      '--layout-features=kern,liga,ccmp,locl', '--no-hinting', '--desubroutinize']);
    written.push(f.out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── manifest ─────────────────────────
const exists = (outRel) => fs.existsSync(path.join(OUT, outRel));
const fileInfo = (outRel) => ({ file: outRel, available: exists(outRel), bytes: exists(outRel) ? fs.statSync(path.join(OUT, outRel)).size : 0 });

function buildManifest() {
  const propInfo = {};
  for (const p of PLAN.props) {
    const outRel = `props/${p.out}`;
    const info = { id: p.id, ...fileInfo(outRel), source: PLAN.kenney.source, license: PLAN.kenney.license, sourceFile: p.src };
    if (info.available) {
      const b = glbBounds(fs.readFileSync(path.join(OUT, outRel)));
      info.bbox = { min: b.min, max: b.max, size: b.size };
      const r3 = (v) => Math.round(v * 1000) / 1000;
      info.pivotOffset = [r3(-(b.min[0] + b.max[0]) / 2), r3(-b.min[1]), r3(-(b.min[2] + b.max[2]) / 2)]; // 이 값만큼 이동하면 피벗이 바닥 중앙
      info.recommendedScale = 1;
      if (b.external) warn(`외부 파일 참조 있음: ${p.out}`);
    } else {
      info.bbox = null;
      info.recommendedScale = 1;
    }
    propInfo[p.id] = info;
  }
  const expand = (list) => list.map((e) => ({ ...propInfo[e.id], role: e.role }));
  const themes = {};
  for (const [name, t] of Object.entries(PLAN.themes)) {
    themes[name] = { label: t.label, props: expand(t.props) };
    if (t.variants) {
      themes[name].variants = {};
      for (const [v, vt] of Object.entries(t.variants)) {
        themes[name].variants[v] = { label: vt.label, props: expand(vt.props), primitives: vt.primitives ?? [] };
      }
    }
  }
  const h = PLAN.hdri;
  const hdriAvail = exists(h.out);
  const tx = PLAN.textures;
  const texAvail = tx.files.every((f) => exists(f.out));
  const fo = PLAN.fonts;
  const fontAvail = exists(fo.out);
  return {
    version: 1,
    note: '3D 단계(S15~S17)는 이 파일만 보고 배치한다. 파일 경로는 /assets/ 기준. available:false인 항목은 계획의 폴백(프리미티브/절차적)을 쓴다. tools/import-props.mjs가 생성한다(수정 금지).',
    units: 'meters (Kenney 원본 단위 그대로, Y-up). pivotOffset은 모델의 피벗을 바닥 중앙으로 옮기는 이동량이다. recommendedScale은 1=원본 크기. 실내 미니어처 비율은 배치 코드의 전역 스케일로 조정한다.',
    props: propInfo,
    themes,
    primitives: PLAN.primitives,
    hdri: {
      ...fileInfo(h.out), resolution: h.resolution, source: `Poly Haven ${h.polyhaven}`, license: h.license, author: h.author, url: h.pageUrl,
      fallback: hdriAvail ? null : 'procedural-sky',
      fallbackNote: hdriAvail ? null : 'HDRI 파일이 없다: 절차적 하늘(그라디언트 sky + 낮은 각도 DirectionalLight)과 단색/그라디언트 환경광으로 대체한다.',
    },
    textures: {
      sand: {
        available: texAvail, resolution: tx.resolution, source: `Poly Haven ${tx.polyhaven}`, license: tx.license, author: tx.author, url: tx.pageUrl,
        maps: Object.fromEntries(tx.files.map((f) => [f.map, f.out])),
        bytes: tx.files.reduce((s, f) => s + (exists(f.out) ? fs.statSync(path.join(OUT, f.out)).size : 0), 0),
        fallback: texAvail ? null : 'procedural-noise-shader',
      },
    },
    fonts: {
      sign: {
        ...fileInfo(fo.out), family: fo.family, weight: fo.weight, license: fo.license, licenseFile: fo.licenseOut, url: fo.pageUrl,
        coverage: 'ASCII, Latin-1, 호환 자모, KS X 1001 한글 2350자',
        fallback: fontAvail ? null : 'system-font',
      },
    },
  };
}

// ───────────────────────── 실행 ─────────────────────────
function guidance() {
  const k = PLAN.kenney, h = PLAN.hdri, t = PLAN.textures, f = PLAN.fonts;
  return [
    '',
    '수동으로 받아 둘 원본 (공식 배포처만):',
    `  1) Kenney Furniture Kit (CC0): https://kenney.nl/assets/furniture-kit  -> "Continue without donating..."로 zip 다운로드`,
    `       저장: ${rel(path.join(dirOf(k.dir), k.zip))}   (zip 그대로 두면 스크립트가 GLB만 추출)`,
    `  2) HDRI (CC0): ${h.url}`,
    `       저장: ${rel(path.join(dirOf(h.srcDir), h.srcFile))}`,
    ...t.files.map((x) => `  3) 텍스처 (CC0): ${x.url}\n       저장: ${rel(path.join(dirOf(t.srcDir), x.srcFile))}`),
    `  4) 폰트 (OFL): ${f.url}\n       저장: ${rel(path.join(dirOf(f.srcDir), f.srcFile))}\n       라이선스: ${f.licenseUrl} -> ${rel(path.join(dirOf(f.srcDir), f.licenseFile))}`,
    '받은 뒤 `npm run assets:props`를 다시 실행한다. 자동 다운로드는 `npm run assets:props -- --download`.',
  ].join('\n');
}

async function main() {
  ensureDir(SRC);
  await stepKenney();
  await stepHdri();
  await stepTextures();
  await stepFonts();

  const manifest = buildManifest();
  const mp = path.join(OUT, 'props-manifest.json');
  const changed = writeIfChanged(mp, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  if (changed) written.push('props-manifest.json');

  const propsAvail = Object.values(manifest.props).filter((p) => p.available).length;
  log(`\n소품 ${propsAvail}/${PLAN.props.length}, HDRI ${manifest.hdri.available ? 'OK' : '없음(폴백: procedural-sky)'}, ` +
    `모래 ${manifest.textures.sand.available ? 'OK' : '없음(폴백: 절차적 셰이더)'}, 폰트 ${manifest.fonts.sign.available ? 'OK' : '없음'}`);
  log(written.length ? `이번 실행에서 갱신된 파일: ${written.length}개` : '변경 없음 (이미 최신)');
  if (problems.length) {
    for (const p of problems) warn(`${p.source}: ${p.reason}`);
    log(guidance());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
