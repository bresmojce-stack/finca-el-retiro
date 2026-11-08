/*
 * Anexos (facturas, comprobantes, tirillas) acomodados en hojas carta sin desperdiciar espacio.
 * Lo usan el informe del préstamo y el de la finca.
 *
 * 1. Cada anexo se vuelve imagen. Se recortan sus márgenes blancos y los espacios blancos
 *    grandes que tiene por dentro.
 * 2. Se decide el tamaño:
 *    · factura u hoja normal → ancho completo;
 *    · comprobante de celular o tirilla → una "tarjeta" de un tercio de hoja. La tirilla larga se
 *      parte en tramos lado a lado para que quepan hasta 6 tarjetas por hoja (3 por fila, 2 filas).
 * 3. Se arman las hojas midiendo en mm: se llena cada hoja; si lo que sigue no cabe, se busca más
 *    adelante algo que sí quepa, o se reducen un poco las facturas de la hoja (mínimo 72 %).
 *    Nunca queda una hoja en blanco.
 * Los anexos se numeran en el orden en que quedan impresos: armarAnexos le pone `n` a cada uno.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const W = 186, H = 236, CAB = 11, G = 4, TITULO = 12;
const TERCIO = (W - 2 * G) / 3, ALTO_TARJETA = (H - TITULO - 2 * CAB - G) / 2;   // 2 filas de tarjetas por hoja
const angosto = b => b.w < W * 0.8;

const PY = `
import sys, json, math
import numpy as np
from PIL import Image
modo, src, pref = sys.argv[1], sys.argv[2], sys.argv[3]
if modo == 'partir':                      # parte una tirilla en k tramos iguales (de arriba a abajo)
    im = Image.open(src); k = int(sys.argv[4]); h = math.ceil(im.height / k); sal = []
    for i in range(k):
        f = f'{pref}_t{i}.jpg'; im.crop((0, i*h, im.width, min(im.height, (i+1)*h))).convert('RGB').save(f, quality=80, optimize=True); sal.append(f)
    print(json.dumps(sal)); sys.exit()
im = Image.open(src).convert('RGB')
g = np.asarray(im.convert('L'))
tinta = g < 235
filas, cols = np.where(tinta.any(axis=1))[0], np.where(tinta.any(axis=0))[0]
if len(filas) and len(cols):
    m = 10
    im = im.crop((max(0, cols[0]-m), max(0, filas[0]-m), min(im.width, cols[-1]+m), min(im.height, filas[-1]+m)))
    g = np.asarray(im.convert('L'))
# espacios blancos por dentro: se dejan de 14 px. Una fila cuenta como vacía aunque la crucen
# líneas verticales de tabla (menos del 1,5 % con tinta)
vacia = (g < 200).mean(axis=1) < 0.015
partes, y, n = [], 0, len(vacia)
while y < n:
    z = y
    while z < n and vacia[z] == vacia[y]: z += 1
    partes.append((y, min(z, y + 14)) if vacia[y] and z - y > 28 else (y, z)); y = z
alto = sum(b - a for a, b in partes)
if alto < im.height:
    nuevo = Image.new('RGB', (im.width, alto), 'white'); yy = 0
    for a, b in partes: nuevo.paste(im.crop((0, a, im.width, b)), (0, yy)); yy += b - a
    im = nuevo
if im.width > 1700: im = im.resize((1700, round(im.height * 1700 / im.width)))
f = f'{pref}.jpg'; im.save(f, quality=80, optimize=True)
print(json.dumps({'a': im.height / im.width, 'f': f}))
`;

/**
 * items: [{ url, tipo, titulo, linea }]  (tipo 'application/pdf' o imagen)
 * Devuelve { html, css } de las hojas de anexos. Pone `n` (número de anexo) a cada item.
 */
