/*
 * Informe de gastos de la finca (PDF carta): cuánta plata ha salido y qué tiene soporte.
 *
 * Toma de Supabase los gastos y jornales de la finca (sin el préstamo del invernadero,
 * que tiene su propio informe), los ordena por fecha, junta en una fila los productos
 * de una misma factura y pega al final los soportes (facturas y comprobantes) como anexos.
 *
 * Uso:   node informes/generar_informe_finca.mjs [--compras] [salida.pdf] [desde AAAA-MM-DD]
 *        --compras: solo lo comprado (insumos, herramientas, semillas…), sin jornales, transferencias
 *        por verificar, cuotas del crédito ni gastos de Lauro.
 * Necesita: Playwright (Chromium) y pdfunite (poppler-utils).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const hoy = new Date().toISOString().slice(0, 10);
const SOLO_COMPRAS = process.argv.includes('--compras'), ARGS = process.argv.slice(2).filter(a => a !== '--compras');
const NO_SON_COMPRAS = ['jornales', 'Por verificar', 'Pago crédito', 'Gastos Lauro'];
const SALIDA = path.resolve(ARGS[0] || path.join(AQUI, 'salida', `Informe_${SOLO_COMPRAS ? 'compras' : 'gastos'}_finca_${hoy}.pdf`));
const DESDE = ARGS[1] || '2026-01-01';
const TITULO = SOLO_COMPRAS ? 'Compras de la finca y los cultivos' : 'Gastos de la finca y los cultivos';
const SUPA = 'https://sueramxzbibijuaamzbi.supabase.co';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_z94UVtLm_UN4rJUuGMGS4w_FwTc79Fc';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

/* ── utilidades ── */
const num = v => parseFloat(v) || 0;
const plata = n => '$' + Math.round(n).toLocaleString('es-CO');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fecha = d => { const [a, m, dd] = String(d).slice(0, 10).split('-'); return `${+dd} ${MESES[+m - 1].slice(0, 3)} ${a}`; };
const fechaLarga = d => { const [a, m, dd] = String(d).slice(0, 10).split('-'); return `${+dd} de ${MESES[+m - 1]} de ${a}`; };
const nombreMes = k => { const [a, m] = k.split('-'); return `${MESES[+m - 1][0].toUpperCase()}${MESES[+m - 1].slice(1)} ${a}`; };
const CUENTAS = { 'Nutrición': 'Abonos (Nutrición)', jornales: 'Mano de obra / Jornales', EPP: 'Protección (EPP)', 'Pago crédito': 'Pago del crédito', servicios: 'Servicios', otro: 'Otro' };
const cuenta = c => CUENTAS[c] || c || 'Sin categoría';
async function api(tabla, filtro) {
  const r = await fetch(`${SUPA}/rest/v1/${tabla}?${filtro}`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`${tabla}: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ── datos ── */
let [compras, jornales, soportes, [pr]] = await Promise.all([
  api('compras', `proyecto_id=is.null&origen=neq.consumo&fecha_compra=gte.${DESDE}&limit=5000`),
  api('jornales', `proyecto_id=is.null&fecha=gte.${DESDE}&limit=5000`),
  api('soportes', 'limit=5000'),
  api('proyectos', 'activo=eq.true&limit=1')
]);
if (SOLO_COMPRAS) { compras = compras.filter(c => !NO_SON_COMPRAS.includes(c.categoria)); jornales = []; }
const sopDe = (campo, ids) => soportes.filter(s => ids.includes(s[campo]));

/* Una factura = una fila (sus productos van debajo); lo demás, una fila por gasto */
const grupos = new Map();
for (const c of compras) {
  const k = c.numero_factura ? `f|${c.proveedor}|${c.numero_factura}` : `g|${c.id}`;
  if (!grupos.has(k)) grupos.set(k, []);
  grupos.get(k).push(c);
}
const movs = [...grupos.values()].map(g => {
  const c = g[0], cuentas = [...new Set(g.map(x => cuenta(x.categoria)))];
  return { fecha: g.map(x => x.fecha_compra).sort()[0], proveedor: c.proveedor || 'No especificado', factura: c.numero_factura,
    concepto: g.length > 1 ? `Factura con ${g.length} productos` : c.concepto, productos: g.length > 1 ? g : [],
    cuenta: cuentas.join(', '), cuentas: g.map(x => [cuenta(x.categoria), num(x.valor_total)]), valor: g.reduce((a, x) => a + num(x.valor_total), 0),
    soportes: sopDe('compra_id', g.map(x => x.id)) };
});
for (const j of jornales) movs.push({ fecha: j.fecha, proveedor: j.trabajador, concepto: `Jornal: ${j.trabajador} · ${num(j.dias)} día(s)${j.nota ? ' · ' + j.nota : ''}`,
  productos: [], cuenta: cuenta('jornales'), cuentas: [[cuenta('jornales'), num(j.valor_total)]], valor: num(j.valor_total), soportes: sopDe('jornal_id', [j.id]) });
movs.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.proveedor.localeCompare(b.proveedor));

/* Anexos: un número por archivo (varios productos de una factura comparten el mismo PDF) */
const anexos = [], porRuta = new Map();
for (const m of movs) {
  m.anexos = [...new Set(m.soportes.map(s => {
    if (!porRuta.has(s.ruta)) { const a = { n: anexos.length + 1, s, mov: m }; porRuta.set(s.ruta, a); anexos.push(a); }
    return porRuta.get(s.ruta).n;
  }))];
}

/* Totales */
const suma = l => l.reduce((a, m) => a + m.valor, 0);
const total = suma(movs), conSop = suma(movs.filter(m => m.anexos.length));
const porMes = {}, porCuenta = {};
for (const m of movs) {
  const k = String(m.fecha).slice(0, 7), ok = m.anexos.length > 0;
  porMes[k] = porMes[k] || { v: 0, s: 0 }; porMes[k].v += m.valor; if (ok) porMes[k].s += m.valor;
  for (const [c, v] of m.cuentas) { porCuenta[c] = porCuenta[c] || { v: 0, s: 0 }; porCuenta[c].v += v; if (ok) porCuenta[c].s += v; }
}
const filaTot = ([k, x], etiqueta) => `<tr><td>${esc(etiqueta)}</td><td class="n">${plata(x.v)}</td><td class="n">${plata(x.s)}</td><td class="n ${x.v - x.s > 0 ? 'falta' : ''}">${x.v - x.s > 0 ? plata(x.v - x.s) : '—'}</td></tr>`;

const filas = movs.map((m, i) => `
  <tr class="mov"><td class="c">${i + 1}</td><td class="c">${fecha(m.fecha)}</td><td>${esc(m.proveedor.split(' · ')[0])}</td><td><b>${esc(m.concepto)}</b>${m.factura ? `<div class="sub">Factura ${esc(m.factura)}</div>` : ''}</td>
    <td>${esc(m.cuenta)}</td><td class="n"><b>${plata(m.valor)}</b></td><td class="c">${m.anexos.length ? m.anexos.join(', ') : '<span class="falta">Sin soporte</span>'}</td></tr>
  ${m.productos.length ? `<tr class="det"><td></td><td colspan="6"><table class="items"><colgroup><col><col style="width:22%"></colgroup>${m.productos.map(x => `<tr><td>${esc(x.concepto)}</td><td class="n">${plata(num(x.valor_total))}</td></tr>`).join('')}</table></td></tr>` : ''}`).join('');

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${TITULO}</title><style>
@page{size:Letter;margin:16mm 14mm 18mm}
body{font-family:Arial,Helvetica,sans-serif;color:#1a1f14;font-size:10.5pt;line-height:1.4}
h1{font-size:20pt;margin:0;color:#2A4F08}h2{font-size:13pt;color:#2A4F08;border-bottom:2px solid #639922;padding-bottom:3px;margin:16px 0 6px;break-after:avoid}
table.chica{break-inside:avoid}.chica td,.chica th{padding:3px 6px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9d4bb;padding:4px 6px;vertical-align:top;text-align:left}th{background:#EAF3DE;font-size:9.5pt}
td.n,th.n{text-align:right;white-space:nowrap}td.c,th.c{text-align:center}
.resumen td{font-size:11pt;padding:5px 10px}.resumen tr.tot td{font-weight:bold;background:#EAF3DE}
.destacado{margin:10px 0;padding:10px 12px;border-left:4px solid #639922;background:#F4FAE6}
.gastos{font-size:8.6pt;table-layout:fixed}.gastos td,.gastos th{padding:4px 5px;overflow-wrap:break-word}.gastos tr.mov td{background:#FAFCF6;vertical-align:middle}.gastos td.n{overflow-wrap:normal}.sub{font-size:8pt;color:#5a6a4a}
tr.det td{border-top:none;padding:0 6px 6px}table.items{font-size:8pt;table-layout:fixed}table.items td{border:none;border-bottom:1px dotted #d6dfcb;padding:2px 5px}
.falta{color:#B07010;font-style:italic}.indice{font-size:8.3pt}.pie{font-size:8pt;color:#777;margin-top:16px}
</style></head><body>
<div style="font-size:11pt;color:#5a6a4a">Finca El Retiro · Pradera, Valle del Cauca</div>
<h1>${TITULO}</h1>
<div style="margin:4px 0 14px">Brian Roberto Escobar Morales · C.C. 1.113.524.335 · ${movs.length ? `del ${fechaLarga(movs[0].fecha)} al ${fechaLarga(movs[movs.length - 1].fecha)}` : ''} · informe del ${fechaLarga(hoy)}</div>

<h2>1. Resumen</h2>
<table class="resumen">
  <tr class="tot"><td>${SOLO_COMPRAS ? 'Total comprado' : 'Total de plata que ha salido'}</td><td class="n">${plata(total)}</td></tr>
  <tr><td>Con soporte (factura o comprobante en los anexos)</td><td class="n">${plata(conSop)}</td></tr>
  <tr><td>Sin soporte</td><td class="n">${plata(total - conSop)}</td></tr>
</table>
<div class="destacado">${movs.length} gastos (las facturas con varios productos cuentan como uno) · ${movs.filter(m => m.anexos.length).length} con soporte · ${anexos.length} anexos.
  No incluye el préstamo del invernadero${pr ? ` (${esc(pr.nombre)})` : ''}, que tiene su propio informe${SOLO_COMPRAS ? '. Tampoco incluye jornales, transferencias por verificar, cuotas del crédito ni gastos de Lauro' : '; sí incluye el pago de sus cuotas'}.</div>

<h2>2. Por mes</h2>
<table class="chica"><tr><th>Mes</th><th class="n">Gastado</th><th class="n">Con soporte</th><th class="n">Sin soporte</th></tr>
${Object.entries(porMes).sort().map(e => filaTot(e, nombreMes(e[0]))).join('')}
<tr class="tot"><th>Total</th><th class="n">${plata(total)}</th><th class="n">${plata(conSop)}</th><th class="n">${plata(total - conSop)}</th></tr></table>

<h2>3. Por cuenta</h2>
<table class="chica"><tr><th>Cuenta</th><th class="n">Gastado</th><th class="n">Con soporte</th><th class="n">Sin soporte</th></tr>
${Object.entries(porCuenta).sort((a, b) => b[1].v - a[1].v).map(e => filaTot(e, e[0])).join('')}
<tr class="tot"><th>Total</th><th class="n">${plata(total)}</th><th class="n">${plata(conSop)}</th><th class="n">${plata(total - conSop)}</th></tr></table>
${SOLO_COMPRAS ? '' : '<div class="pie">«Por verificar» son transferencias a Andrés Felipe Escobar (Nequi 318 540 5823) para gastos de la finca, pendientes de detallar.</div>'}

<h2 style="break-before:page">4. Detalle de gastos (en orden de fecha)</h2>
<table class="gastos"><colgroup><col style="width:5%"><col style="width:11%"><col style="width:16%"><col style="width:35%"><col style="width:14%"><col style="width:11%"><col style="width:8%"></colgroup>
<tr><th class="c">#</th><th class="c">Fecha</th><th>Proveedor</th><th>Concepto</th><th>Cuenta</th><th class="n">Valor</th><th class="c">Anexo</th></tr>
${filas}
<tr><th colspan="5">Total</th><th class="n">${plata(total)}</th><th></th></tr></table>

${anexos.length ? `<h2 style="break-before:page">Índice de anexos</h2><table class="indice"><colgroup><col style="width:8%"><col style="width:52%"><col style="width:40%"></colgroup><tr><th>Anexo</th><th>Documento</th><th>Corresponde a</th></tr>
${anexos.map(a => `<tr><td class="c">${a.n}</td><td>${esc(a.s.descripcion || a.s.nombre)}</td><td>${fecha(a.mov.fecha)} · ${esc(a.mov.proveedor.split(' · ')[0])} · ${plata(a.mov.valor)}</td></tr>`).join('')}</table>
<div class="pie">Los anexos van a continuación, en este mismo orden.</div>` : ''}
<div class="pie">Valores en pesos colombianos con IVA incluido (valor neto pagado).</div>
</body></html>`;

/* Recorta el blanco de cada página de soporte; si queda una tirilla muy larga la parte en tramos (máx. 4) */
const PY_TIRAS = `
import sys, json, math
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
caja = im.convert('L').point(lambda v: 255 if v < 245 else 0).getbbox()
if caja: im = im.crop((max(0, caja[0]-12), max(0, caja[1]-12), min(im.width, caja[2]+12), min(im.height, caja[3]+12)))
n = min(4, math.ceil(im.height / im.width / 2.6)) if im.height / im.width > 2.9 else 1
alto = math.ceil(im.height / n); sal = []
for k in range(n):
    f = f'{sys.argv[2]}{k}.jpg'; im.crop((0, k*alto, im.width, min(im.height, (k+1)*alto))).save(f, quality=82); sal.append(f)
print(json.dumps(sal))
`;
/* ── PDF: informe + anexos (cada anexo con una franja que dice su número) ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finca-'));
const navegador = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage();
const pie = t => `<div style="font-size:7pt;color:#888;width:100%;text-align:center;font-family:Arial">${t} · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`;
await pag.setContent(html, { waitUntil: 'networkidle' });
const partes = [path.join(tmp, '000-informe.pdf')];
await pag.pdf({ path: partes[0], format: 'Letter', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: pie(`${TITULO} · Finca El Retiro`) });
for (const a of anexos) {
  const r = await fetch(a.s.url); if (!r.ok) { console.warn(`No se pudo bajar el anexo ${a.n}: ${a.s.url}`); continue; }
  const buf = Buffer.from(await r.arrayBuffer()), base = path.join(tmp, `a${String(a.n).padStart(3, '0')}`);
  let imgs = [];
  if (a.s.tipo === 'application/pdf') {
    fs.writeFileSync(base + '.pdf', buf);
    execFileSync('pdftoppm', ['-r', '110', '-jpeg', base + '.pdf', base]);
    imgs = fs.readdirSync(tmp).filter(f => f.startsWith(path.basename(base) + '-') && f.endsWith('.jpg')).sort().map(f => path.join(tmp, f));
  } else { fs.writeFileSync(base + '.img', buf); imgs = [base + '.img']; }
  const cab = `<div style="font:8.5pt Arial;background:#EAF3DE;border-left:3px solid #639922;padding:3px 6px;margin-bottom:3mm"><b>Anexo ${a.n}</b> · ${esc(a.s.descripcion || a.s.nombre)}<br><span style="color:#5a6a4a">${fecha(a.mov.fecha)} · ${esc(a.mov.proveedor.split(' · ')[0])} · ${plata(a.mov.valor)}</span></div>`;
  const img64 = f => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
  const cuerpo = imgs.map((f, k) => {
    const pz = JSON.parse(execFileSync('python3', ['-c', PY_TIRAS, f, `${f}_t`]).toString());
    const ver = pz.length > 1   // tirilla larga: los tramos van en columnas, uno al lado del otro
      ? `<div style="display:grid;grid-template-columns:repeat(${pz.length},1fr);gap:4mm;align-items:start">${pz.map(x => `<img style="width:100%;border:1px solid #ccc" src="${img64(x)}">`).join('')}</div>`
      : `<img style="max-width:100%;max-height:225mm;border:1px solid #ccc" src="${img64(pz[0])}">`;
    return `<div style="${k ? 'break-before:page;' : ''}text-align:center">${cab.replace('</b>', imgs.length > 1 ? ` (página ${k + 1} de ${imgs.length})</b>` : '</b>')}${ver}</div>`;
  }).join('');
  await pag.setContent(`<!doctype html><html><body style="margin:0">${cuerpo}</body></html>`, { waitUntil: 'load' });
  const sal = base + '-anexo.pdf';
  await pag.pdf({ path: sal, format: 'Letter', margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  partes.push(sal);
}
await navegador.close();
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
if (partes.length > 1) execFileSync('pdfunite', [...partes, SALIDA]); else fs.copyFileSync(partes[0], SALIDA);
console.log(`Informe listo: ${SALIDA}\n${movs.length} gastos · ${anexos.length} anexos · total ${plata(total)} · con soporte ${plata(conSop)}`);
