/*
 * Informe de inversión del préstamo del invernadero (PDF para el Banco Agrario).
 *
 * Toma los gastos, jornales y soportes del préstamo directamente de Supabase,
 * arma el informe en orden de fechas y le pega al final los soportes como anexos
 * (facturas en PDF y fotos de comprobantes), numerados igual que la tabla.
 *
 * Uso:   node informes/generar_informe.mjs [salida.pdf]
 * Textos editables: informes/prestamo_invernadero.json
 * Necesita: Playwright (Chromium) y pdfunite (poppler-utils).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(AQUI, 'prestamo_invernadero.json'), 'utf8'));
const SALIDA = path.resolve(process.argv[2] || path.join(AQUI, 'salida', `Informe_prestamo_invernadero_${new Date().toISOString().slice(0, 10)}.pdf`));
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
async function api(tabla, filtro) {
  const r = await fetch(`${SUPA}/rest/v1/${tabla}?${filtro}`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`${tabla}: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ── datos ── */
const P = CFG.proyecto_id;
const [[pr], compras, jornales, soportes] = await Promise.all([
  api('proyectos', `id=eq.${P}`), api('compras', `proyecto_id=eq.${P}`), api('jornales', `proyecto_id=eq.${P}`), api('soportes', `proyecto_id=eq.${P}`)
]);
const esCultivo = c => (CFG.cultivo?.rubros || []).includes(c.rubro) || (CFG.cultivo?.incluir_consumos_de_bodega && c.origen === 'consumo');
const movs = [
  ...compras.map(c => ({ tipo: 'gasto', id: c.id, fecha: c.fecha_compra, concepto: c.concepto, proveedor: c.proveedor || '', rubro: c.rubro || 'Otros', valor: num(c.valor_total),
    items: Array.isArray(c.items) ? c.items : [], factura: c.numero_factura, cultivo: esCultivo(c), soportes: soportes.filter(s => s.compra_id === c.id) })),
  ...jornales.map(j => ({ tipo: 'jornal', id: j.id, fecha: j.fecha, concepto: `Jornal: ${j.trabajador} · ${num(j.dias)} día(s)${j.nota ? ' · ' + j.nota : ''}`, proveedor: j.trabajador,
    rubro: 'Mano de obra', valor: num(j.valor_total), items: [], cultivo: false, soportes: soportes.filter(s => s.jornal_id === j.id) }))
].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
const obra = movs.filter(m => !m.cultivo), cultivo = movs.filter(m => m.cultivo);
const suma = l => l.reduce((a, m) => a + m.valor, 0);
const totalObra = suma(obra), totalCultivo = suma(cultivo), total = totalObra + totalCultivo;
const monto = num(pr.monto), desembolsado = num(pr.desembolsado) || monto, descuento = monto - desembolsado, propios = total - desembolsado;
const rubros = {};
obra.forEach(m => (m.items.length ? m.items.map(x => [x.r || m.rubro, num(x.v)]) : [[m.rubro, m.valor]]).forEach(([r, v]) => rubros[r] = (rubros[r] || 0) + v));
const rubrosOrden = Object.entries(rubros).sort((a, b) => b[1] - a[1]);

/* Anexos numerados en el orden de la tabla */
const anexos = [];
movs.forEach(m => m.soportes.forEach(s => { s.n = anexos.length + 1; anexos.push(Object.assign(s, { mov: m })); }));
const generales = soportes.filter(s => !s.compra_id && !s.jornal_id);
generales.forEach(s => { s.n = anexos.length + 1; anexos.push(Object.assign(s, { mov: null })); });

/* Forma de pago leída del texto del gasto */
const formaPago = m => {
  const t = `${m.proveedor} ${m.concepto} ${m.items.map(x => x.d).join(' ')}`.toLowerCase();
  if (/efectivo/.test(t) && /transfer/.test(t)) return 'Transferencia y efectivo';
  if (/efectivo/.test(t)) return 'Efectivo';
  if (/nequi/.test(t)) return 'Nequi';
  if (/transfer|débito|debito/.test(t)) return 'Transferencia';
  if (/tarjeta|falabella/.test(t)) return 'Tarjeta';
  return m.tipo === 'jornal' ? 'Efectivo' : '—';
};
const celdaSoporte = m => m.soportes.length ? m.soportes.map(s => s.n).sort((x, y) => x - y).join(', ') : '<span class="falta">Sin soporte</span>';

