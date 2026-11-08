/*
 * Informe del crédito de la siembra (Banco Agrario N° 725069400241061) en PDF carta.
 * Muestra: semillas y plántulas del tomate, insumos agrícolas comprados con factura desde el desembolso,
 * y los jornales del lote de tomate; con las facturas como anexos. Misma portada que los otros informes.
 * Uso: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node informes/generar_informe_siembra.mjs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { armarAnexos } from './anexos.mjs';
import { portada, cssPortada } from './portada.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(AQUI, 'credito_siembra.json'), 'utf8'));
const CFG_P = JSON.parse(fs.readFileSync(path.join(AQUI, 'prestamo_invernadero.json'), 'utf8'));
const hoy = new Date().toISOString().slice(0, 10);
const SALIDA = path.resolve(process.argv[2] || path.join(AQUI, 'salida', `Informe_credito_siembra_${hoy}.pdf`));
const SUPA = 'https://sueramxzbibijuaamzbi.supabase.co', KEY = process.env.SUPABASE_KEY || 'sb_publishable_z94UVtLm_UN4rJUuGMGS4w_FwTc79Fc';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

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
const [compras, jornales, soportes, lotes] = await Promise.all([
  api('compras', `proyecto_id=is.null&origen=neq.consumo&fecha_compra=gte.${CFG.desde}&order=fecha_compra&limit=5000`),
  api('jornales', `proyecto_id=is.null&fecha=gte.${CFG.desde}&order=fecha&limit=5000`),
  api('soportes', `compra_id=not.is.null&limit=5000`),
  api('lotes', 'select=id,codigo,cultivo')
]);
const loteDe = id => { const l = lotes.find(x => x.id === id); return l ? `${l.cultivo} (${l.codigo})` : 'labores generales'; };
const sopDe = ids => soportes.filter(s => ids.includes(s.compra_id));
const esSemillaTomate = c => /semilla de tomate|plántulas de tomate/i.test(c.concepto) || (c.categoria === 'Semilla' && /tomate|tronus|taurus|lesvos/i.test(c.concepto + ' ' + (CFG.semillas_concepto[c.lote_id] || '')));
/* Una factura = una fila con sus productos */
function agrupar(lista) {
  const g = new Map();
  for (const c of lista) {
    const k = c.numero_factura ? `${c.numero_factura}|${c.proveedor || ''}` : c.id;
    if (!g.has(k)) g.set(k, { fecha: c.fecha_compra, proveedor: (c.proveedor || 'Sin proveedor').split(' · ')[0], factura: c.numero_factura, filas: [], ids: [] });
    const m = g.get(k); m.filas.push(c); m.ids.push(c.id); if (c.fecha_compra < m.fecha) m.fecha = c.fecha_compra;
  }
  return [...g.values()].map(m => ({ ...m, valor: m.filas.reduce((a, c) => a + num(c.valor_total), 0), soportes: sopDe(m.ids),
    concepto: m.filas.length > 1 ? `Factura ${m.factura} · ${m.proveedor}` : (CFG.semillas_concepto[m.filas[0].lote_id] && m.filas[0].categoria === 'Semilla' ? CFG.semillas_concepto[m.filas[0].lote_id] : m.filas[0].concepto) }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}
const semillas = agrupar(compras.filter(esSemillaTomate));
const insumos = agrupar(compras.filter(c => !esSemillaTomate(c) && ['Agroquímicos', 'Nutrición', 'Insumos Consumibles'].includes(c.categoria) && c.numero_factura));
/* Mano de obra: los jornales de los cultivos. Un gasto de cuenta «jornales» que repite un jornal (mismo día y valor) no se cuenta dos veces */
const jorn = [
  ...jornales.map(j => ({ fecha: j.fecha, proveedor: j.trabajador, concepto: `Jornal ${num(j.dias)} día(s) · ${loteDe(j.lote_id)}${j.nota ? ' · ' + j.nota : ''}`, valor: num(j.valor_total), filas: [], soportes: [] })),
  ...compras.filter(c => c.categoria === 'jornales' && !jornales.some(j => j.fecha === c.fecha_compra && Math.abs(num(j.valor_total) - num(c.valor_total)) < 1))
    .map(c => ({ fecha: c.fecha_compra, proveedor: (c.proveedor || 'Trabajador').split(' · ')[0], concepto: c.concepto, valor: num(c.valor_total), filas: [], soportes: [] }))
].sort((a, b) => a.fecha.localeCompare(b.fecha));
/* Envíos desde la cuenta del crédito para mano de obra, estacas, alambre y transporte (con el aviso del banco) */
const envios = compras.filter(c => c.categoria === 'Por verificar' && /Agrario/.test(c.concepto)).map(c => ({ fecha: c.fecha_compra, proveedor: 'Andrés Felipe Escobar',
  concepto: `Envío desde la cuenta del crédito · concepto en el banco: «${(c.concepto.match(/concepto: ([^)]*)/) || [, 'sin concepto'])[1]}»`, valor: num(c.valor_total), filas: [c], ids: [c.id], soportes: sopDe([c.id]) }));
const suma = l => l.reduce((a, m) => a + m.valor, 0);
const tS = suma(semillas), tI = suma(insumos), tJ = suma(jorn), tE = suma(envios), total = tS + tI + tJ + tE;
const { monto, desembolsado } = CFG.credito, descuento = monto - desembolsado;

/* Anexos: facturas (una vez por archivo), el desembolso y la constancia del banco */
const anexos = [], porRuta = new Map();
for (const m of [...semillas, ...insumos, ...envios]) m.anexos = [...new Set(m.soportes.map(s => {
  if (!porRuta.has(s.ruta)) { const a = { url: s.url, tipo: s.tipo, titulo: s.descripcion || s.nombre, linea: `${fecha(m.fecha)} · ${m.proveedor} · ${plata(m.valor)}` }; porRuta.set(s.ruta, a); anexos.push(a); }
  return porRuta.get(s.ruta);
}))];
jorn.forEach(m => m.anexos = []);
const docDesembolso = { url: CFG.credito.soporte_desembolso, tipo: 'image/png', titulo: 'Movimientos de la cuenta Banco Agrario *6101 · desembolso del crédito', linea: `${fecha(CFG.credito.fecha_desembolso)} · ${plata(desembolsado)}` };
const docEstado = { url: CFG.estado_credito.soporte, tipo: 'application/pdf', titulo: 'Banco Agrario · respuesta caso 2026080633 (estado de los créditos)', linea: fecha(CFG.estado_credito.fecha) };
anexos.push(docDesembolso, docEstado);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siembra-'));
let FOTO = '';
if (CFG_P.foto_portada) { const r = await fetch(CFG_P.foto_portada).catch(() => null); if (r && r.ok) FOTO = `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; }
const AX = await armarAnexos(anexos, { tmp, esc });
anexos.sort((x, y) => x.n - y.n);

const cg = '<colgroup><col style="width:5%"><col style="width:11%"><col style="width:16%"><col style="width:44%"><col style="width:13%"><col style="width:11%"></colgroup>';
const cab = '<tr><th class="c">#</th><th class="c">Fecha</th><th>Proveedor</th><th>Concepto</th><th class="n">Valor</th><th class="c">Anexo</th></tr>';
const filas = (lista, desde) => lista.map((m, i) => `
  <tr class="mov"><td class="c">${desde + i}</td><td class="c">${fecha(m.fecha)}</td><td>${esc(m.proveedor)}</td><td><b>${esc(m.concepto)}</b>${m.factura && m.filas.length < 2 ? `<div class="sub">Factura ${esc(m.factura)}</div>` : ''}</td>
    <td class="n"><b>${plata(m.valor)}</b></td><td class="c">${m.anexos.length ? m.anexos.map(a => a.n).sort((x, y) => x - y).join(', ') : '<span class="falta">Sin soporte</span>'}</td></tr>
  ${m.filas.length > 1 ? `<tr class="det"><td></td><td colspan="5"><table class="items"><colgroup><col><col style="width:20%"></colgroup>${m.filas.map(x => `<tr><td>${esc(x.concepto)}</td><td class="n">${plata(num(x.valor_total))}</td></tr>`).join('')}</table></td></tr>` : ''}`).join('');
const tabla = (titulo, lista, desde, tot, nota = '') => `<h2>${titulo}</h2>${nota ? `<p class="nota">${nota}</p>` : ''}<table class="gastos">${cg}${cab}${filas(lista, desde)}<tr><th colspan="4">Subtotal</th><th class="n">${plata(tot)}</th><th></th></tr></table>`;
const indice = anexos.map(a => `<tr><td class="c">${a.n}</td><td>${esc(a.titulo)}</td><td>${esc(a.linea)}</td></tr>`);
const cgI = '<colgroup><col style="width:8%"><col style="width:55%"><col style="width:37%"></colgroup>';

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(CFG.titulo)} · crédito de siembra</title><style>
@page{size:Letter;margin:16mm 14mm 18mm}
body{font-family:Arial,Helvetica,sans-serif;color:#1a1f14;font-size:10.5pt;line-height:1.4}
h2{font-size:13pt;color:#2A4F08;border-bottom:2px solid #639922;padding-bottom:3px;margin:18px 0 8px;break-after:avoid}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9d4bb;padding:4px 6px;vertical-align:top;text-align:left}th{background:#EAF3DE;font-size:9.5pt}
td.n,th.n{text-align:right;white-space:nowrap}td.c,th.c{text-align:center}
.resumen td{font-size:11pt;padding:6px 10px}.resumen tr.tot td{font-weight:bold;background:#EAF3DE}
.destacado{margin:10px 0;padding:10px 12px;border-left:4px solid #639922;background:#F4FAE6}
.gastos{font-size:8.6pt;table-layout:fixed}.gastos td,.gastos th{padding:4px 5px;overflow-wrap:break-word}.gastos tr.mov td{background:#FAFCF6;vertical-align:middle}.gastos td.n{overflow-wrap:normal}.sub{font-size:8pt;color:#5a6a4a}
tr.det td{border-top:none;padding:0 6px 6px}table.items{font-size:8pt;table-layout:fixed}table.items td{border:none;border-bottom:1px dotted #d6dfcb;padding:2px 5px}
.falta{color:#B07010;font-style:italic}.indice{font-size:8.3pt}.nota{font-size:9pt;color:#444;margin:0 0 6px}.pie{font-size:8pt;color:#777;margin-top:14px}
.firma{margin-top:40px;width:70mm;border-top:1px solid #111;padding-top:5px}
</style>${cssPortada}</head><body>
${portada({ esc, lugar: CFG.finca, titulo: CFG.titulo, subtitulo: CFG.subtitulo, foto: FOTO,
  cifras: [['Desembolsado', plata(desembolsado)], ['Total invertido', plata(total)], ['Estado del crédito', 'Al día']],
  datos: [['Titular', `<b>${esc(CFG.titular.nombre)}</b> · C.C. ${esc(CFG.titular.cedula)}`], ['Entidad', esc(CFG.credito.oficina)],
    ['Crédito N°', `<b>${esc(CFG.credito.numero)}</b> · ${esc(CFG.credito.linea)}`], ['Desembolso', fechaLarga(CFG.credito.fecha_desembolso)],
    ['Cultivo principal', 'Tomate: Tronus en campo abierto (1.500 plantas) y segunda siembra en el invernadero']],
  pie: `Informe del ${fechaLarga(hoy)} · ${anexos.length} soportes documentales en los anexos` })}

<h2>1. Resumen del crédito</h2>
<table class="resumen">
  <tr><td>Monto aprobado</td><td class="n">${plata(monto)}</td></tr>
  <tr><td>Descontado por el banco (seguro y comisiones)</td><td class="n">− ${plata(descuento)}</td></tr>
  <tr class="tot"><td>Desembolsado a la cuenta (${fecha(CFG.credito.fecha_desembolso)})</td><td class="n">${plata(desembolsado)}</td></tr>
  <tr><td>Semillas y plántulas de tomate</td><td class="n">${plata(tS)}</td></tr>
  <tr><td>Insumos agrícolas comprados con factura</td><td class="n">${plata(tI)}</td></tr>
  <tr><td>Mano de obra (jornales de los cultivos)</td><td class="n">${plata(tJ)}</td></tr>
  <tr><td>Envíos desde la cuenta del crédito para mano de obra, estacas, alambre y transporte</td><td class="n">${plata(tE)}</td></tr>
  <tr class="tot"><td>Total invertido en la siembra</td><td class="n">${plata(total)}</td></tr>
</table>
<div class="destacado">Se invirtió el <b>100 % del dinero desembolsado</b>${total > desembolsado ? ` y además <b>${plata(total - desembolsado)}</b> de recursos propios` : ''}. ${plata(suma([...semillas, ...insumos, ...envios].filter(m => m.anexos.length)))} están respaldados con factura electrónica o aviso del banco en los anexos.</div>
<div class="destacado"><b>Estado del crédito según el banco (${fecha(CFG.estado_credito.fecha)}):</b> ${esc(CFG.estado_credito.texto)} <span class="sub">Fuente: ${esc(CFG.estado_credito.fuente)}.</span></div>

<h2>2. Destino del crédito</h2>
${CFG.descripcion.map(p => `<p>${esc(p)}</p>`).join('')}

${tabla('3. Semillas y plántulas de tomate', semillas, 1, tS)}
${tabla('4. Insumos agrícolas comprados con factura', insumos, semillas.length + 1, tI, 'Fertilizantes, fungicidas, insecticidas y consumibles comprados desde el desembolso para los cultivos de la finca.')}
${tabla('5. Mano de obra (jornales de los cultivos)', jorn, semillas.length + insumos.length + 1, tJ, 'Jornales pagados en efectivo en la finca, anotados día a día con la labor y el lote.')}
${tabla('6. Envíos desde la cuenta del crédito para mano de obra, estacas, alambre y transporte', envios, semillas.length + insumos.length + jorn.length + 1, tE, 'Transferencias desde la cuenta Banco Agrario *6101 (donde se desembolsó el crédito) a Andrés Felipe Escobar, encargado de la finca, para pagar en efectivo trabajadores, estacas, alambre y transportes.')}

<div style="break-inside:avoid"><h2>Índice de anexos</h2><table class="indice">${cgI}<tr><th>Anexo</th><th>Documento</th><th>Corresponde a</th></tr>${indice.slice(0, 5).join('')}</table></div>
${indice.length > 5 ? `<table class="indice" style="margin-top:-1px">${cgI}${indice.slice(5).join('')}</table>` : ''}
<div class="firma"><b>${esc(CFG.titular.nombre)}</b><br>C.C. ${esc(CFG.titular.cedula)}</div>
<div class="pie">Valores en pesos colombianos con IVA incluido (valor neto pagado).</div>
${AX.css}${AX.html}
</body></html>`;

const navegador = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage();
await pag.setContent(html, { waitUntil: 'networkidle' });
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
await pag.pdf({ path: SALIDA, format: 'Letter', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: `<div style="font-size:7pt;color:#888;width:100%;text-align:center;font-family:Arial">${esc(CFG.subtitulo)} · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>` });
await navegador.close();
console.log(`Informe listo: ${SALIDA}\nsemillas ${plata(tS)} · insumos ${plata(tI)} · jornales ${plata(tJ)} · envíos ${plata(tE)} · total ${plata(total)} · ${anexos.length} anexos`);
