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
- `quimicos`: nombre, nº de lote, litros por garrafa, nº de garrafas, fecha de caducidad, centro, notas. El total de litros se calcula automáticamente (`litros_por_garrafa × num_garrafas`).
- `material_limpieza`: nombre, **color** (Rojo, Azul, Verde, Amarillo, Blanco, Negro, Naranja, Morado, Gris, Otro), cantidad, centro, notas.
- `maquinaria`: nombre, **tipo** (Fregadora, Aspiradora, Monobrocha, Hidrolavadora, Barredora, Robot, Carro de limpieza, Otro), cantidad, nº de serie, estado (Operativa, En reparación, Averiada, Baja), centro, notas.

Todos los artículos pueden asignarse a un **centro**, de modo que los informes se pueden filtrar por planta.

## Informes

La pantalla *Informes* muestra, global o por centro:

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
