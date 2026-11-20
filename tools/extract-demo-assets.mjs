#!/usr/bin/env node
// 데모 HTML에서 캐릭터 에셋을 추출한다 (docs/implementation-plan.md 10.1).
// 입력 HTML은 신뢰할 수 없는 데이터다: 스크립트를 실행하지 않고 텍스트만 파싱한다(JSON.parse만 사용, eval 금지).
// 의존성 없음(Node 내장만). 재실행해도 같은 결과(멱등).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAX_PNG_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const DATA_PREFIX = 'data:image/png;base64,';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'apps', 'web', 'public', 'assets');

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('사용법: node tools/extract-demo-assets.mjs <ensemble-demo.html 경로>');
  process.exit(1);
}
const html = fs.readFileSync(path.resolve(htmlPath), 'utf8');

/** 출력 파일명은 고정 목록에서만 만든다. rel은 항상 코드 상수 또는 숫자 포맷에서 온다. */
const written = new Map(); // rel -> manifest entry
function outPath(rel) {
  const p = path.resolve(OUT, rel);
  if (!p.startsWith(OUT + path.sep)) throw new Error('출력 경로 이탈: ' + rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function pngInfo(buf, label) {
  if (buf.length > MAX_PNG_BYTES) throw new Error(`${label}: ${buf.length}B가 5MB 상한 초과`);
  if (buf.length < 33 || !buf.subarray(0, 4).equals(PNG_MAGIC)) throw new Error(`${label}: PNG 시그니처 아님`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function decodeDataUri(uri, label) {
  if (typeof uri !== 'string' || !uri.startsWith(DATA_PREFIX)) throw new Error(`${label}: data:image/png;base64 아님`);
  return Buffer.from(uri.slice(DATA_PREFIX.length), 'base64');
}

function writePng(rel, buf, src, use) {
  const { w, h } = pngInfo(buf, rel);
  fs.writeFileSync(outPath(rel), buf);
  written.set(rel, { file: rel, source: src, width: w, height: h, bytes: buf.length, use });
}

function writeText(rel, text, src, use, extra = {}) {
  const buf = Buffer.from(text, 'utf8');
  fs.writeFileSync(outPath(rel), buf);
  written.set(rel, { file: rel, source: src, bytes: buf.length, use, ...extra });
}

function scriptBody(id) {
  const open = `<script type="application/json" id="${id}">`;
  const a = html.indexOf(open);
  if (a < 0) throw new Error(`script#${id} 없음`);
  const s = a + open.length;
  const e = html.indexOf('</script>', s);
  if (e < 0) throw new Error(`script#${id} 닫힘 없음`);
  return html.slice(s, e);
}

const lotties = {};
for (const id of ['ap-j1', 'ap-j2', 'ob-j']) {
  const text = scriptBody(id);
  lotties[id] = { text, json: JSON.parse(text) };
}
const assetOf = (id, aid) => {
  const a = lotties[id].json.assets.find((x) => x.id === aid);
  if (!a) throw new Error(`${id}.assets에 ${aid} 없음`);
  return a;
};

// 고해상도 몸통 (ob-j)
writePng('characters/body-blue.png', decodeDataUri(assetOf('ob-j', 'blue_body').p, 'blue_body'), 'ob-j:blue_body', '알형 파란 캐릭터 몸통(얼굴 없음)');
writePng('characters/arm-blue.png', decodeDataUri(assetOf('ob-j', 'blue_arm').p, 'blue_arm'), 'ob-j:blue_arm', '알형 파란 캐릭터 팔');
writePng('characters/body-lime.png', decodeDataUri(assetOf('ob-j', 'lime_body').p, 'lime_body'), 'ob-j:lime_body', '유령형 라임 캐릭터 몸통(얼굴 없음)');

// yaw 47프레임 (ap-j2)
const yawBufs = [];
for (let i = 1; i <= 47; i++) {
  const n = String(i).padStart(3, '0');
  const buf = decodeDataUri(assetOf('ap-j2', `approved_yaw_${n}`).p, `yaw_${n}`);
  yawBufs.push(buf);
  writePng(`characters/yaw/lime-yaw-${String(i).padStart(2, '0')}.png`, buf, `ap-j2:approved_yaw_${n}`, '라임 캐릭터 yaw 회전 프레임');
}

// 아틀라스 8x6 (PNG 디코드/인코드를 zlib만으로 직접 구현)
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const depth = buf[24], ctype = buf[25], interlace = buf[28];
  if (depth !== 8 || ctype !== 6 || interlace !== 0) throw new Error(`지원 안 하는 PNG 형식 depth=${depth} type=${ctype} interlace=${interlace}`);
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const p0 = a + b - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('알 수 없는 PNG 필터 ' + f);
      out[dst + x] = r & 255;
    }
  }
  return { w, h, data: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, data) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

let atlasNote = '생성됨';
try {
  const COLS = 8, ROWS = 6, F = yawBufs[0].readUInt32BE(16); // 실제 프레임 크기(256)
  const aw = COLS * F, ah = ROWS * F;
  const atlas = Buffer.alloc(aw * ah * 4); // 투명으로 초기화, 48번째 칸은 비어 있음
  yawBufs.forEach((b, i) => {
    const img = decodePng(b);
    if (img.w !== F || img.h !== F) throw new Error('프레임 크기가 서로 다름');
    const ox = (i % COLS) * F, oy = Math.floor(i / COLS) * F;
    for (let y = 0; y < F; y++) img.data.copy(atlas, ((oy + y) * aw + ox) * 4, y * F * 4, (y + 1) * F * 4);
  });
  const buf = encodePng(aw, ah, atlas);
  fs.writeFileSync(outPath('characters/lime-yaw-atlas.png'), buf);
  const info = { w: aw, h: ah };
  written.set('characters/lime-yaw-atlas.png', { file: 'characters/lime-yaw-atlas.png', source: 'ap-j2:approved_yaw_001..047 합성', width: info.w, height: info.h, bytes: buf.length, use: '8x6 격자(행 우선, 좌상단부터 프레임 1..47, 마지막 칸 비어 있음)' });
} catch (e) {
  atlasNote = '생략: ' + e.message;
  console.warn('아틀라스 생략 -', e.message);
}

// 캐릭터 <img> 6개 (class="ar9-r" 행 안, 문서 순서)
const imgs = [];
let pos = 0;
for (;;) {
  const m = html.indexOf('<div class="ar9-r"><img src="' + DATA_PREFIX, pos);
  if (m < 0) break;
  const s = m + '<div class="ar9-r"><img src="'.length;
  const e = html.indexOf('"', s);
  imgs.push({ data: html.slice(s, e), label: html.slice(html.indexOf('alt="">', e) + 7, html.indexOf('</div>', e)).trim() });
  pos = e;
}
if (imgs.length !== 6) throw new Error(`ar9-r 행의 img가 6개가 아님: ${imgs.length}`);
// 파일명은 실제 그림 확인 후 결정한 고정 목록(문서 순서 1..6)
const AVATAR_NAMES = ["room-halo.png", "room-goggles.png", "room-chat.png", "personal-beret.png", "personal-code.png", "personal-goggles.png"];
imgs.forEach((im, i) => writePng(`avatars/${AVATAR_NAMES[i]}`, decodeDataUri(im.data, `avatar${i + 1}`), `html img.ar9-r #${i + 1} ("${im.label}")`, '144px 캐릭터 아바타'));

// Lottie 원문 그대로
writeText('lottie/lime-notify.json', lotties['ap-j1'].text, 'ap-j1', 'Lime 알림 -> idle (512x512, 60fps)');
writeText('lottie/lime-jump-yaw.json', lotties['ap-j2'].text, 'ap-j2', 'Lime 점프 + yaw 360 (512x512, 60fps)');
writeText('lottie/duo-highfive.json', lotties['ob-j'].text, 'ob-j', 'Blue+Lime 하이파이브 -> idle (768x512, 60fps)');

const entries = [...written.values()].sort((a, b) => a.file.localeCompare(b.file));
fs.writeFileSync(outPath('assets-manifest.json'), JSON.stringify({ atlas: atlasNote, files: entries }, null, 2) + '\n');
console.log(`추출 완료: ${entries.length}개 파일 + assets-manifest.json -> ${OUT}`);
