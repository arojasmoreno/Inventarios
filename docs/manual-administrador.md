# Manual del administrador · Inventarios

Guía completa de la aplicación **Inventarios** (químicos, material de limpieza y maquinaria) para el perfil **Administrador**: cómo entrar, qué hay en cada sección y cómo dar de alta y mantener los datos de la planta.

> ¿Eres operario o usuario de consulta? El manual de tu perfil está en [manual-usuario.md](manual-usuario.md).

---

## 1. Acceso a la aplicación

1. Abre el navegador (Chrome, Edge, Firefox o Safari) y ve a **https://inventarios.freebuff.app**.
2. Escribe tu **usuario** y tu **contraseña** y pulsa **Entrar**.

![Pantalla de acceso](img/acceso.png)

- Tu usuario y contraseña te los facilita el administrador de la instalación. El recuadro inferior de «Primer acceso» es una ayuda de las instalaciones nuevas: en una planta ya en marcha, esas claves de prueba no existen, usa siempre tu cuenta real.
- Si es la primera vez que entras, cambia la contraseña desde **Mi cuenta** (apartado 11).

### Errores frecuentes en el acceso

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| **Usuario o contraseña incorrectos** | La cuenta no existe o la contraseña no coincide (las mayúsculas importan). | Revisa el usuario y la contraseña. Si olvidaste la contraseña, usa **¿Has olvidado tu contraseña?** |
| **Demasiados intentos fallidos. Inténtalo de nuevo en 15 minutos.** | Por seguridad, 5 fallos en 15 minutos bloquean la cuenta 15 minutos. | Espera 15 minutos o pide a un administrador que te restablezca la contraseña. |
| **Failed to fetch** / **Error de red** | El navegador no ha podido contactar con el servidor. | Comprueba la conexión a internet, cierra el VPN o el firewall corporativo y recarga la página (F5). |
| **Usuario desactivado** | La cuenta está desactivada. | Pide a un administrador que la reactive en **Gestión de centros › Usuarios**. |

![Error de acceso: los campos erróneos se sombrean en rojo](img/acceso-error.png)

Cuando una validación falla, además del mensaje se **sombrea en rojo claro el campo culpable**; el color desaparece en cuanto lo modificas.

### Otras formas de entrar

- **🔑 Entrar con código por correo**: introduce tu correo y recibirás un código de 8 caracteres (caduca en 10 minutos) para abrir sesión sin contraseña.
- **¿Has olvidado tu contraseña?**: introduce tu correo, verifica el código que llega por correo y elige una contraseña nueva (mínimo 6 caracteres).

---

## 2. La pantalla principal

![Pantalla principal con el panel de control](img/admin-panel.png)

| Zona | Qué contiene |
|---|---|
| **Barra lateral izquierda** | Las secciones: Panel de control, Consumibles, Control de maquinaria, Equipación de operarios, Gestión de centros, Documentación, Gestión de informes y **Manuales y ayuda**. Debajo, **Cuenta › Mi cuenta**. |
| **Cabecera** | 🔎 **Buscar en todo…** (encuentra artículos, zonas, estaciones y usuarios), tu nombre, tu rol, el estado **Activo/Inactivo**, tus centros asignados y el botón **⏻ Salir**. |
| **Zona central** | El contenido de la sección elegida. |

> Consejo: la lupa de la cabecera es la vía rápida. Escribe 2 o más letras y pulsa sobre el resultado para saltar directamente al registro.

---

## 3. Panel de control

![Panel de control](img/admin-panel.png)

- **Tarjetas de resumen (KPI)**: consumo de hoy, últimos 7 días, estaciones activas, estaciones **sin consumo en 30 días** y número de **alertas**.
- **📊 Consumo por día (14 días)**: gráfico de barras con las unidades consumidas cada día.
- **📍 Consumos por zona (30 días)**: ranking de zonas; al pulsar una zona se abren sus estaciones.
- **📉 Artículos bajo mínimo**: stock por debajo del mínimo configurado, con acceso directo a la ficha.
- **🔔 Avisos operativos**: máquinas no operativas, revisiones de EPI próximas/vencidas y químicos vencidos o que caducan en 30 días.
- **🚻 Estaciones sin consumo en 30 días**: enlaces para abrir el modo estación y revisarlas.
- **📧 Enviar resumen por correo** (solo administradores): manda el parte de alertas a los administradores **solo cuando tú lo pides**. Ya no hay envíos automáticos diarios: el correo únicamente sale al pulsar este botón (o el botón equivalente de la esquina del dashboard).

