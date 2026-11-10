#!/usr/bin/env node
/**
 * merge-tickets.mjs — 将 data 目录下的发票 PDF 合并到 A4 页面，便于打印。
 *
 * 用法：
 *   node merge-tickets.mjs
 *   node merge-tickets.mjs --input data --output out --max-per-page 4 --margin-mm 3 --gap-mm 6
 *   node merge-tickets.mjs --layout h2x2
 *
 * 布局规则（自动在候选排法中选择缩放最大者，等比缩放、格内居中）：
 *   1~2 张 → 竖版；3 张 → 竖版一列三行；4 张 → 横版 2×2；
 *   5~8 张 → 竖版两列（3~4 行）；9 张 → 横版 3×3。
 *   超过上限时每 N 张一页，末页按余数排布。
 *   可用 --layout [h]行x列 强制指定布局（h = 横版），如 2x1、h2x2，此时每页容量 = 行×列。
 *
 * 产物：
 *   out/merged.pdf        合并后的 PDF
 *   报告默认输出到控制台；加 --report 参数时额外写入 out/merge-report.md
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';

const MM = 72 / 25.4; // 1mm = 2.8346pt
const A4 = [595.276, 841.89]; // A4 竖版 [宽, 高] pt

// ---------- CLI 参数 ----------
function usage() {
  console.log(`用法: node merge-tickets.mjs [选项]

选项:
  --input <dir>        输入目录，扫描其中的 *.pdf（默认 data）
  --output <dir>       输出目录，写入 merged.pdf（默认 out）
  --max-per-page <n>   每页最多合并的票据数，1~9（默认 4；指定 --layout 时被忽略）
  --margin-mm <mm>     页边距（默认 3）
  --gap-mm <mm>        票间距（默认 6）
  --layout <spec>      强制布局：auto（默认自动选择）或 [h]行x列，如 2x1、2x2、h2x2、3x3（h = 横版）
  --report             将报告写入输出目录 merge-report.md（默认仅控制台输出）
  -h, --help           显示帮助`);
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { input: 'data', output: 'out', maxPerPage: 4, marginMm: 3, gapMm: 6, layout: 'auto', report: false };
  const map = {
    '--input': ['input', 'str'],
    '--output': ['output', 'str'],
    '--max-per-page': ['maxPerPage', 'int'],
    '--margin-mm': ['marginMm', 'num'],
    '--gap-mm': ['gapMm', 'num'],
    '--layout': ['layout', 'str'],
    '--report': ['report', 'flag'],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      usage();
      process.exit(0);
    }
    const spec = map[a];
    if (!spec) fail(`未知参数：${a}（--help 查看用法）`);
    if (spec[1] === 'flag') {
      opts[spec[0]] = true;
      continue;
    }
    if (a === '--max-per-page') opts.maxPerPageGiven = true;
    const v = argv[++i];
    if (v === undefined) fail(`参数 ${a} 缺少值`);
    if (spec[1] === 'str') {
      opts[spec[0]] = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`参数 ${a} 的值无效：${v}`);
      opts[spec[0]] = spec[1] === 'int' ? Math.trunc(n) : n;
    }
  }
  if (opts.maxPerPage < 1 || opts.maxPerPage > 9) fail('--max-per-page 需在 1~9 之间');
  return opts;
}

// ---------- --layout 解析 ----------
// 格式：auto（自动）或 [h]行x列，如 2x1、3x1、2x2、h2x2、3x3（h 前缀 = 横版）。
function parseLayoutSpec(str) {
  if (!str || str === 'auto') return null;
  const m = /^(h?)(\d+)x(\d+)$/i.exec(str.trim());
  if (!m) fail(`--layout 格式无效：${str}（合法示例：auto、2x1、3x1、2x2、h2x2、3x3）`);
  const orient = m[1] ? 'landscape' : 'portrait';
  const rows = Number(m[2]);
  const cols = Number(m[3]);
  if (rows < 1 || cols < 1 || rows * cols > 12) {
    fail(`--layout 行列数超出范围：${str}（行列数须 ≥1，且 行×列 ≤ 12）`);
  }
  return { orient, rows, cols, cells: rows * cols };
}

// 由 --layout 规格构造布局（每页容量 = 行×列，缩放按格子尺寸等比计算）
function fixedLayout(spec, maxW, maxH, margin, gap) {
  const [pw, ph] = spec.orient === 'portrait' ? A4 : [A4[1], A4[0]];
  const cellW = (pw - 2 * margin - (spec.cols - 1) * gap) / spec.cols;
  const cellH = (ph - 2 * margin - (spec.rows - 1) * gap) / spec.rows;
  if (cellW <= 0 || cellH <= 0) fail('--layout 行列数过多：格子尺寸为负，请减小行列数或页边距/票间距');
  return {
    orient: spec.orient,
    rows: spec.rows,
    cols: spec.cols,
    cells: spec.cells,
    pw,
    ph,
    cellW,
    cellH,
    scale: Math.min(cellW / maxW, cellH / maxH, 1),
    forced: true,
  };
}

// ---------- 布局选择 ----------
// 在候选排法（竖版/横版 × 行列组合）中选择：优先无空格的排法，其次竖版，再次缩放最大。
// 缩放 = min(格宽/票宽, 格高/票高, 1)，等比、不放大。maxPerPage 仅决定每页分几张，
// 网格按组内实际张数选择（可比张数多格，余格留空）。
const GRIDS = [
  [1, 1], [2, 1], [1, 2], [3, 1], [1, 3], [2, 2], [4, 1], [1, 4],
  [5, 1], [1, 5], [3, 2], [2, 3], [4, 2], [2, 4], [3, 3],
];

function chooseLayout(n, maxW, maxH, margin, gap) {
  const cands = [];
  for (const orient of ['portrait', 'landscape']) {
    const [pw, ph] = orient === 'portrait' ? A4 : [A4[1], A4[0]];
    for (const [rows, cols] of GRIDS) {
      const cells = rows * cols;
      if (cells < n) continue; // 网格须容纳本页全部票据；余格留空（末行居中），过大网格会被缩放淘汰
      const cellW = (pw - 2 * margin - (cols - 1) * gap) / cols;
      const cellH = (ph - 2 * margin - (rows - 1) * gap) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      const scale = Math.min(cellW / maxW, cellH / maxH, 1);
      cands.push({ orient, rows, cols, cells, pw, ph, cellW, cellH, scale });
    }
  }
  if (cands.length === 0) throw new Error('无可用布局：票据过大或页边距/间距参数过大');
  const best = Math.max(...cands.map((c) => c.scale));
  const near = cands.filter((c) => c.scale >= best * 0.95 - 1e-9);
  near.sort(
    (a, b) =>
      (a.cells === n ? 0 : 1) - (b.cells === n ? 0 : 1) || // 优先无空格
      (a.orient === 'portrait' ? -1 : 1) - (b.orient === 'portrait' ? -1 : 1) || // 其次竖版
      b.scale - a.scale || // 再次缩放最大
      a.cols - b.cols
  );
  return near[0];
}

// ---------- 绘制（处理页面旋转） ----------
function drawEmbedded(page, t, x, y, dw, dh) {
  // dw/dh 为视觉尺寸（已按旋转换算），实际绘制尺寸按内嵌页存储尺寸缩放
  const ew = t.embedded.width * t.scale;
  const eh = t.embedded.height * t.scale;
  switch (t.rot) {
    case 0:
      page.drawPage(t.embedded, { x, y, width: ew, height: eh });
      break;
    case 90: // /Rotate 90 = 显示时顺时针 90°，绘制时逆时针补偿
      page.drawPage(t.embedded, { x, y: y + dh, width: ew, height: eh, rotate: degrees(90) });
      break;
    case 180:
      page.drawPage(t.embedded, { x: x + dw, y: y + dh, width: ew, height: eh, rotate: degrees(180) });
      break;
    case 270:
      page.drawPage(t.embedded, { x: x + dw, y, width: ew, height: eh, rotate: degrees(270) });
      break;
    default:
      page.drawPage(t.embedded, { x, y, width: ew, height: eh });
  }
}

// ---------- 主流程 ----------
const opts = parseArgs(process.argv.slice(2));
const forcedLayout = parseLayoutSpec(opts.layout);
const inputDir = resolve(opts.input);
const outputDir = resolve(opts.output);
const margin = opts.marginMm * MM;
const gap = opts.gapMm * MM;

if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
  fail(`输入目录不存在：${inputDir}`);
}

const pdfNames = readdirSync(inputDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
  .map((e) => e.name)
  .sort(new Intl.Collator('zh', { numeric: true }).compare);

if (pdfNames.length === 0) fail(`输入目录中没有 PDF 文件：${inputDir}`);

const warnings = [];
if (forcedLayout && opts.maxPerPageGiven) {
  warnings.push(`已指定 --layout，忽略 --max-per-page=${opts.maxPerPage}`);
}
const tickets = [];
const outDoc = await PDFDocument.create();
outDoc.setTitle('发票合并打印');
outDoc.setProducer('merge-tickets.mjs (pdf-lib)');

for (const name of pdfNames) {
  const bytes = readFileSync(join(inputDir, name));
  let src;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    warnings.push(`${name}：无法解析（${e.message}），已跳过`);
    continue;
  }
  if (src.getPageCount() > 1) {
    warnings.push(`${name}：共 ${src.getPageCount()} 页，仅取第 1 页`);
  }
  const page = src.getPage(0);
  let { width, height } = page.getSize();
  let rot = ((page.getRotation()?.angle ?? 0) % 360 + 360) % 360;
  if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) {
    warnings.push(`${name}：页面旋转角 ${rot}° 不受支持，按 0° 处理`);
    rot = 0;
  }
  const embedded = (await outDoc.embedPdf(bytes, [0]))[0];
  // 视觉尺寸：旋转 90/270 时宽高互换
  const [vw, vh] = rot === 90 || rot === 270 ? [height, width] : [width, height];
  tickets.push({ file: name, embedded, rot, vw, vh, scale: 0 });
}

// 分页：强制布局时每页容量 = 行×列，否则按 max-per-page
const perPage = forcedLayout ? forcedLayout.cells : opts.maxPerPage;
const groups = [];
for (let i = 0; i < tickets.length; i += perPage) {
  groups.push(tickets.slice(i, i + perPage));
}

const pageInfos = [];
for (const group of groups) {
  const n = group.length;
  const maxW = Math.max(...group.map((t) => t.vw));
  const maxH = Math.max(...group.map((t) => t.vh));
  const layout = forcedLayout
    ? fixedLayout(forcedLayout, maxW, maxH, margin, gap)
    : chooseLayout(n, maxW, maxH, margin, gap);
  const page = outDoc.addPage([layout.pw, layout.ph]);

  const placements = [];
  let idx = 0;
  for (let row = 0; row < layout.rows; row++) {
    const count = Math.min(layout.cols, n - row * layout.cols);
    if (count <= 0) break;
    // 末行不满时整行居中
    const rowOffset = ((layout.cols - count) * (layout.cellW + gap)) / 2;
    for (let c = 0; c < count; c++, idx++) {
      const t = group[idx];
      t.scale = layout.scale;
      const dw = t.vw * layout.scale;
      const dh = t.vh * layout.scale;
      const cellX = rowOffset + margin + c * (layout.cellW + gap);
      const cellTop = margin + row * (layout.cellH + gap);
      const x = cellX + (layout.cellW - dw) / 2;
      const yTop = cellTop + (layout.cellH - dh) / 2;
      const y = layout.ph - yTop - dh; // PDF 坐标原点在左下
      drawEmbedded(page, t, x, y, dw, dh);
      placements.push({ ticket: t, x, y, w: dw, h: dh, row: row + 1, col: c + 1 });
    }
  }
  pageInfos.push({ layout, placements });
}

// 写出 merged.pdf
const pdfBytes = await outDoc.save();
mkdirSync(outputDir, { recursive: true });
const pdfPath = join(outputDir, 'merged.pdf');
writeFileSync(pdfPath, pdfBytes);

// ---------- 报告（默认仅控制台输出，--report 时写入文件） ----------
const fmtMm = (pt) => (pt / MM).toFixed(1);
const now = new Date();
const pad = (v) => String(v).padStart(2, '0');
const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const orientName = (o) => (o === 'portrait' ? '竖版' : '横版');
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const data = {
  ts,
  inputDir,
  ticketCount: tickets.length,
  pdfPath,
  pageCount: pageInfos.length,
  portraitPages: pageInfos.filter((p) => p.layout.orient === 'portrait').length,
  landscapePages: pageInfos.filter((p) => p.layout.orient === 'landscape').length,
  params: forcedLayout
    ? `布局：指定 ${forcedLayout.orient === 'landscape' ? 'h' : ''}${forcedLayout.rows}x${forcedLayout.cols}（每页 ${forcedLayout.cells} 张），页边距 ${opts.marginMm}mm，票间距 ${opts.gapMm}mm`
    : `每页最多 ${opts.maxPerPage} 张，页边距 ${opts.marginMm}mm，票间距 ${opts.gapMm}mm`,
  tickets: tickets.map((t, i) => ({
    no: i + 1,
    file: t.file,
    size: `${fmtMm(t.vw)} × ${fmtMm(t.vh)} mm${t.rot ? `（旋转 ${t.rot}°）` : ''}`,
  })),
  pages: pageInfos.map((p) => ({
    label: `${orientName(p.layout.orient)} ${p.layout.rows}行×${p.layout.cols}列${p.layout.forced ? '（指定）' : ''}`,
    scale: p.layout.scale,
    items: p.placements.map((pl) => ({
      pos: p.layout.rows * p.layout.cols === 1 ? '居中' : `第${pl.row}行·第${pl.col}列`,
      file: pl.ticket.file,
      scale: pl.ticket.scale,
      size: `${fmtMm(pl.w)} × ${fmtMm(pl.h)} mm`,
    })),
  })),
  warnings,
};

function renderConsole(d) {
  const L = [];
  L.push(`✔ 合并完成：${d.ticketCount} 张票据 → ${d.pageCount} 页 A4`);
  L.push('─'.repeat(46));
  L.push(`生成时间 : ${d.ts}`);
  L.push(`输入目录 : ${d.inputDir}`);
  L.push(`输出文件 : ${d.pdfPath}`);
  L.push(`总页数   : ${d.pageCount} 页 A4（竖版 ${d.portraitPages} 页 / 横版 ${d.landscapePages} 页）`);
  L.push(`参数     : ${d.params}`);
  L.push('输入清单');
  d.tickets.forEach((t) => L.push(`  ${t.no}. ${t.file} — ${t.size}`));
  L.push('页面明细');
  d.pages.forEach((p, i) => {
    L.push(`  第 ${i + 1} 页 — ${p.label}，缩放 ${pct(p.scale)}`);
    p.items.forEach((it) => L.push(`    · ${it.pos}  ${it.file}  ${pct(it.scale)}  ${it.size}`));
  });
  L.push('警告');
  if (d.warnings.length === 0) L.push('  无');
  else d.warnings.forEach((w) => L.push(`  - ${w}`));
  return L.join('\n');
}

function renderMarkdown(d) {
  const L = [];
  L.push('# 发票合并报告');
  L.push('');
  L.push('| 项目 | 内容 |');
  L.push('| --- | --- |');
  L.push(`| 生成时间 | ${d.ts} |`);
  L.push(`| 输入目录 | ${d.inputDir}（共 ${d.ticketCount} 张票据） |`);
  L.push(`| 输出文件 | ${d.pdfPath} |`);
  L.push(`| 总页数 | ${d.pageCount} 页 A4（竖版 ${d.portraitPages} 页 / 横版 ${d.landscapePages} 页） |`);
  L.push(`| 参数 | ${d.params} |`);
  L.push('');
  L.push('## 输入清单');
  L.push('');
  L.push('| # | 文件 | 票面尺寸 |');
  L.push('| --- | --- | --- |');
  d.tickets.forEach((t) => L.push(`| ${t.no} | ${t.file} | ${t.size} |`));
  L.push('');
  L.push('## 页面明细');
  L.push('');
  d.pages.forEach((p, i) => {
    L.push(`### 第 ${i + 1} 页 — ${p.label}，缩放 ${pct(p.scale)}`);
    L.push('');
    L.push('| 位置 | 文件 | 缩放 | 单张打印尺寸 |');
    L.push('| --- | --- | --- | --- |');
    p.items.forEach((it) => L.push(`| ${it.pos} | ${it.file} | ${pct(it.scale)} | ${it.size} |`));
    L.push('');
  });
  L.push('## 警告');
  L.push('');
  if (d.warnings.length === 0) L.push('无');
  else d.warnings.forEach((w) => L.push(`- ${w}`));
  L.push('');
  return L.join('\n');
}

console.log(renderConsole(data));

if (opts.report) {
  mkdirSync(outputDir, { recursive: true });
  const reportPath = join(outputDir, 'merge-report.md');
  writeFileSync(reportPath, renderMarkdown(data), 'utf8');
  console.log(`报告已写入：${reportPath}`);
}