export async function armarAnexos(items, { tmp, esc }) {
  const py = path.join(tmp, 'anexos.py'); fs.writeFileSync(py, PY);
  const run = (...a) => JSON.parse(execFileSync('python3', [py, ...a.map(String)]).toString());
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
      const o = run('limpiar', p, `${base}_${k}`);
      const pag = pags.length > 1 ? ` (pág. ${k + 1} de ${pags.length})` : '';
      if (o.a <= 1.45) {
        /* Factura en PDF: ancho completo. Foto, pantallazo o aviso del banco: media hoja, dos por fila */
        const w = it.tipo === 'application/pdf' ? W : (W - G) / 2;
        bloques.push({ it, pag, src: [b64(o.f)], cols: 1, w, imgH: Math.min(w * o.a, H - TITULO - CAB), hoja: true }); return;
      }
      /* Comprobante o tirilla: tarjeta de un tercio (o dos tercios si es muy larga), con la tirilla en tramos */
      if (o.a <= 2.7) {                     // pantallazo de celular o tirilla corta: entera, de un tercio de ancho como máximo
        const w = Math.min(TERCIO, ALTO_TARJETA / o.a);
        bloques.push({ it, pag, src: [b64(o.f)], cols: 1, w: Math.max(w, 30), imgH: w * o.a, hoja: false }); return;
      }
      let mejor = null;
      for (const ancho of [TERCIO, 2 * TERCIO + G]) {
        for (let c = 2; c <= 6; c++) {
          const col = (ancho - (c - 1) * 2) / c, alto = col * o.a / c;
          if (col < 24) break;
          if (alto <= ALTO_TARJETA) { mejor = { ancho, c, alto }; break; }
        }
        if (mejor) break;
      }
      if (!mejor) mejor = { ancho: 2 * TERCIO + G, c: 6, alto: ALTO_TARJETA };   // larguísima: se reduce para que quepa
      bloques.push({ it, pag, src: run('partir', o.f, `${base}_${k}`, mejor.c).map(b64), cols: mejor.c, w: mejor.ancho, imgH: mejor.alto, hoja: false });
    });
  }

  /* Armado de hojas: llenar cada hoja; si lo que sigue no cabe, buscar más adelante algo que sí quepa */
  const hojas = [[]];
  let libre = H - TITULO;
  const pend = [...bloques];
  const fila = k => {                       // fila que empieza en el bloque k (angostos: los que quepan a lo ancho)
    const b = pend[k];
    if (!angosto(b)) return { idx: [k], alto: CAB + b.imgH };
    const idx = [k]; let ancho = b.w;
    for (let j = k + 1; j < pend.length && j <= k + 8; j++) if (angosto(pend[j]) && ancho + G + pend[j].w <= W + 0.5) { idx.push(j); ancho += G + pend[j].w; }
    return { idx, alto: CAB + Math.max(...idx.map(j => pend[j].imgH)) };
  };
  /* Una página de un anexo no se adelanta a otra página anterior del mismo anexo */
  const puedeAdelantarse = k => !pend.slice(0, k).some(b => b.it === pend[k].it);
  while (pend.length) {
    let elegido = null;
    for (let k = 0; k < Math.min(pend.length, 8); k++) {
      if (!puedeAdelantarse(k)) continue;
      const f = fila(k); if (f.alto <= libre) { elegido = f; break; }
    }
    if (!elegido) {
      /* No cabe: se reducen un poco todas las facturas de la hoja (mínimo al 72 %) para que entre la siguiente */
      const pg = hojas[hojas.length - 1], b = pend[0], tope = hojas.length === 1 ? H - TITULO : H;
      if (!angosto(b) && pg.length) {
        const red = pg.filter(f => !angosto(f.bloques[0])).map(f => f.bloques[0]).concat([b]);
        const fijo = pg.reduce((a, f) => a + CAB + G + (angosto(f.bloques[0]) ? f.alto - CAB : 0), 0) + CAB + G;
        const s = (tope - fijo) / red.reduce((a, x) => a + x.imgH, 0);
        if (s >= 0.72) {
          red.forEach(x => { x.imgH *= s; x.w *= s; });
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
    const img = b.cols > 1
      ? `<div class="atiras" style="grid-template-columns:repeat(${b.cols},1fr);height:${b.imgH.toFixed(1)}mm">${b.src.map(s => `<img src="${s}">`).join('')}</div>`
      : `<img style="height:${b.imgH.toFixed(1)}mm;max-width:100%" src="${b.src[0]}">`;
    return `<div class="atarj" style="width:${angosto(b) ? b.w.toFixed(1) + 'mm' : '100%'}">${cab(b)}${img}</div>`;
  };
  const html = hojas.filter(h => h.length).map((h, i, todas) => `<div class="apag"${i < todas.length - 1 ? ' style="break-after:page"' : ''}>${i === 0 ? '<h2 class="atit">Anexos: soportes</h2>' : ''}${
    h.map(f => angosto(f.bloques[0]) ? `<div class="afila">${f.bloques.map(tarjeta).join('')}</div>` : tarjeta(f.bloques[0])).join('')}</div>`).join('');
  const css = `<style>
.apag{break-before:page;display:flex;flex-direction:column;gap:${G}mm}.apag+.apag{break-before:auto}
.atit{margin:0;height:${TITULO - G}mm}
.afila{display:flex;gap:${G}mm;align-items:flex-start}.atarj{text-align:center;break-inside:avoid}
.acab{text-align:left;font-size:7.3pt;line-height:1.25;color:#333;background:#EAF3DE;border-left:3px solid #639922;padding:1.2mm 2mm;height:${CAB - 1.5}mm;box-sizing:border-box;overflow:hidden;margin-bottom:1.5mm}
.acab span{display:block;color:#5a6a4a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atarj img{border:1px solid #ccc;object-fit:contain;vertical-align:top}
.atiras{display:grid;gap:2mm;align-items:start}.atiras img{width:100%;max-height:100%;object-fit:contain;object-position:top}
</style>`;
  return { html, css };
}