---

## 4. Consumibles (químicos, material y estaciones)

![Sección de productos químicos](img/admin-quimicos.png)

Pestañas disponibles: **Químicos · Inventario por producto · Material de limpieza · Estaciones de consumo · Tipos de consumible · Soportes · Entradas / Salidas · Consumos**.

> **Ficha vs. lote**: en **Químicos** se dan de alta las *fichas* de producto (una fila por producto) y en **Inventario por producto** se gestionan sus *lotes* (nº de lote, fechas, garrafas y litros). El menú lateral ya no tiene una entrada aparte de inventario: esa pantalla es la pestaña **Inventario por producto** de esta misma sección.

En cualquier listado encontrarás:

- **🔍 Buscar…** y el filtro **por centro** (si hay varios centros).
- **⬇️ CSV** para exportar lo que esté filtrado (solo administradores).
- **＋ Nuevo registro** para dar de alta (los campos con **\*** son obligatorios).
- **Precio por garrafa / por unidad (€)**: campo **opcional**. Rellénalo cuando conozcas el coste y los informes calcularán el **valor del inventario**; si un producto no tiene precio, déjalo en blanco y no contará.
- **Stock mínimo en litros (L)** (obligatorio) y **Stock máximo en litros (L)** (opcional, en blanco = sin máximo): son los umbrales de la ficha. El inventario compara con ellos el total de litros de cada producto y muestra el aviso **⚠️ mín. X L** o **⬆ máx. X L** (véase 4.1).
- Iconos de fila para **editar**, **borrar** y, cuando aplica, la **etiqueta QR**.

![Formulario con validación fallida: los campos obligatorios quedan en rojo](img/admin-formulario-error.png)

Si pulsas **Guardar** con un campo obligatorio vacío o con un dato inválido, aparece el mensaje de error **y el campo se sombrea en rojo** hasta que lo corrijas.

### 4.1 Inventario por producto (litros, lotes y recuento)

La pestaña **Inventario por producto** agrupa el stock por producto y marca y despliega sus lotes:

- Una fila por producto con **lotes en uso**, **garrafas**, **total de litros** y **próxima caducidad**; pulsa la fila para abrir o cerrar el desglose de sus lotes.
- **Avisos de stock**: junto al total de litros aparece **⚠️ mín. X L** cuando el producto ha bajado de su mínimo y **⬆ máx. X L** cuando supera el máximo fijado. Los umbrales salen de la ficha (*Stock mínimo / máximo en litros*); sin umbral fijado no se muestra nada.
- **Filtros**: 🔍 buscar producto o lote, filtro **por centro** y la casilla **Ver lotes retirados** (agotados o descartados).
- **⬇️ CSV** (solo administradores y administradores de centros) exporta los lotes filtrados con sus fechas, litros y precio.
- **🖨️ Hoja de recuento** imprime la lista de lotes en uso con una columna en blanco para anotar a mano los litros reales (firmada por el responsable).
- **↗ Salida**: registra una salida de litros; el descuento se reparte por caducidad — **FEFO**, primero lo que caduca antes — y retira los lotes que quedan vacíos.
- **＋ Nueva entrada**: da de alta un lote de un producto ya existente (el producto en sí se crea antes en la pestaña Químicos).
- **📋 Recuento**: introduce los litros reales de cada lote; al validar, el stock se ajusta, los lotes vacíos se retiran y la hoja queda en **Últimos recuentos** (fecha, usuario, observaciones, lotes y diferencia).

El perfil **Usuario** ve esta pantalla en consulta: puede buscar, filtrar, ver los avisos de stock e imprimir la hoja de recuento, pero no exporta CSV ni registra entradas, salidas o recuentos.

### 4.2 Entradas / Salidas de stock

![Entradas y salidas](img/admin-entradas.png)

