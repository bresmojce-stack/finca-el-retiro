# Finca El Retiro — guía para Claude

**Primero leer `MANUAL.md` (reglas de Brian para todas las apps, 2026-10-26): manda sobre esta guía si chocan.**

App web (PWA) de la finca El Retiro (Pradera, Valle del Cauca) de Brian Roberto Escobar Morales (C.C. 1.113.524.335).
Se habla siempre en español, claro y sin tecnicismos.

## Proyecto
- `index.html`: toda la app (JS sin frameworks). `sw.js`: modo sin conexión.
- En cada cambio de la app subir `CACHE_VERSION` en `sw.js` y la versión del `<title>` de `index.html` (hoy v12.9).
- Publicar: trabajar en la rama asignada, push, crear PR y hacer merge a `main` con el MCP de GitHub. Netlify publica `main` en https://finca-el-retiro.netlify.app
- `informes/`: informe del préstamo en PDF (ver abajo). `informes/salida/` no se sube (está en `.gitignore`).

## Base de datos (Supabase)
- Proyecto `sueramxzbibijuaamzbi`, URL `https://sueramxzbibijuaamzbi.supabase.co`, llave publicable `sb_publishable_z94UVtLm_UN4rJUuGMGS4w_FwTc79Fc`.
- Tablas principales: `compras` (gastos; `items` jsonb `[{c,u,d,v,r}]`, `numero_factura`, `proyecto_id`, `origen` manual|consumo, `categoria`), `inventario` (bodega), `jornales`, `proyectos`, `soportes`, `cosechas`.
- Soportes: subir el archivo al bucket público `soportes` (POST `/storage/v1/object/soportes/<carpeta>/<ts>-<nombre>`) y crear la fila en `soportes` (url, ruta, nombre, tipo, descripcion, compra_id/jornal_id, proyecto_id si es del préstamo).
- El MCP `execute_sql` suele colgarse en borrados: usar la API REST (`DELETE /rest/v1/<tabla>?id=in.(...)`). Antes de borrar, guardar respaldo JSON de las filas.

## Reglas de cuentas (muy importante)
- **El préstamo del invernadero va aparte de la finca.** Préstamo = proyecto `20bf624c-f465-4156-afbc-f4b157067aaa` (Banco Agrario, crédito ****1371, desembolso 19/05/2026 de $42.988.194). Solo lleva lo pagado para construir el invernadero y poner en marcha su primer cultivo (turba, bandejas).
- **Finca y cultivos** = `proyecto_id` nulo: insumos de bodega, jornales del campo, semillas (Tronus, Lesvos), fletes de cosecha.
- La bodega y sus consumos son siempre de la finca; nunca entran al préstamo.
- Toda plata enviada al Nequi 318 540 5823 (Andrés Felipe Escobar, hermano) es gasto de la finca: registrar como categoría `Por verificar`, concepto "Gasto por verificar · transferencia a Andrés Escobar (banco · concepto)". No duplicar si ya hay un gasto registrado por esa misma transferencia.
- Las transferencias entre cuentas propias (Bancolombia @brian335, Nequi 3137527038, Davivienda 2357, Falabella) no son gasto.
- Salidas de Davivienda sin destino conocido: por decisión del usuario quedan fuera (respaldo en el scratchpad de la sesión del 17/10/2026).

## Cómo registrar facturas
- Una factura = un gasto, con su lista de productos (`items`) y precio neto con IVA. En orden de fecha, sin partirla por rubros.
- Revisar duplicados antes (número de factura, valor y fecha). Subir siempre el PDF o la foto como soporte.
- **Fechas claras:** cada pago va en su propio gasto con la fecha real del pago (abonos, adelanto y saldo, pagos por partes = un gasto por pago, "pago 1 de 3"…), cada uno con su comprobante. Nunca juntar en una fila pagos de fechas distintas. Si no se sabe la fecha, decirlo en el concepto ("fecha por confirmar") y preguntar.
- Facturas electrónicas de proveedores agrícolas (Agroinsumos Pradera, Cenagro, Cafioccidente, Agroindustrial JE, Agropinos, Hidroequipos, semillas…) casi siempre son de la finca o del invernadero; las de Éxito, Ktronix/Alkosto, Claro, Celsia, seguros, etc. son personales.
- Entrada a bodega: sumar en `inventario` (cantidad_actual, total_ingresado, precio_total, costo_unitario, ultimo_precio) y crear el gasto con el formato de la app: "Producto (cantidad UNIDAD)" o "Producto (reposición: cantidad UNIDAD)", categoría = la del inventario, con proveedor y número de factura.
- Lo del lote del invernadero que pague el préstamo va al proyecto; lo demás a la finca.

## Informe del préstamo (PDF tamaño carta)
- Generar: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node informes/generar_informe.mjs`
- Textos editables en `informes/prestamo_invernadero.json` (crédito, descripción de la obra, fotos, sección de cultivo; `incluir_consumos_de_bodega` debe quedar en `false`).
- Revisar el PDF por páginas (pdftoppm) antes de entregarlo: nada debe salirse de su casilla.

## Informe de gastos de la finca (PDF tamaño carta)
- Generar: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node informes/generar_informe_finca.mjs`
- Con `--compras`: solo lo comprado para la finca (sin jornales, Por verificar, cuotas ni Lauro), con sus facturas.
- Toda la plata que ha salido de la finca (sin el préstamo), por mes y por cuenta, con lo que tiene y no tiene soporte; las facturas van como anexos.
- Cuentas especiales: `Gastos Lauro` (plata que ha salido para Lauro), `Pago crédito` (cuotas del préstamo; van en la finca, no en lo invertido del invernadero), `Por verificar`.

## Pendientes conocidos
- Factura de la motobomba de Homecenter ($2.188.400, 24/05, pagada con tarjeta Falabella): hay que pedirla en Homecenter Palmira Unicentro.
- Número completo del crédito (solo se conoce ****1371).
- Extractos de Nequi de septiembre y octubre para revisar transferencias a Andrés.
- Verificar con Andrés en qué se gastó cada transferencia "Por verificar".
