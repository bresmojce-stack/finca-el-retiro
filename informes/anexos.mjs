/*
 * Anexos (facturas, comprobantes, tirillas) acomodados en hojas carta sin desperdiciar espacio.
 * Lo usan el informe del préstamo y el de la finca.
 *
 * Cada anexo se vuelve imagen. Luego se le recortan los márgenes blancos y los espacios blancos
 * grandes que tiene por dentro, y se mide.
 * Después se arman las hojas a mano (en mm): se llena cada hoja, y si una factura no cabe se busca
 * otra más adelante que sí quepa. Nunca queda una hoja en blanco.
 * Los anexos se numeran en el orden en que quedan impresos: armarAnexos le pone `n` a cada uno.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const W = 186, H = 236, CAB = 11, G = 4, ANCHO_MEDIA = (W - 2 * G) / 3, ALTO_MEDIA = 118, TITULO = 12, COL_TIRA = (W - 3 * G) / 4;
const angosto = b => b.tipo !== 'hoja' && b.w < W * 0.8;   // comprobantes y tirillas cortas: varios por fila

const PY = `
import sys, json, math
import numpy as np
from PIL import Image
src, pref = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
g = np.asarray(im.convert('L'))
tinta = g < 235
filas, cols = np.where(tinta.any(axis=1))[0], np.where(tinta.any(axis=0))[0]
if len(filas) and len(cols):
    m = 10
    im = im.crop((max(0, cols[0]-m), max(0, filas[0]-m), min(im.width, cols[-1]+m), min(im.height, filas[-1]+m)))
    g = np.asarray(im.convert('L'))
# espacios blancos grandes por dentro (facturas con medio papel vacío): se dejan de 14 px
# una fila cuenta como vacía aunque la crucen líneas verticales de tabla (menos del 1,5 % con tinta)
vacia = (g < 200).mean(axis=1) < 0.015
partes, y, n = [], 0, len(vacia)
while y < n:
    if vacia[y]:
        z = y
        while z < n and vacia[z]: z += 1
        partes.append((y, min(z, y + 14)) if z - y > 28 else (y, z)); y = z
    else:
        z = y
        while z < n and not vacia[z]: z += 1
        partes.append((y, z)); y = z
alto = sum(b - a for a, b in partes)
if alto < im.height:
    nuevo = Image.new('RGB', (im.width, alto), 'white'); yy = 0
    for a, b in partes: nuevo.paste(im.crop((0, a, im.width, b)), (0, yy)); yy += b - a
    im = nuevo
if im.width > 1700: im = im.resize((1700, round(im.height * 1700 / im.width)))
a = im.height / im.width
sal = []
if a > 2.7:   # tirilla larga: tramos de proporción ~2,3 que van en columnas
    k = min(6, math.ceil(a / 2.3)); h = math.ceil(im.height / k)
    for i in range(k):
        f = f'{pref}_{i}.jpg'; im.crop((0, i*h, im.width, min(im.height, (i+1)*h))).save(f, quality=78, optimize=True); sal.append(f)
else:
    f = f'{pref}_0.jpg'; im.save(f, quality=78, optimize=True); sal.append(f)
print(json.dumps({'a': a, 'tramos': sal, 'pa': [Image.open(x).height / Image.open(x).width for x in sal]}))
`;

/**
 * items: [{ url, tipo, titulo, linea }]  (tipo 'application/pdf' o imagen)
 * Devuelve el HTML de las hojas de anexos (con su CSS). Pone `n` (número de anexo) a cada item.
 */