1. Elige el **recurso** (productos químicos o material de limpieza) y el **artículo**.
2. Selecciona el tipo de movimiento: **entrada**, **salida** o **ajuste**.
3. Indica la **cantidad** y un **motivo** (opcional pero recomendado).
4. Pulsa el botón de registrar. El movimiento queda en **Últimos movimientos** y en la auditoría.

### 4.3 Estaciones de consumo (QR)

Las estaciones son los puntos de la planta (zona › subzona › soporte) donde se coloca un artículo. **Al escanear su QR el stock se descuenta automáticamente**.

- **➖ −1 ud** está ahora en la **primera columna** de la lista (junto al nombre de la estación): descuenta una unidad al instante sin tener que desplazar la tabla en el móvil.
- El **QR de la estación** abre el **modo estación** (pantalla grande, apta para tablet en planta):

![Modo estación](img/admin-estacion.png)

En el modo estación puedes restar unidades con los botones grandes, escanear otro QR (**📷 Escanear otra estación**) y **↩ Deshacer último consumo** si hay un error.

- **🖨️ QR (n)** imprime las etiquetas QR de todas las estaciones filtradas; pégalas en el soporte correspondiente.

---

## 5. Control de maquinaria

![Listado de maquinaria](img/admin-maquinaria.png)

Pestañas: **Maquinaria · Histórico · Situaciones · Tipos de máquina**.

- **Maquinaria**: ficha de cada máquina (marca, modelo, nº de serie, tipo y ubicación). La tabla **ya no tiene columna de estado**: el estado vive en el **Histórico** y cada fila ofrece la acción **🕘 Histórico**, que abre el registro de esa máquina ya filtrado.
- **Histórico**: historial por máquina con **fecha, estado y notas** (además de marca, modelo y centro). Se filtra por máquina, **centro**, estado y periodo, se busca por texto y se exporta a **⬇️ CSV**. Desde aquí se crean y borran registros.

![Histórico de situaciones](img/admin-historial.png)

- **＋ Registrar situación** (solo administradores): cambia el estado de la máquina (Operativa, En reparación, Averiada, Baja…) y le añade unas **notas** (mantenimiento, repuestos, incidencias) que quedan guardadas en el histórico.
- **Situaciones** y **Tipos de máquina**: catálogos que después aparecen en los desplegables.

---

## 6. Equipación de operarios

![Equipación de operarios](img/admin-equipacion.png)

Pestañas: **Ropa de trabajo · EPIs · Entregas · Tipos de equipo · Tallas operarios**.

- **Ropa de trabajo** y **EPIs**: inventario por centro, con talla, color, stock y, en los EPIs, **fecha de revisión** (el panel avisa a los 30 días).
- **Entregas**: registro de entrega de equipación a operarios.

![Registro de entregas](img/admin-entregas.png)

1. Elige el **operario** y el **centro**.
2. Añade las prendas con **＋ Añadir línea** y la cantidad.
3. Guarda: **el stock se descuenta automáticamente** y la entrega queda en el historial (con firma y VoBo en la hoja imprimible).
- **Tipos de equipo** y **Tallas operarios**: catálogos (las tallas son exclusivas de administradores).

---

## 7. Gestión de centros

![Gestión de centros](img/admin-centros.png)

Pestañas: **Centros · Zonas y subzonas · Usuarios · Empresa**.

### Centros
Plantas o ubicaciones (nombre, ciudad, responsable, dirección). Todo lo demás de la app se agrupa por centro.

### Zonas y subzonas
![Zonas y subzonas](img/admin-zonas.png)
- **＋ Nueva zona** dentro de cada centro y **＋ Añadir subzona** dentro de cada zona.
- Cada zona muestra sus **puntos de consumo (estaciones)** con acceso directo al modo estación.

### Usuarios (solo administradores)
![Gestión de usuarios](img/admin-usuarios.png)

**＋ Nuevo registro** para crear una cuenta:

