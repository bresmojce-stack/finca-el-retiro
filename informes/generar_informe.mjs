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
movs.forEach(m => m.soportes.forEach(s => { s.n = anexos.length + 1; anexos.push({ ...s, mov: m }); }));
const generales = soportes.filter(s => !s.compra_id && !s.jornal_id);
generales.forEach(s => { s.n = anexos.length + 1; anexos.push({ ...s, mov: null }); });

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
const celdaSoporte = m => m.soportes.length ? m.soportes.map(s => `Anexo ${s.n}`).join(', ') : '<span class="falta">Sin soporte</span>';

const filas = (lista, desde) => lista.map((m, i) => `
  <tr class="mov"><td class="c">${desde + i}</td><td class="nw">${fecha(m.fecha)}</td><td>${esc(m.proveedor.split(' · ')[0])}</td><td><b>${esc(m.concepto)}</b>${m.factura ? `<div class="sub">Factura ${esc(m.factura)}</div>` : ''}</td>
    <td>${esc(m.rubro)}</td><td>${formaPago(m)}</td><td class="n"><b>${plata(m.valor)}</b></td><td class="nw">${celdaSoporte(m)}</td></tr>
  ${m.items.length > 1 || (m.items.length === 1 && m.items[0].c > 1) ? `<tr class="det"><td></td><td colspan="7"><table class="items">${m.items.map(x => `<tr><td class="n w1">${num(x.c).toLocaleString('es-CO')}</td><td>${esc(x.d)}</td><td class="n w2">${num(x.c) > 1 ? plata(num(x.v) / num(x.c)) + ' c/u' : ''}</td><td class="n w2">${plata(num(x.v))}</td></tr>`).join('')}</table></td></tr>` : ''}`).join('');

