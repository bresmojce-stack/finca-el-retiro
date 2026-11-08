/*
 * Portada común de los informes (préstamo del invernadero y gastos de la finca): misma foto y mismo estilo.
 * portada({ lugar, titulo, subtitulo, foto, cifras: [[etiqueta, valor]], datos: [[etiqueta, valor]], pie, esc })
 */
export function portada({ lugar, titulo, subtitulo, foto, cifras = [], datos = [], pie = '', esc }) {
  return `<section class="pt">
  <div class="pt-foto"${foto ? ` style="background-image:url('${foto}')"` : ''}>
    <div class="pt-velo">
      <div class="pt-lugar">${esc(lugar)}</div>
      <h1 class="pt-tit">${esc(titulo)}</h1>
      <div class="pt-sub">${esc(subtitulo)}</div>
    </div>
  </div>
  ${cifras.length ? `<div class="pt-cifras">${cifras.map(([e, v]) => `<div><span>${esc(e)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
  <table class="pt-datos">${datos.map(([e, v]) => `<tr><td>${esc(e)}</td><td>${v}</td></tr>`).join('')}</table>
  ${pie ? `<div class="pt-pie">${pie}</div>` : ''}
</section>`;
}

export const cssPortada = `<style>
.pt{height:243mm;display:flex;flex-direction:column;break-after:page;font-family:Arial,Helvetica,sans-serif}
.pt-foto{height:118mm;border-radius:6px;background:#2A4F08 center/cover no-repeat;position:relative;overflow:hidden}
.pt-velo{position:absolute;left:0;right:0;bottom:0;padding:16mm 10mm 8mm;background:linear-gradient(to bottom,rgba(20,40,5,0) 0%,rgba(20,40,5,.55) 35%,rgba(20,40,5,.88) 100%);color:#fff}
.pt-lugar{font-size:9.5pt;letter-spacing:.18em;text-transform:uppercase;opacity:.92}
.pt-tit{font-family:Georgia,'Liberation Serif','DejaVu Serif',serif;font-size:30pt;line-height:1.08;margin:3mm 0 2mm;color:#fff;font-weight:bold}
.pt-sub{font-size:13pt;opacity:.95}
.pt-cifras{display:flex;gap:4mm;margin:7mm 0 6mm}
.pt-cifras div{flex:1;border:1px solid #c9d4bb;border-top:4px solid #639922;border-radius:4px;padding:3mm 4mm;background:#F7FAF1}
.pt-cifras span{display:block;font-size:8.5pt;color:#5a6a4a;text-transform:uppercase;letter-spacing:.06em}
.pt-cifras b{display:block;font-size:15pt;color:#2A4F08;margin-top:1mm}
.pt-datos{width:100%;border-collapse:collapse;font-size:10.5pt}
.pt-datos td{border:none;border-bottom:1px solid #e1e8d6;padding:2.4mm 2mm;vertical-align:top}
.pt-datos td:first-child{width:34%;color:#5a6a4a}
.pt-pie{margin-top:auto;font-size:9pt;color:#5a6a4a;border-top:2px solid #639922;padding-top:3mm}
</style>`;