| Campo | Indicaciones |
|---|---|
| **Usuario (login)** | Nombre corto con el que se entra (sin espacios). |
| **Nombre completo** | Nombre y apellidos que se ven en la cabecera. |
| **Email** | Necesario para entrar con código y para recuperar la contraseña. |
| **Contraseña** | Obligatoria al crear, mínimo 6 caracteres. Al editar, déjala en blanco para conservarla. |
| **Rol** | *Administrador* (todo), *Administrador de centros* (documentación, entregas y sus centros) o *Usuario* (solo lectura). |
| **Activo** | Desmarca para bloquear el acceso sin borrar el histórico. |
| **Centros de trabajo** | Marca uno o varios centros a los que tendrá acceso. |

Para cambiar una contraseña de otro usuario: edita su ficha y escribe una nueva; para desactivarle, desmarca **Activo**.

### Empresa (solo administradores)
Nombre y logotipo de la empresa, que aparecen en las hojas y documentos imprimibles.

![Datos de la empresa](img/admin-empresa.png)

---

## 8. Documentación

![Documentación](img/admin-documentacion.png)

Fichas de documentos (hojas de seguridad, procedimientos, manuales) con **URL**, **tipo de ficha** y **centros** donde se usan.

- **＋ Nueva ficha** y **＋ Nuevo tipo**: disponibles para administradores y administradores de centros; el resto de usuarios solo consulta y abre los documentos.
- Las fichas se filtran por centro y por tipo, y se buscan desde la lupa general.

---

## 9. Gestión de informes

![Informes](img/admin-informes.png)

Pestañas: **Dashboard · Informes · Auditoría · Copias de seguridad · Importar CSV**.

### Dashboard
Vista única con toda la fotografía del planta: KPIs (químicos, material, maquinaria, EPIs, **valor del inventario**, consumo de 30 días y alertas), gráficos de dona y barras (origen, caducidad, consumo diario, caducidades por mes, inventario por planta, maquinaria, colores, consumos por zona y entregas) y las tablas de resumen por planta, caducidades próximas y stock bajo mínimo.

- Filtros por **planta** y por **origen** (Fábrica / Empresa).
- **⬇️ CSV** en cada tabla y **🖨️ Imprimir / PDF** para archivarlo.
- **📧 Enviar por correo** (esquina superior derecha): el dashboard **solo se envía si lo pides**; no existe ningún envío automático.

### Informes
Bloques con datos listos para exportar: consumos por zona y subzona, entregas por operario, productos químicos, material por color, maquinaria por tipo, EPIs y ropa de trabajo. Cada bloque lleva su botón **⬇️ CSV** y la página completa **🖨️ Imprimir / PDF**.

### Auditoría
![Auditoría de movimientos](img/admin-auditoria.png)
Historial de todos los movimientos de stock (qué, cuánto, cuándo y quién), con búsqueda y exportación a CSV.

### Copias de seguridad (solo administradores)
Descarga la información introducida **hoja por hoja**, filtrada por centro:

1. Elige el **centro / planta** (o «Todos los centros»).
2. Pulsa **⬇️ Descargar CSV** en la hoja que necesites: químicos, material, maquinaria, EPIs, ropa, estaciones, entradas y salidas, entregas, zonas, subzonas, documentación, usuarios y centros.
3. El archivo se genera **en tu navegador** y se guarda en la carpeta de descargas de **tu ordenador**: no se crea ninguna copia en la nube.

> Las hojas marcadas **Global** (entradas y salidas) no se filtran por centro porque registran movimientos de toda la aplicación. La copia completa de la base de datos se hace desde el servidor con `sh ./scripts/backup-d1.sh` y queda en la carpeta local `backups/` (fuera de la nube y de git).

### Importar CSV (solo administradores)
![Importar CSV](img/admin-importar.png)
1. Pulsa **⬇️ Descargar plantilla** y rellénala con tus datos.
2. Sube el archivo y revisa la vista previa.
3. Confirma la importación. Los errores se señalan fila a fila antes de guardar nada.

---

## 10. Búsqueda global

Escribe en **🔎 Buscar en todo…** (cabecera) al menos 2 letras. Los resultados muestran la categoría (artículo, zona, estación, usuario…) y al pulsarlos te llevan a su ficha o sección.

---

## 11. Mi cuenta

![Mi cuenta](img/admin-cuenta.png)