const hoy = new Date().toISOString().slice(0, 10);
const fotosObra = (CFG.fotos_obra || []).filter(f => f.archivo);
const fotoSrc = a => /^https?:/.test(a) ? a : 'file://' + path.resolve(AQUI, a);

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(CFG.titulo)}</title><style>
@page{size:Letter;margin:16mm 14mm 18mm}
body{font-family:Arial,Helvetica,sans-serif;color:#1a1f14;font-size:10.5pt;line-height:1.4}
h1{font-size:22pt;margin:0;color:#2A4F08}h2{font-size:13pt;color:#2A4F08;border-bottom:2px solid #639922;padding-bottom:3px;margin:22px 0 8px;break-after:avoid}
.portada{height:230mm;display:flex;flex-direction:column;justify-content:center;break-after:page}
.portada .sub1{font-size:15pt;margin:6px 0 30px;color:#3B6D11}.portada table{width:auto;font-size:11pt}.portada td{border:none;padding:4px 18px 4px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9d4bb;padding:4px 6px;vertical-align:top;text-align:left}th{background:#EAF3DE;font-size:9.5pt}
td.n,th.n{text-align:right;white-space:nowrap}td.c{text-align:center}.nw{white-space:nowrap}
.resumen td{font-size:11pt;padding:7px 10px}.resumen tr.tot td{font-weight:bold;background:#EAF3DE}
.destacado{margin:10px 0;padding:10px 12px;border-left:4px solid #639922;background:#F4FAE6;font-size:10.5pt}
.barra{height:10px;background:#639922;border-radius:2px}
.gastos{font-size:9pt;table-layout:fixed}.gastos td{overflow-wrap:anywhere}.gastos tr.mov td{background:#FAFCF6}.sub{font-size:8pt;color:#5a6a4a}
tr.det td{border-top:none;padding:0 6px 6px}table.items{font-size:8.5pt}table.items td{border:none;border-bottom:1px dotted #d6dfcb;padding:2px 4px}.w1{width:40px}.w2{width:90px}
.falta{color:#B07010;font-style:italic}
.fotos{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fotos figure{margin:0;break-inside:avoid}.fotos img{width:100%;height:68mm;object-fit:cover;border:1px solid #ccc}.fotos figcaption{font-size:8.5pt;color:#555}
.firma{margin-top:60px;width:70mm;border-top:1px solid #111;padding-top:5px}
.pie{font-size:8pt;color:#777;margin-top:16px}
</style></head><body>

<section class="portada">
  <div style="font-size:11pt;color:#5a6a4a">${esc(CFG.finca)}</div>
  <h1>${esc(CFG.titulo)}</h1>
  <div class="sub1">${esc(CFG.subtitulo)}</div>
  <table>
    <tr><td>Titular</td><td><b>${esc(CFG.titular.nombre)}</b> · C.C. ${esc(CFG.titular.cedula)}</td></tr>
    <tr><td>Entidad</td><td>${esc(CFG.credito.oficina)}</td></tr>
    <tr><td>Crédito</td><td>${esc(CFG.credito.numero)} · ${esc(CFG.credito.linea)}</td></tr>
    <tr><td>Condiciones</td><td>${esc(CFG.credito.plazo)} · ${esc(CFG.credito.tasa)}</td></tr>
    <tr><td>Desembolso</td><td>${pr.fecha_desembolso ? fechaLarga(pr.fecha_desembolso) : '—'}</td></tr>
    <tr><td>Fecha del informe</td><td>${fechaLarga(hoy)}</td></tr>
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
<table class="gastos"><colgroup><col style="width:3%"><col style="width:9%"><col style="width:14%"><col style="width:37%"><col style="width:10%"><col style="width:9%"><col style="width:10%"><col style="width:8%"></colgroup><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Concepto</th><th>Rubro</th><th>Pago</th><th class="n">Valor</th><th>Soporte</th></tr>
${filas(obra, 1)}
<tr><th colspan="6">Total construcción</th><th class="n">${plata(totalObra)}</th><th></th></tr></table>

${cultivo.length ? `<h2>5. ${esc(CFG.cultivo.titulo)}</h2>
<table class="gastos"><colgroup><col style="width:3%"><col style="width:9%"><col style="width:14%"><col style="width:37%"><col style="width:10%"><col style="width:9%"><col style="width:10%"><col style="width:8%"></colgroup><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Concepto</th><th>Rubro</th><th>Pago</th><th class="n">Valor</th><th>Soporte</th></tr>
${filas(cultivo, obra.length + 1)}
<tr><th colspan="6">Total</th><th class="n">${plata(totalCultivo)}</th><th></th></tr></table>` : ''}

${fotosObra.length ? `<h2>${cultivo.length ? 6 : 5}. Registro fotográfico de la obra</h2>
<div class="fotos">${fotosObra.map(f => `<figure><img src="${esc(fotoSrc(f.archivo))}"><figcaption>${esc(f.titulo)}</figcaption></figure>`).join('')}</div>` : ''}

${anexos.length ? `<h2>Índice de anexos</h2><table class="gastos"><tr><th>Anexo</th><th>Documento</th><th>Corresponde a</th></tr>
${anexos.map(a => `<tr><td class="c">${a.n}</td><td>${esc(a.descripcion || a.nombre)}</td><td>${a.mov ? `${fecha(a.mov.fecha)} · ${esc(a.mov.concepto.slice(0, 70))}` : 'Documentos del préstamo'}</td></tr>`).join('')}</table>` : ''}

${CFG.firma ? `<div class="firma"><b>${esc(CFG.titular.nombre)}</b><br>C.C. ${esc(CFG.titular.cedula)}</div>` : ''}
<div class="pie">Informe generado con la app Finca El Retiro el ${fechaLarga(hoy)}. Valores en pesos colombianos con IVA incluido (valor neto pagado).</div>
</body></html>`;

/* ── PDF: informe + anexos ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'informe-'));
const navegador = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage();
const pdfDeHtml = async (h, archivo) => { await pag.setContent(h, { waitUntil: 'networkidle' }); await pag.pdf({ path: archivo, format: 'Letter', printBackground: true }); return archivo; };
const partes = [await pdfDeHtml(html, path.join(tmp, '00_informe.pdf'))];
const portadaAnexo = a => `<!doctype html><meta charset="utf-8"><body style="font-family:Arial;margin:0">
  <div style="padding:14mm 14mm 6mm"><div style="font-size:16pt;font-weight:bold;color:#2A4F08">Anexo ${a.n}</div>
  <div style="font-size:11pt">${esc(a.descripcion || a.nombre)}</div>
  ${a.mov ? `<div style="font-size:10pt;color:#555">${fecha(a.mov.fecha)} · ${esc(a.mov.concepto)} · ${plata(a.mov.valor)}</div>` : ''}</div>`;
for (const a of anexos) {
  const r = await fetch(a.url); if (!r.ok) { console.warn(`No se pudo bajar el anexo ${a.n}: ${a.url}`); continue; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (a.tipo === 'application/pdf') {
    partes.push(await pdfDeHtml(portadaAnexo(a) + '</body>', path.join(tmp, `${String(a.n).padStart(3, '0')}_a.pdf`)));
    const f = path.join(tmp, `${String(a.n).padStart(3, '0')}_b.pdf`); fs.writeFileSync(f, buf); partes.push(f);
  } else {
    const img = `data:${a.tipo || 'image/png'};base64,${buf.toString('base64')}`;
    partes.push(await pdfDeHtml(portadaAnexo(a) + `<div style="padding:0 14mm;text-align:center"><img src="${img}" style="max-width:100%;max-height:215mm;object-fit:contain;border:1px solid #ccc"></div></body>`,
      path.join(tmp, `${String(a.n).padStart(3, '0')}.pdf`)));
  }
}
await navegador.close();
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
execFileSync('pdfunite', [...partes, SALIDA]);
console.log(`Informe listo: ${SALIDA}\n${movs.length} gastos · ${anexos.length} anexos · construcción ${plata(totalObra)} · total ${plata(total)}`);
