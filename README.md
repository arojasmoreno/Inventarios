# Inventarios

Aplicación web para gestionar el inventario de una planta: **productos químicos**, **material de limpieza** (segregado por colores), **maquinaria de limpieza** (segregada por tipos), **usuarios** y **centros**.

Cada sección dispone de un CRUD completo (crear, leer, actualizar, borrar) y hay una pantalla de **informes** con el material existente en planta, exportable a CSV e imprimible en PDF.

## Stack

- **Backend**: [Hono](https://hono.dev) ejecutando como Cloudflare Worker (`src/worker/`).
- **Base de datos**: Cloudflare **D1 (SQLite)**. En local se usa una D1 local (persistente en `.wrangler/state/`); el esquema se crea automáticamente en el primer arranque (`src/worker/db.ts`).
- **Frontend**: React + Vite (`src/web/`), compilado a `dist/` y servido por el Worker.
- **Autenticación**: sesión por cookie `HttpOnly` + contraseñas con PBKDF2-SHA256 (100 000 iteraciones, sal por usuario).

## Arranque local

```bash
npm install          # si npm avisa de scripts pendientes: npm install-scripts approve esbuild workerd && npm rebuild esbuild workerd
npm run dev          # compila el frontend y arranca wrangler dev en http://0.0.0.0:3000
```

Otros comandos:

```bash
npm run build        # compila el frontend en dist/
npm run check        # typecheck (TypeScript) de frontend y backend
npm run preview      # solo levanta wrangler dev (usa dist/ ya compilado)
```

## Usuarios de ejemplo (primer arranque)

| Usuario   | Contraseña     | Rol          |
| --------- | -------------- | ------------ |
| `admin`   | `admin123`     | Administrador|
| `operario`| `operario123`  | Usuario      |

> ⚠️ Cambia estas contraseñas nada más entrar (*Usuarios* → Editar, o *Mi cuenta*).

## Permisos

| Acción                        | Administrador | Usuario |
| ----------------------------- | :-----------: | :-----: |
| Ver químicos / material / maquinaria / centros / informes | ✅ | ✅ |
| Crear químicos / material / maquinaria                    | ✅ | ✅ |
| Editar o borrar registros de inventario                   | ✅ | ❌ |
| CRUD de centros                                           | ✅ | solo lectura |
| CRUD de usuarios (y ver la lista)                         | ✅ | ❌ |
| Exportar CSV / imprimir informes                          | ✅ | ✅ |

Los permisos se validan en el servidor: los usuarios pueden consultar y dar de alta artículos de inventario; solo administradores pueden modificar o borrar registros existentes.

## Modelo de datos

- `centros`: plantas/ubicaciones (nombre, dirección, ciudad, responsable, teléfono).
- `usuarios`: login, nombre, email, contraseña (hash + sal), rol (`admin`/`usuario`), activo, centro habitual.
- `sessions`: tokens de sesión con caducidad.
- `quimicos`: nombre, nº de lote, litros por garrafa, nº de garrafas, fecha de producción (opcional, solo informativa), fecha de caducidad (opcional), **origen** (`fabrica` / `empresa`), centro, notas. El total de litros se calcula automáticamente (`litros_por_garrafa × num_garrafas`).
- `material_limpieza`: nombre, **color** (Rojo, Azul, Verde, Amarillo, Blanco, Negro, Naranja, Morado, Gris, Otro), cantidad, **origen** (`fabrica` / `empresa`), centro, notas.
- `maquinaria`: solo datos de la máquina — **tipo** (catálogo con altas propias), marca, modelo, nº de serie, centro, zona y subzona de ubicación, notas y foto. El **estado** (Operativo, En reparación, Mantenimiento preventivo, Averiado, Baja o situaciones propias) es su **último registro del histórico** (`maquinaria_historial`).

Todos los artículos pueden asignarse a un **centro**, de modo que los informes se pueden filtrar por planta. Los consumibles (químicos y material de limpieza) además llevan una columna **Origen** con solo dos opciones —**Fábrica** y **Empresa**— y un filtro para ver todo o elegir entre ellas.

## Informes

La sección *Gestión de informes* tiene cuatro pestañas: **Dashboard**, **Informes**, **Auditoría** e **Importar CSV** (esta última solo para administradores).

### Dashboard

Vista única con toda la información del sitio, con filtros por **planta** y por **origen** (Fábrica/Empresa):

- KPIs: litros y garrafas de químicos, unidades de material, maquinaria, EPIs/ropa, consumo de los últimos 30 días y alertas.
- Gráficos (SVG sin librerías): reparto por origen, estado de caducidad, consumo por día (30 días), caducidades por mes (12 meses), inventario por planta, maquinaria por situación y por tipo, material por color, consumos por zona y entregas por operario.
- Tablas: resumen por planta (con totales y CSV), origen de los consumibles (CSV), caducidades próximas y stock bajo mínimo.

### Informes

La pantalla *Informes* muestra, global o por centro (y por origen en los consumibles):

- Totales: litros y garrafas de químicos, unidades de material y de maquinaria.
- Alertas de caducidad: productos **vencidos** y los que caducan en ≤ 30 / ≤ 90 días.
- Desglose de material **por color** y de maquinaria **por tipo**.
- Tablas completas con exportación a **CSV** (separador `;`, compatible con Excel en español) y botón **Imprimir / PDF**.

## API

Todas las rutas requieren sesión (salvo login). Respuestas JSON.

| Método + ruta                       | Descripción |
| ----------------------------------- | ----------- |
| `POST /api/auth/login`              | Inicia sesión (`{username, password}`) |
| `POST /api/auth/logout`             | Cierra la sesión |
| `GET  /api/auth/me`                 | Devuelve el usuario actual |
| `POST /api/auth/cambiar-password`   | Cambia la contraseña del usuario conectado |
| `GET/POST /api/quimicos`            | Listar / crear (`?q=`, `?centro_id=`) |
| `GET/PUT/DELETE /api/quimicos/:id`  | Detalle / actualizar / borrar |
| Igual para `/api/material-limpieza`, `/api/maquinaria`, `/api/centros`, `/api/usuarios` | CRUD completo |
| `GET /api/informes?centro_id=`      | Datos agregados del informe |

## Estructura

```
src/worker/   API Hono: index.ts (rutas), auth.ts (sesiones), crud.ts (CRUD genérico),
              resources.ts (especificaciones y permisos), reportes.ts (informes), db.ts (esquema y seed)
src/web/      SPA React: App.tsx (login y navegación), resources.tsx (páginas CRUD),
              Informes.tsx, ui.tsx (componentes), styles.css
```

## CI, pruebas y despliegues

- **CI** (`.github/workflows/ci.yml`): en cada push y PR ejecuta `bun tsc -b --noEmit`, `bun test` y `bun run build`.
- **Tests**: `bun test` — tests unitarios del histórico de maquinaria (creación, idempotencia y sincronización del estado) con un shim de D1 sobre `bun:sqlite` (`tests/`).
- **GitHub Pages** (`.github/workflows/pages.yml`): publica `dist/` en <https://arojasmoreno.github.io/Inventarios/> con la API apuntando al Worker. Si Pages no está habilitado, el workflow termina en verde con un aviso (se activa en *Settings → Pages → Source: GitHub Actions*).
- **Producción**: el frontend se sirve en <https://inventarios.freebuff.app> (Freebuff) y la API en el Worker de Cloudflare; se despliega con `freebuff-deploy start` (frontend) y `npx wrangler deploy` (Worker). Un cron diario (06:00 UTC) envía el resumen de alertas por correo.
- **Backup de la base de datos**: `sh ./scripts/backup-d1.sh` exporta D1 a `backups/` (carpeta ignorada por git).