- **Datos de acceso**: usuario, nombre, email y rol (solo consulta).
- **Cambiar contraseña**: introduce la **contraseña actual** y la **nueva** (mínimo 6 caracteres) dos veces. Al guardar, se cierran las demás sesiones abiertas con tu cuenta.

---

## 12. Roles y permisos de un vistazo

| Sección / acción | Administrador | Administrador de centros | Usuario |
|---|:-:|:-:|:-:|
| Consultar sus secciones (estaciones, entradas y salidas, maquinaria, documentación, informes y manuales) | ✅ | ✅ | ✅ |
| Dar de alta / editar / borrar registros (químicos, material, maquinaria, EPIs, ropa…) | ✅ | — | — |
| Registrar situaciones de maquinaria | ✅ | — | — |
| Gestionar zonas y estaciones | ✅ | — | — |
| Crear/editar usuarios, tipos, tallas e importar CSV | ✅ | — | — |
| Centros, documentación y entregas de equipación | ✅ | ✅ (sus centros) | solo lectura |
| Entradas y salidas de stock | ✅ (registro) | solo lectura | solo lectura |
| Inventario de químicos (entradas, salidas y recuento) | ✅ | solo lectura (puede consultar y imprimir la hoja) | solo lectura (puede consultar y imprimir la hoja) |
| Consumir en modo estación (QR) | ✅ | ✅ | ✅ |
| Descargar CSV / Imprimir PDF de listados e informes | ✅ | ✅ | ❌ |
| Copias de seguridad (descargas por hoja) | ✅ | ❌ | ❌ |
| Enviar el dashboard por correo | ✅ | ❌ | ❌ |
| Secciones visibles en el menú | todas | todas | estaciones de consumo, entradas y salidas, inventario de químicos, maquinaria, documentación, gestión de informes y manuales |
| Cambiar su propia contraseña | ✅ | ✅ | ✅ |

---

## 13. Manuales y ayuda (sección Ayuda)

La sección **Ayuda › Manuales y ayuda** reúne la documentación de la aplicación:

- **📖 Ver en la web**: los dos manuales se leen directamente en el navegador, con índice de apartados para saltar a cada tema.
- **⬇️ Descargar PDF** (solo administradores): el mismo manual en PDF para guardarlo o imprimirlo.
- **💡 Ayuda rápida**: los errores más frecuentes («Failed to fetch», campos en rojo, contraseñas olvidadas…).

Los manuales viven en `docs/manual-administrador.md` y `docs/manual-usuario.md`. Al modificarlos, regenera los PDF con `node make-pdf.mjs` para que la descarga de Ayuda refleje los cambios.

---

## 14. Solución de problemas

| Lo que ves | Causa probable | Solución |
|---|---|---|
| **Failed to fetch** al entrar o al guardar | Sin conexión con el servidor (red, proxy o firewall corporativo) | Comprueba internet, desactiva VPN y recarga. Si persiste, prueba desde otra red o desde el móvil. |
| **Usuario o contraseña incorrectos** | Credenciales que no existen en esa instalación | Usa tu cuenta real; si no la recuerdas, **¿Has olvidado tu contraseña?**. |
| Un campo queda **en rojo** | La validación ha marcado ese campo como obligatorio o inválido | Corrige el campo indicado: el color desaparece al escribir. |
| **Sección restringida 🔒** | Tu rol no tiene permisos sobre esa sección | Pide acceso a un administrador. |
| Te salta a la pantalla de acceso | La sesión ha caducado (dura 7 días) o se ha cerrado desde otro dispositivo | Vuelve a entrar. |
| Los datos no se ven actualizados | Caché del navegador | Recarga con **Ctrl/Cmd + F5**. |
| La app abre pero no carga los datos | El «caparazón» está en caché (funciona sin cobertura) pero la API necesita conexión | Recarga la página con internet disponible. |

---

**Consejos finales**

- Cambia tu contraseña en cuanto recibas la primera.
- Usa el **CSV** de cada listado para pasar datos a Excel; usa **🖨️ Imprimir / PDF** en los informes para la documentación en papel.
- Las estaciones sin consumo durante 30 días aparecen en el panel: revisa si siguen instaladas o si hay que reponer el artículo.
