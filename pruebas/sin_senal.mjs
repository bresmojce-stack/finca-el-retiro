/* Prueba de la sincronización (funciona sin internet sin perder datos).
   Correr desde la carpeta del proyecto:  node pruebas/sin_senal.mjs
   Simula la base de datos: no toca la real. Termina con "TODO BIEN" o con el primer error. */
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'fs';
import path from 'path';

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATOS = {
  usuarios: [{ id:'u1', codigo:'b', nombre_corto:'Brian', activo:true, rol:'a' }],
  compras: [{ id:'c1', fecha_compra:'2026-11-01', concepto:'Abono', categoria:'Nutrición', valor_total:100000, origen:'manual', numero_factura:'FE-1', proveedor:'X' },
            { id:'c2', fecha_compra:'2026-11-01', concepto:'Flete', categoria:'Por verificar', valor_total:50000, origen:'manual', numero_factura:'FE-1', proveedor:'X' }],
  inventario: [{ id:'i1', descripcion:'Trionex', categoria:'Agroquímicos', cantidad_actual:1000, total_ingresado:1000, precio_total:52000, costo_unitario:52, unidad_medida:'CC' }],
  jornales: [], soportes: [], proyectos: []
};
/* Base de datos de mentira: modo 'ok', 'red' (sin señal) o 'rechazo' (el servidor dice que no) */
const MOCK = `(function(){window.__ops=[];window.__modo='ok';const D=${JSON.stringify(DATOS)};
function q(t){let op='select',args=null;const res=()=>{if(window.__modo==='red')return {data:null,error:{message:'TypeError: Failed to fetch'},status:0};
 if(op!=='select'){window.__ops.push([t,op,args]);if(window.__modo==='rechazo')return {data:null,error:{message:'rechazado'},status:400};return {data:null,error:null,status:201};}
 return {data:D[t]||[],error:null,status:200};};
 const o=new Proxy({},{get:(x,k)=>k==='then'?((f,g)=>Promise.resolve(res()).then(f,g)):(['upsert','update','delete','insert'].includes(k)?(v)=>{op=k;args=v;return o;}:(k==='range'?(a)=>a>0?{then:f=>Promise.resolve({data:[],error:null,status:200}).then(f)}:o:()=>o))});return o;}
const rpc=async(fn,a)=>{if(window.__modo==='red')return {error:{message:'Failed to fetch'},status:0};if(window.__modo==='rechazo')return {error:{message:'rechazado'},status:400};window.__ops.push(['rpc',fn,a]);return {error:null,status:200};};
window.supabase={createClient:()=>({from:q,rpc,channel:()=>({on(){return this},subscribe(){return this}}),storage:{from:(b)=>({upload:async(p)=>{window.__ops.push(['storage','upload',p]);return window.__modo==='ok'?{error:null}:{error:{message:'Failed to fetch'}}},getPublicUrl:(p)=>({data:{publicUrl:'https://x/storage/v1/object/public/'+b+'/'+p}}),remove:async()=>({error:null})})}})};})();`;

const b = await chromium.launch();
const ctx = await b.newContext({ serviceWorkers:'block' });
const errores = [];
const igual = (nombre, real, esperado) => { if (JSON.stringify(real) !== JSON.stringify(esperado)) { console.log(`FALLA ${nombre}: dio ${JSON.stringify(real)}, se esperaba ${JSON.stringify(esperado)}`); process.exitCode = 1; } else console.log(`ok  ${nombre}`); };
async function abrir(){
  const p = await ctx.newPage(); p.on('pageerror', e => errores.push(e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('http://finca.prueba/')){ const f = path.join(RAIZ, new URL(u).pathname === '/' ? 'index.html' : new URL(u).pathname); return fs.existsSync(f) ? r.fulfill({ path:f }) : r.fulfill({ status:404 }); }
    if (u.includes('supabase-js')) return r.fulfill({ contentType:'application/javascript', body:MOCK });
    return r.fulfill({ body: u.endsWith('.js') ? 'window.L={}' : '', contentType: u.endsWith('.js') ? 'application/javascript' : 'text/css' });
  });
  await p.goto('http://finca.prueba/index.html'); await p.waitForTimeout(600); return p;
}
let p = await abrir();
await p.click('[data-login]'); await p.waitForTimeout(1200);
igual('carga inicial', await p.evaluate(() => S.cache.compras.length), 2);

// 1. Sin señal: el gasto queda en el teléfono y en la bandeja
await p.evaluate(() => { window.__modo = 'red'; });
await p.evaluate(() => HANDLERS.add_gasto({ concepto:'Sin señal', categoria:'Agroquímicos', valor_total:12345 }));
await p.evaluate(() => consumirInsumo({ itemId:'i1', cantidad:100 }));
await p.waitForTimeout(1200);
igual('gasto visible sin señal', await p.evaluate(() => S.cache.compras.some(c => c.concepto === 'Sin señal')), true);
igual('bodega descuenta en el teléfono', await p.evaluate(() => S.cache.inventory[0].cantidad_actual), 900);

// 2. Cerrar y abrir sin señal: nada se pierde
await p.close(); p = await abrir(); await p.evaluate(() => { window.__modo = 'red'; });
await p.click('[data-login]'); await p.waitForTimeout(1200);
igual('sigue tras recargar', await p.evaluate(() => S.cache.compras.some(c => c.concepto === 'Sin señal')), true);
igual('bandeja tras recargar', await p.evaluate(() => Outbox.pendientes()), 3);

// 3. El servidor rechaza: se marca y NO se bota
await p.evaluate(() => { window.__modo = 'rechazo'; }); await p.evaluate(() => Sync.todo()); await p.waitForTimeout(600);
igual('rechazo queda marcado', await p.evaluate(() => Outbox.conError().length > 0 && Outbox.pendientes() === 3), true);

// 4. Vuelve la señal: sube todo, en orden, y la bodega va como resta (no como "quedan tantos")
await p.evaluate(() => { window.__modo = 'ok'; window.__ops = []; }); await p.evaluate(() => Sync.todo()); await p.waitForTimeout(600);
igual('bandeja vacía', await p.evaluate(() => Outbox.pendientes()), 0);
igual('bodega se manda como resta', await p.evaluate(() => window.__ops.filter(o => o[0] === 'rpc').map(o => o[2].d_cant)), [-100]);

// 5. Filtros: una factura con dos cuentas suma solo lo de la cuenta elegida
igual('filtros por fila', await p.evaluate(() => { const m = movimientosFinca(); const v = f => filtrarFinca(m, f).filter(x => x.factura === 'FE-1').map(x => x.valor); return [v('todo'), v('compras'), v('Por verificar')]; }), [[150000], [100000], [50000]]);
// 6. Plata: un punto con 1 o 2 decimales es decimal, no miles
igual('numPlata', await p.evaluate(() => [numPlata('1234.56'), numPlata('1.500'), numPlata('12.345,6')]), [1234.56, 1500, 12345.6]);

// 7. El informe de la finca abre su página para imprimir
const [pop] = await Promise.all([p.waitForEvent('popup'), p.evaluate(() => informeFinca())]);
await pop.waitForLoadState();
igual('informe abre', (await pop.evaluate(() => document.querySelector('h1')?.innerText || '')).startsWith('Gastos de la finca'), true);

igual('sin errores en la página', errores, []);
await b.close();
console.log(process.exitCode ? 'HAY FALLAS' : 'TODO BIEN');