export async function armarAnexos(items, { tmp, esc }) {
  const py = path.join(tmp, 'anexos.py'); fs.writeFileSync(py, PY);
  const b64 = f => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
  const bloques = [];
  for (const [i, it] of items.entries()) {
    const r = await fetch(it.url).catch(() => null);
    if (!r || !r.ok) { console.warn(`No se pudo bajar el anexo: ${it.url}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer()), base = path.join(tmp, `x${String(i).padStart(3, '0')}`);
    let pags = [];
    if (it.tipo === 'application/pdf') {
      fs.writeFileSync(base + '.pdf', buf);
      execFileSync('pdftoppm', ['-r', '150', '-png', base + '.pdf', base]);
      pags = fs.readdirSync(tmp).filter(f => f.startsWith(path.basename(base) + '-') && f.endsWith('.png')).sort().map(f => path.join(tmp, f));
    } else { fs.writeFileSync(base + '.img', buf); pags = [base + '.img']; }
    pags.forEach((p, k) => {
      const o = JSON.parse(execFileSync('python3', [py, p, `${base}_${k}`]).toString());
      const pag = pags.length > 1 ? ` (página ${k + 1} de ${pags.length})` : '';
      if (o.tramos.length > 1) {
        /* Tirilla: tramos de un cuarto de ancho, uno al lado del otro; si son pocos, deja espacio para otro anexo al lado */
        const cols = Math.min(o.tramos.length, 4), filas = Math.ceil(o.tramos.length / cols);
        let w = cols * COL_TIRA + (cols - 1) * G, imgH = filas * COL_TIRA * Math.max(...o.pa) + (filas - 1) * G;
        const max = H - TITULO - CAB; if (imgH > max) { w *= max / imgH; imgH = max; }
        bloques.push({ tipo: 'tiras', it, pag, src: o.tramos.map(b64), cols, w, imgH });
      } else if (o.a > 1.45) bloques.push({ tipo: 'media', it, pag, src: [b64(o.tramos[0])], w: ANCHO_MEDIA, imgH: Math.min(ANCHO_MEDIA * o.a, ALTO_MEDIA) });
      else bloques.push({ tipo: 'hoja', it, pag, src: [b64(o.tramos[0])], w: W, imgH: Math.min(W * o.a, H - TITULO - CAB) });
    });
  }

  /* Armado de hojas: llenar cada hoja; si lo que sigue no cabe, buscar más adelante algo que sí quepa */
  const hojas = [[]];
  let libre = H - TITULO;
  const pend = [...bloques];
  const fila = k => {                       // la fila que empieza en el bloque k (angostos: los que quepan a lo ancho)
    const b = pend[k];
    if (!angosto(b)) return { idx: [k], alto: CAB + b.imgH };
    const idx = [k]; let ancho = b.w;
    for (let j = k + 1; j < pend.length && j <= k + 6; j++) if (angosto(pend[j]) && ancho + G + pend[j].w <= W + 0.5) { idx.push(j); ancho += G + pend[j].w; }
    return { idx, alto: CAB + Math.max(...idx.map(j => pend[j].imgH)) };
  };
  /* Una página de un anexo no se adelanta a otra página anterior del mismo anexo */
  const puedeAdelantarse = k => !pend.slice(0, k).some(b => b.it === pend[k].it);
  while (pend.length) {
    let elegido = null;
    for (let k = 0; k < Math.min(pend.length, 6); k++) {
      if (!puedeAdelantarse(k)) continue;
      const f = fila(k); if (f.alto <= libre) { elegido = f; break; }
    }
    if (!elegido) {
      /* No cabe: se prueba reducir un poco todas las facturas de la hoja (mínimo al 72 %) para que entre la siguiente */
      const pg = hojas[hojas.length - 1], b = pend[0], tope = hojas.length === 1 ? H - TITULO : H;
      if (!angosto(b) && pg.length) {
        const esc = pg.filter(f => !angosto(f.bloques[0])).map(f => f.bloques[0]).concat([b]);
        const fijo = pg.reduce((a, f) => a + CAB + G + (angosto(f.bloques[0]) ? f.alto - CAB : 0), 0) + CAB + G;
        const s = (tope - fijo) / esc.reduce((a, x) => a + x.imgH, 0);
        if (s >= 0.72) {
          esc.forEach(x => { x.imgH *= s; x.w *= s; });
          pg.forEach(f => { if (!angosto(f.bloques[0])) f.alto = CAB + f.bloques[0].imgH; });
          elegido = { idx: [0], alto: CAB + b.imgH };
          libre = tope - pg.reduce((a, f) => a + f.alto + G, 0);
        }
      }
      if (!elegido) { hojas.push([]); libre = H; continue; }
    }
    const filaB = elegido.idx.map(j => pend[j]);
    elegido.idx.sort((x, y) => y - x).forEach(j => pend.splice(j, 1));
    hojas[hojas.length - 1].push({ bloques: filaB, alto: elegido.alto });
    libre -= elegido.alto + G;
  }

  /* Números de anexo en el orden impreso */
  let n = 0;
  for (const h of hojas) for (const f of h) for (const b of f.bloques) if (!b.it.n) b.it.n = ++n;
  items.filter(it => !it.n).forEach(it => it.n = ++n);

  const cab = b => `<div class="acab"><b>Anexo ${b.it.n}${b.pag}</b> · ${esc(b.it.titulo || '')}${b.it.linea ? `<span>${esc(b.it.linea)}</span>` : ''}</div>`;
  const tarjeta = b => {
    const img = b.tipo === 'tiras'
      ? `<div class="atiras" style="grid-template-columns:repeat(${b.cols},1fr);width:${b.w.toFixed(1)}mm">${b.src.map(s => `<img src="${s}">`).join('')}</div>`
      : `<img style="height:${b.imgH.toFixed(1)}mm;max-width:100%" src="${b.src[0]}">`;
    return `<div class="atarj" style="width:${angosto(b) ? b.w.toFixed(1) + 'mm' : '100%'}">${cab(b)}${img}</div>`;
  };
  const html = hojas.filter(h => h.length).map((h, i, todas) => `<div class="apag"${i < todas.length - 1 ? ' style="break-after:page"' : ''}>${i === 0 ? '<h2 class="atit">Anexos: soportes</h2>' : ''}${
    h.map(f => angosto(f.bloques[0]) ? `<div class="afila">${f.bloques.map(tarjeta).join('')}</div>` : tarjeta(f.bloques[0])).join('')}</div>`).join('');
  const css = `<style>
.apag{break-before:page;display:flex;flex-direction:column;gap:${G}mm}.apag+.apag{break-before:auto}
.atit{margin:0 0 0 0;height:${TITULO - G}mm}
.afila{display:flex;gap:${G}mm;align-items:flex-start}.atarj{text-align:center;break-inside:avoid}
.acab{text-align:left;font-size:7.3pt;line-height:1.25;color:#333;background:#EAF3DE;border-left:3px solid #639922;padding:1.2mm 2mm;height:${CAB - 1.5}mm;box-sizing:border-box;overflow:hidden;margin-bottom:1.5mm}
.acab span{display:block;color:#5a6a4a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atarj img{border:1px solid #ccc;object-fit:contain;vertical-align:top}
.atiras{display:grid;gap:${G}mm;align-items:start;margin:0 auto}.atiras img{width:100%}
</style>`;
  return { html, css, hojas: hojas.filter(h => h.length).length };
}
