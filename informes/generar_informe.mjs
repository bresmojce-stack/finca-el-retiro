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
import { armarAnexos } from './anexos.mjs';
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
const [[pr], compras, jornales, soportes, cuotas] = await Promise.all([
  api('proyectos', `id=eq.${P}`), api('compras', `proyecto_id=eq.${P}`), api('jornales', `proyecto_id=eq.${P}`), api('soportes', `proyecto_id=eq.${P}`),
  /* Cuotas pagadas al banco: se anotan en la finca con la cuenta «Pago crédito» */
  api('compras', `categoria=eq.${encodeURIComponent('Pago crédito')}&order=fecha_compra`)
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
  if (/tarjeta|falabella/.test(t)) return 'Tarjeta';
  if (/transfer|débito|debito/.test(t)) return 'Transferencia';
  return m.tipo === 'jornal' ? 'Efectivo' : '—';
};
const celdaSoporte = m => m.soportes.length ? m.soportes.map(s => s.n).sort((x, y) => x - y).join(', ') : '<span class="falta">Sin soporte</span>';

const filas = (lista, desde) => lista.map((m, i) => `
  <tr class="mov"><td class="c">${desde + i}</td><td class="c">${fecha(m.fecha)}</td><td>${esc(m.proveedor.split(' · ')[0])}</td><td><b>${esc(m.concepto)}</b>${m.factura ? `<div class="sub">Factura ${esc(m.factura)}</div>` : ''}</td>
    <td class="c">${formaPago(m)}</td><td class="n"><b>${plata(m.valor)}</b></td><td class="c">${celdaSoporte(m)}</td></tr>
  ${m.items.length > 1 || (m.items.length === 1 && m.items[0].c > 1) ? `<tr class="det"><td></td><td colspan="6"><table class="items"><colgroup><col style="width:9%"><col><col style="width:20%"><col style="width:17%"></colgroup>${m.items.map(x => `<tr><td class="n">${num(x.c).toLocaleString('es-CO')}</td><td>${esc(x.d)}</td><td class="n">${num(x.c) > 1 ? plata(num(x.v) / num(x.c)) + ' c/u' : ''}</td><td class="n">${plata(num(x.v))}</td></tr>`).join('')}</table></td></tr>` : ''}`).join('');

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
td.n,th.n{text-align:right;white-space:nowrap}td.c,th.c{text-align:center}.nw{white-space:nowrap}
.resumen td{font-size:11pt;padding:7px 10px}.resumen tr.tot td{font-weight:bold;background:#EAF3DE}
.destacado{margin:10px 0;padding:10px 12px;border-left:4px solid #639922;background:#F4FAE6;font-size:10.5pt}
.barra{height:10px;background:#639922;border-radius:2px}
.gastos{font-size:8.8pt;table-layout:fixed}.gastos td,.gastos th{padding:4px 5px;overflow-wrap:break-word}.gastos tr.mov td{vertical-align:middle}.gastos td.n{overflow-wrap:normal}.gastos tr.mov td{background:#FAFCF6}.sub{font-size:8pt;color:#5a6a4a}
tr.det td{border-top:none;padding:0 6px 6px}table.items{font-size:8.3pt;table-layout:fixed}table.items td{border:none;border-bottom:1px dotted #d6dfcb;padding:2px 5px;vertical-align:top}
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

${cuotas.length ? `<h3 style="font-size:11pt;color:#2A4F08;margin:16px 0 6px">Pagos al banco</h3>
<table class="resumen"><tr><th>Cuota</th><th>Fecha de pago</th><th class="n">Valor pagado</th></tr>
${cuotas.map((c, i) => `<tr><td>Cuota ${i + 1}${CFG.credito.cuotas ? ' de ' + CFG.credito.cuotas : ''}</td><td>${fechaLarga(c.fecha_compra)}</td><td class="n">${plata(num(c.valor_total))}</td></tr>`).join('')}
${CFG.credito.cuotas ? `<tr class="tot"><td colspan="2">Cuotas pagadas: ${cuotas.length} · faltan ${CFG.credito.cuotas - cuotas.length}</td><td class="n">${plata(suma(cuotas.map(c => ({ valor: num(c.valor_total) }))))}</td></tr>` : ''}</table>` : ''}

<h2>2. Descripción de la obra</h2>
${(CFG.descripcion_obra || []).map(p => `<p>${esc(p)}</p>`).join('')}
${CFG.nota_reparacion ? `<div class="destacado">${esc(CFG.nota_reparacion)}</div>` : ''}

<h2>3. Detalle de gastos de la construcción (en orden de fecha)</h2>
<table class="gastos"><colgroup><col style="width:5%"><col style="width:12%"><col style="width:16%"><col style="width:32%"><col style="width:13%"><col style="width:13%"><col style="width:9%"></colgroup><tr><th class="c">#</th><th class="c">Fecha</th><th>Proveedor</th><th>Concepto</th><th class="c">Pago</th><th class="n">Valor</th><th class="c">Anexo</th></tr>
${filas(obra, 1)}
<tr><th colspan="5">Total construcción</th><th class="n">${plata(totalObra)}</th><th></th></tr></table>

${cultivo.length ? `<h2>4. ${esc(CFG.cultivo.titulo)}</h2>
<table class="gastos"><colgroup><col style="width:5%"><col style="width:12%"><col style="width:16%"><col style="width:32%"><col style="width:13%"><col style="width:13%"><col style="width:9%"></colgroup><tr><th class="c">#</th><th class="c">Fecha</th><th>Proveedor</th><th>Concepto</th><th class="c">Pago</th><th class="n">Valor</th><th class="c">Anexo</th></tr>
${filas(cultivo, obra.length + 1)}
<tr><th colspan="5">Total</th><th class="n">${plata(totalCultivo)}</th><th></th></tr></table>` : ''}

${fotosObra.length ? `<h2>${cultivo.length ? 5 : 4}. Registro fotográfico de la obra</h2>
<div class="fotos">${fotosObra.map(f => `<figure><img src="${esc(fotoSrc(f.archivo))}"><figcaption>${esc(f.titulo)}</figcaption></figure>`).join('')}</div>` : ''}

${anexos.length ? `<h2>Índice de anexos</h2><table class="gastos indice"><colgroup><col style="width:7%"><col style="width:45%"><col style="width:48%"></colgroup><tr><th>Anexo</th><th>Documento</th><th>Corresponde a</th></tr>
${anexos.map(a => `<tr><td class="c">${a.n}</td><td>${esc(a.descripcion || a.nombre)}</td><td>${a.mov ? `${fecha(a.mov.fecha)} · ${esc((a.mov.concepto.length > 58 ? a.mov.concepto.slice(0, 56) + '…' : a.mov.concepto))}` : 'Documentos del préstamo'}</td></tr>`).join('')}</table>` : ''}

${CFG.firma ? `<div class="firma" style="margin-top:40px"><b>${esc(CFG.titular.nombre)}</b><br>C.C. ${esc(CFG.titular.cedula)}</div>` : ''}
<div class="pie">Valores en pesos colombianos con IVA incluido (valor neto pagado).</div>
</body></html>`;

/* ── Anexos: hojas carta llenas, sin hojas en blanco (ver informes/anexos.mjs) ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'informe-'));
anexos.forEach(a => { delete a.n; a.titulo = a.descripcion || a.nombre;
  a.linea = a.mov ? `${fecha(a.mov.fecha)} · ${a.mov.concepto.slice(0, 90)} · ${plata(a.mov.valor)}` : 'Documentos del préstamo'; });
const AX = await armarAnexos(anexos, { tmp, esc });
anexos.sort((x, y) => x.n - y.n);
const html = construirHtml();
const htmlFinal = html.replace('</body></html>', `${AX.css}${AX.html}</body></html>`);
const navegador = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage();
await pag.setContent(htmlFinal, { waitUntil: 'networkidle' });
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
await pag.pdf({ path: SALIDA, format: 'Letter', printBackground: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: `<div style="font-size:7pt;color:#888;width:100%;text-align:center;font-family:Arial">${esc(CFG.subtitulo)} · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>` });
await navegador.close();
console.log(`Informe listo: ${SALIDA}\n${movs.length} gastos · ${anexos.length} anexos · construcción ${plata(totalObra)} · total ${plata(total)}`);