const filas = (lista, desde) => lista.map((m, i) => `
  <tr class="mov"><td class="c">${desde + i}</td><td class="nw">${fecha(m.fecha)}</td><td>${esc(m.proveedor.split(' · ')[0])}</td><td><b>${esc(m.concepto)}</b>${m.factura ? `<div class="sub">Factura ${esc(m.factura)}</div>` : ''}</td>
    <td>${esc(m.rubro)}</td><td>${formaPago(m)}</td><td class="n"><b>${plata(m.valor)}</b></td><td>${celdaSoporte(m)}</td></tr>
  ${m.items.length > 1 || (m.items.length === 1 && m.items[0].c > 1) ? `<tr class="det"><td></td><td colspan="7"><table class="items">${m.items.map(x => `<tr><td class="n w1">${num(x.c).toLocaleString('es-CO')}</td><td>${esc(x.d)}</td><td class="n w2">${num(x.c) > 1 ? plata(num(x.v) / num(x.c)) + ' c/u' : ''}</td><td class="n w2">${plata(num(x.v))}</td></tr>`).join('')}</table></td></tr>` : ''}`).join('');

const hoy = new Date().toISOString().slice(0, 10);
const fotosObra = (CFG.fotos_obra || []).filter(f => f.archivo);
/* Achica una imagen a JPEG para que el PDF no pese tanto (usa Python + Pillow si está; si no, deja la original) */
function achicar(buf, max = 1400) {
  try {
    const ent = path.join(os.tmpdir(), `img-${Math.random().toString(36).slice(2)}`), sal = ent + '.jpg';
    fs.writeFileSync(ent, buf);
    execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.thumbnail((int(sys.argv[3]),)*2);im.convert("RGB").save(sys.argv[2],quality=78,optimize=True)', ent, sal, String(max)]);
    return { buf: fs.readFileSync(sal), tipo: 'image/jpeg' };
  } catch { return { buf, tipo: null }; }
}
/* Las fotos se incrustan en el PDF (el navegador del generador no siempre tiene acceso directo a la red) */
const _fotos = {};
for (const a of [CFG.foto_portada, ...fotosObra.map(f => f.archivo)].filter(Boolean)) {
  if (_fotos[a]) continue;
  const buf = /^https?:/.test(a) ? Buffer.from(await (await fetch(a)).arrayBuffer()) : fs.readFileSync(path.resolve(AQUI, a));
  const ch = achicar(buf, 1600);
  _fotos[a] = `data:${ch.tipo || (/\.png$/i.test(a) ? 'image/png' : 'image/jpeg')};base64,${ch.buf.toString('base64')}`;
}
const fotoSrc = a => _fotos[a] || a;

const construirHtml = () => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(CFG.titulo)}</title><style>
@page{size:Letter;margin:16mm 14mm 18mm}
body{font-family:Arial,Helvetica,sans-serif;color:#1a1f14;font-size:10.5pt;line-height:1.4}
h1{font-size:22pt;margin:0;color:#2A4F08}h2{font-size:13pt;color:#2A4F08;border-bottom:2px solid #639922;padding-bottom:3px;margin:22px 0 8px;break-after:avoid}
.portada{height:235mm;display:flex;flex-direction:column;justify-content:center;break-after:page}
.portada .sub1{font-size:15pt;margin:6px 0 30px;color:#3B6D11}.portada table{width:auto;font-size:11pt}.portada td{border:none;padding:4px 18px 4px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9d4bb;padding:4px 6px;vertical-align:top;text-align:left}th{background:#EAF3DE;font-size:9.5pt}
td.n,th.n{text-align:right;white-space:nowrap}td.c{text-align:center}.nw{white-space:nowrap}
.resumen td{font-size:11pt;padding:7px 10px}.resumen tr.tot td{font-weight:bold;background:#EAF3DE}
.destacado{margin:10px 0;padding:10px 12px;border-left:4px solid #639922;background:#F4FAE6;font-size:10.5pt}
.barra{height:10px;background:#639922;border-radius:2px}
.gastos{font-size:9pt;table-layout:fixed}.gastos td{overflow-wrap:anywhere}.gastos tr.mov td{background:#FAFCF6}.sub{font-size:8pt;color:#5a6a4a}
tr.det td{border-top:none;padding:0 6px 6px}table.items{font-size:8.5pt}table.items td{border:none;border-bottom:1px dotted #d6dfcb;padding:2px 4px}.w1{width:40px}.w2{width:90px}
.falta{color:#B07010;font-style:italic}.indice{font-size:8pt}.indice td,.indice th{padding:2px 5px}.indice td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fotos{display:flex;flex-wrap:wrap;justify-content:space-between;row-gap:12px}.fotos figure{margin:0;width:49%;break-inside:avoid;page-break-inside:avoid}.fotos img{width:100%;height:61mm;object-fit:cover;border:1px solid #ccc;border-radius:3px}.fotos figcaption{font-size:8.5pt;color:#444;margin-top:3px}
.firma{margin-top:60px;width:70mm;border-top:1px solid #111;padding-top:5px}
.pie{font-size:8pt;color:#777;margin-top:16px}
</style></head><body>

<section class="portada">
  <div style="font-size:11pt;color:#5a6a4a">${esc(CFG.finca)}</div>
  ${CFG.foto_portada ? `<img src="${esc(fotoSrc(CFG.foto_portada))}" style="width:100%;height:95mm;object-fit:cover;border-radius:4px;margin:10px 0 18px">` : ''}
  <h1>${esc(CFG.titulo)}</h1>
  <div class="sub1">${esc(CFG.subtitulo)}</div>
  <table>
    <tr><td>Titular</td><td><b>${esc(CFG.titular.nombre)}</b> · C.C. ${esc(CFG.titular.cedula)}</td></tr>
    <tr><td>Entidad</td><td>${esc(CFG.credito.oficina)}</td></tr>
    <tr><td>Crédito</td><td>${esc(CFG.credito.numero)} · ${esc(CFG.credito.linea)}</td></tr>
    <tr><td>Condiciones</td><td>${esc(CFG.credito.plazo)} · ${esc(CFG.credito.tasa)}</td></tr>
    <tr><td>Desembolso</td><td>${pr.fecha_desembolso ? fechaLarga(pr.fecha_desembolso) : '—'}</td></tr>
    ${CFG.mostrar_fecha_informe ? `<tr><td>Fecha del informe</td><td>${fechaLarga(hoy)}</td></tr>` : ''}
  </table>
</section>

<h2>1. Resumen del préstamo</h2>
<table class="resumen">
  <tr><td>Monto aprobado</td><td class="n">${plata(monto)}</td></tr>
  ${descuento > 0 ? `<tr><td>Descontado por el banco (seguro y comisiones)</td><td class="n">− ${plata(descuento)}</td></tr>` : ''}
  <tr class="tot"><td>Desembolsado a la cuenta</td><td class="n">${plata(desembolsado)}</td></tr>
  <tr><td>Invertido en la construcción del invernadero</td><td class="n">${plata(totalObra)}</td></tr>
  ${totalCultivo ? `<tr><td>${esc(CFG.cultivo.titulo)}</td><td class="n">${plata(totalCultivo)}</td></tr>` : ''}
  <tr class="tot"><td>Total invertido a la fecha</td><td class="n">${plata(total)}</td></tr>
  ${CFG.mostrar_recursos_propios && propios > 0 ? `<tr><td>Aportado con recursos propios</td><td class="n">${plata(propios)}</td></tr>` : ''}
  ${propios < 0 ? `<tr><td>Saldo del desembolso por invertir</td><td class="n">${plata(-propios)}</td></tr>` : ''}
</table>
<div class="destacado">${propios >= 0
  ? `Se invirtió el <b>100 % del dinero desembolsado</b>${CFG.mostrar_recursos_propios && propios > 0 ? ` y además <b>${plata(propios)}</b> de recursos propios` : ''}.`
  : `Se ha invertido el <b>${Math.round(total / desembolsado * 1000) / 10} %</b> del dinero desembolsado.`}
  ${movs.length} gastos registrados · ${movs.filter(m => m.soportes.length).length} con soporte documental (facturas, comprobantes y transferencias en los anexos).</div>

<h2>2. Inversión por rubro (construcción)</h2>
<table><tr><th>Rubro</th><th class="n">Valor</th><th class="n">%</th><th style="width:40%"></th></tr>
${rubrosOrden.map(([r, v]) => `<tr><td>${esc(r)}</td><td class="n">${plata(v)}</td><td class="n">${(Math.round(v / totalObra * 1000) / 10).toLocaleString('es-CO')} %</td><td><div class="barra" style="width:${Math.max(1, v / rubrosOrden[0][1] * 100)}%"></div></td></tr>`).join('')}
<tr><th>Total construcción</th><th class="n">${plata(totalObra)}</th><th class="n">100 %</th><th></th></tr></table>

<h2>3. Descripción de la obra</h2>
${(CFG.descripcion_obra || []).map(p => `<p>${esc(p)}</p>`).join('')}
${CFG.nota_reparacion ? `<div class="destacado">${esc(CFG.nota_reparacion)}</div>` : ''}

<h2>4. Detalle de gastos de la construcción (en orden de fecha)</h2>
<table class="gastos"><colgroup><col style="width:4%"><col style="width:9%"><col style="width:14%"><col style="width:36%"><col style="width:10%"><col style="width:9%"><col style="width:10%"><col style="width:8%"></colgroup><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Concepto</th><th>Rubro</th><th>Pago</th><th class="n">Valor</th><th>Anexo</th></tr>
${filas(obra, 1)}
<tr><th colspan="6">Total construcción</th><th class="n">${plata(totalObra)}</th><th></th></tr></table>

${cultivo.length ? `<h2>5. ${esc(CFG.cultivo.titulo)}</h2>
<table class="gastos"><colgroup><col style="width:4%"><col style="width:9%"><col style="width:14%"><col style="width:36%"><col style="width:10%"><col style="width:9%"><col style="width:10%"><col style="width:8%"></colgroup><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Concepto</th><th>Rubro</th><th>Pago</th><th class="n">Valor</th><th>Anexo</th></tr>
${filas(cultivo, obra.length + 1)}
<tr><th colspan="6">Total</th><th class="n">${plata(totalCultivo)}</th><th></th></tr></table>` : ''}

${fotosObra.length ? `<h2>${cultivo.length ? 6 : 5}. Registro fotográfico de la obra</h2>
<div class="fotos">${fotosObra.map(f => `<figure><img src="${esc(fotoSrc(f.archivo))}"><figcaption>${esc(f.titulo)}</figcaption></figure>`).join('')}</div>` : ''}

${anexos.length ? `<h2 style="break-before:page">Índice de anexos</h2><table class="gastos indice"><colgroup><col style="width:7%"><col style="width:45%"><col style="width:48%"></colgroup><tr><th>Anexo</th><th>Documento</th><th>Corresponde a</th></tr>
${anexos.map(a => `<tr><td class="c">${a.n}</td><td>${esc(a.descripcion || a.nombre)}</td><td>${a.mov ? `${fecha(a.mov.fecha)} · ${esc((a.mov.concepto.length > 58 ? a.mov.concepto.slice(0, 56) + '…' : a.mov.concepto))}` : 'Documentos del préstamo'}</td></tr>`).join('')}</table>` : ''}

${CFG.firma ? `<div class="firma" style="margin-top:40px"><b>${esc(CFG.titular.nombre)}</b><br>C.C. ${esc(CFG.titular.cedula)}</div>` : ''}
<div class="pie">Valores en pesos colombianos con IVA incluido (valor neto pagado).</div>
</body></html>`;

/* ── Anexos: todo se vuelve imagen y se acomoda en hojas carta ──
   · Página de factura o foto normal → ancho completo.
   · Foto alta de celular (comprobantes) → tres por fila, dos filas por hoja.
   · Tirilla muy larga → se corta en tramos que van en columnas, uno al lado del otro. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'informe-'));
const PY_PIEZAS = `
import sys, json, math
from PIL import Image
src, pref = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
# recorta márgenes blancos (facturas en PDF y tirillas)
gris = im.convert('L').point(lambda v: 255 if v < 245 else 0)
caja = gris.getbbox()
if caja:
    m = 12
    im = im.crop((max(0, caja[0]-m), max(0, caja[1]-m), min(im.width, caja[2]+m), min(im.height, caja[3]+m)))
if im.width > 1500:
    im = im.resize((1500, round(im.height * 1500 / im.width)))
a = im.height / im.width
piezas = []
if a > 2.7:                                   # tirilla: tramos de proporción ~2,3
    n = math.ceil(a / 2.3); alto = math.ceil(im.height / n)
    for k in range(n):
        p = im.crop((0, k*alto, im.width, min(im.height, (k+1)*alto)))
        f = f'{pref}_{k}.jpg'; p.save(f, quality=80, optimize=True); piezas.append(f)
else:
    f = f'{pref}_0.jpg'; im.save(f, quality=80, optimize=True); piezas.append(f)
print(json.dumps({'a': a, 'piezas': piezas}))
`;
fs.writeFileSync(path.join(tmp, 'piezas.py'), PY_PIEZAS);
const piezas = (archivo, pref) => JSON.parse(execFileSync('python3', [path.join(tmp, 'piezas.py'), archivo, pref]).toString());
const dataJpg = f => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
const cabAnexo = (a, extra = '') => `<div class="acab"><b>Anexo ${a.n}</b>${extra} · ${esc(a.descripcion || a.nombre)}${a.mov ? `<span>${fecha(a.mov.fecha)} · ${esc(a.mov.concepto.slice(0, 90))} · ${plata(a.mov.valor)}</span>` : ''}</div>`;
const tarjetas = [];
for (const a of anexos) {
  const r = await fetch(a.url); if (!r.ok) { console.warn(`No se pudo bajar el anexo ${a.n}: ${a.url}`); continue; }
  const buf = Buffer.from(await r.arrayBuffer()), base = path.join(tmp, `a${String(a.n).padStart(3, '0')}`);
  let paginas = [];
  if (a.tipo === 'application/pdf') {
    fs.writeFileSync(base + '.pdf', buf);
    execFileSync('pdftoppm', ['-r', '130', '-png', base + '.pdf', base]);
    paginas = fs.readdirSync(tmp).filter(f => f.startsWith(path.basename(base) + '-') && f.endsWith('.png')).sort().map(f => path.join(tmp, f));
  } else { fs.writeFileSync(base + '.img', buf); paginas = [base + '.img']; }
  paginas.forEach((pg, k) => {
    const { a: prop, piezas: pz } = piezas(pg, `${base}_p${k}`);
    const extra = paginas.length > 1 ? ` (página ${k + 1} de ${paginas.length})` : '';
    if (pz.length > 1) tarjetas.push({ tipo: 'tiras', a, extra, src: pz.map(dataJpg), prop });
    else if (prop > 1.45) tarjetas.push({ tipo: 'media', a, extra, src: [dataJpg(pz[0])], prop });
    else tarjetas.push({ tipo: 'hoja', a, extra, src: [dataJpg(pz[0])], prop });
  });
}
/* Acomodo de las hojas: se simula la página carta (en mm) para no dejar hojas casi vacías.
   Si una factura no cabe en lo que queda de la hoja pero cabe reducida a un tamaño legible, se reduce. */
const ALTO_UTIL = 236, ANCHO = 186, CAB = 13, SEP = 6, ALTO_MEDIA = 118;
const filas2 = [], pend = [...tarjetas];
while (pend.length) {
  const t = pend.shift();
  if (t.tipo === 'media') {                       // hasta tres comprobantes por fila (mira hasta 4 anexos adelante)
    const fila = [t];
    for (let k = 0; k < pend.length && k < 4 && fila.length < 3; k++) if (pend[k].tipo === 'media') { fila.push(pend.splice(k, 1)[0]); k--; }
    filas2.push({ tipo: 'media', items: fila, alto: ALTO_MEDIA + CAB + 4 });
  } else if (t.tipo === 'tiras') filas2.push({ tipo: 'tiras', items: [t], alto: 205 + CAB });
  else filas2.push({ tipo: 'hoja', items: [t], alto: Math.min(ANCHO * t.prop, 222) + CAB });
}
/* Los anexos se numeran en el orden en que quedan impresos (la tabla y el índice usan esos números) */
{ let n = 0; const vistos = new Set();
  for (const f of filas2) for (const t of f.items) if (!vistos.has(t.a)) { vistos.add(t.a); t.a.n = ++n; }
  anexos.filter(a => !vistos.has(a)).forEach(a => a.n = ++n);
  anexos.sort((x, y) => x.n - y.n); }
let libre = ALTO_UTIL - 12;                        // la primera hoja lleva el título «Anexos»
for (const f of filas2) {
  if (f.alto + SEP <= libre) { f.salto = false; libre -= f.alto + SEP; continue; }
  const img = f.alto - CAB, cabe = libre - SEP - CAB;
  if (f.tipo !== 'media' && cabe >= Math.max(95, img * 0.62)) { f.alto = cabe + CAB; f.salto = false; libre = 0; continue; }
  f.salto = true; libre = ALTO_UTIL - f.alto - SEP;
}
const htmlTarjeta = (t, altoImg) => {
  const cab = cabAnexo(t.a, t.extra);
  if (t.tipo === 'media') return `<div class="tarj media">${cab}<img class="alta" src="${t.src[0]}"></div>`;
  if (t.tipo === 'tiras') return `<div class="tarj completa">${cab}<div class="tiras" style="grid-template-columns:repeat(${Math.min(t.src.length, 3)},1fr)">${t.src.map(x => `<img src="${x}">`).join('')}</div></div>`;
  return `<div class="tarj completa">${cab}<img class="hoja" style="max-height:${Math.floor(altoImg)}mm" src="${t.src[0]}"></div>`;
};
const htmlAnexos = filas2.map(f => (f.salto ? '<div class="salto"></div>' : '') + f.items.map(t => htmlTarjeta(t, f.alto - CAB)).join('')).join('');
const cssAnexos = `<style>
.anexos{break-before:page;display:flex;flex-wrap:wrap;justify-content:flex-start;align-content:flex-start;gap:6mm 2.75%}
.anexos h2{width:100%;margin-top:0}.salto{width:100%;height:0;break-before:page;page-break-before:always}
.tarj{break-inside:avoid;page-break-inside:avoid;text-align:center}.tarj.completa{width:100%}.tarj.media{width:31.5%}
.acab{text-align:left;font-size:8.5pt;color:#333;background:#EAF3DE;border-left:3px solid #639922;padding:3px 6px;margin-bottom:3mm}.acab span{display:block;color:#5a6a4a;font-size:8pt}
.tarj img{border:1px solid #ccc;object-fit:contain}.tarj img.hoja{max-width:100%}.tarj img.alta{width:auto;max-width:100%;max-height:118mm}
.tiras{display:grid;gap:4mm;align-items:start}.tiras img{width:100%;max-height:205mm}
</style>`;
const html = construirHtml();
const htmlFinal = html.replace('</body></html>', `${cssAnexos}${tarjetas.length ? `<section class="anexos"><h2>Anexos: soportes</h2>${htmlAnexos}</section>` : ''}</body></html>`);
const navegador = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage();
await pag.setContent(htmlFinal, { waitUntil: 'networkidle' });
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
await pag.pdf({ path: SALIDA, format: 'Letter', printBackground: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: `<div style="font-size:7pt;color:#888;width:100%;text-align:center;font-family:Arial">${esc(CFG.subtitulo)} · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>` });
await navegador.close();
console.log(`Informe listo: ${SALIDA}\n${movs.length} gastos · ${anexos.length} anexos · construcción ${plata(totalObra)} · total ${plata(total)}`);
