# Descarga de imágenes (extensión Chromium MV3)

Descarga cualquier imagen de una página sin abrir el inspector: al activar la extensión en una
pestaña, pasa el ratón sobre una imagen y aparece un chip con **Descargar** y un **check** para
seleccionarla. Con varias seleccionadas, la barra flotante las descarga como **archivos sueltos**
en una subcarpeta de Descargas o como **un único ZIP**.

Funciona en Chrome, Edge y Brave (Manifest V3, Chrome 116 o superior). Sin dependencias en tiempo
de ejecución, sin paso de compilación.

## Instalación (sin empaquetar)
1. Abre `chrome://extensions` y activa **Modo de desarrollador** (arriba a la derecha).
2. Pulsa **Cargar descomprimida** y elige esta carpeta (`descarga-imagenes`).
3. Fija el icono en la barra (icono de puzle → chincheta) para tenerlo a mano.

Al cargarla, Chrome avisa de que puede «leer y cambiar todos los datos de los sitios web»: es el
permiso `<all_urls>` (más `scripting`, `downloads`, `offscreen`, `storage` y
`declarativeNetRequestWithHostAccess`, que no añade avisos) que necesita para descargar imágenes
de CDNs y de iframes de otro origen, montar el ZIP y enviar el Referer en sitios anti-hotlink.

## Uso
- **Activar/desactivar** en la pestaña actual: clic en el icono o `Alt+Shift+D`
  (`Ctrl+Shift+D` en Mac). El badge muestra `ON`. `Esc` desactiva (también con el foco en la barra).
- **Descargar una imagen**: pasa el ratón por encima y pulsa el botón de descarga del chip.
- **Seleccionar varias**: marca el check del chip en cada imagen (anillo y badge sobre las
  seleccionadas); abajo aparece la barra con «N seleccionadas», **Limpiar**,
  **Descargar archivos (N)**, **Descargar ZIP (N)** y **Salir (Esc)**. Durante un lote la barra
  muestra el progreso y **Cancelar**; por encima de 300 archivos o 1 GB pide confirmación.
- **Teclado**: `Tab` llega a la barra (una sola parada: es una `toolbar`, y `←`/`→`,
  `Inicio`/`Fin` recorren sus botones) y al chip mientras el puntero está sobre una imagen (con el
  foco dentro, el chip no desaparece aunque el puntero se vaya); `Enter`/`Espacio` activan, `Esc`
  sale. Los cambios de recuento y el progreso se anuncian en una región `aria-live`; hay estilos
  para alto contraste (`forced-colors`) y para `prefers-reduced-motion`.
- Cambiar el atajo: `chrome://extensions/shortcuts`.

Detecta `<img>` (con `srcset`, `<picture>` y atributos lazy como `data-src`), fondos CSS
(`background-image`, `::before/::after`), imágenes en shadow DOM, pósteres de `<video>`, `<svg>`
inline, `<canvas>` y URLs `data:`/`blob:`; descarta píxeles de seguimiento, spacers y
placeholders.

### Dónde se guardan
- Una imagen: `Descargas/Imagenes/<sitio>/<nombre>.<ext>`
- Lote de archivos sueltos: `Descargas/Imagenes/<sitio>_<AAAAMMDD-HHmm>/…`
- ZIP: `Descargas/Imagenes/<sitio>_<AAAAMMDD-HHmm>.zip` (dentro, `_fallidas.txt` lista las que no
  se pudieron incluir; esas se intentan descargar sueltas en la carpeta del lote).

`<sitio>` es el host sin `www.`; los nombres se sanean según las reglas de Chromium, siempre llevan
extensión y se deduplican con ` (2)`, ` (3)`…

### Avisos y límites conocidos
- Si en Chrome tienes activado **«Preguntar dónde guardar cada archivo antes de descargarlo»**
  (`chrome://settings/downloads`), el modo de archivos sueltos abrirá un diálogo por archivo. No
  hay forma de evitarlo desde una extensión: desactívalo o usa ZIP (un solo diálogo).
- Si el servidor rechaza la descarga directa (403 anti-hotlink, HTML en vez de imagen, error de
  red), la extensión reintenta obteniendo los bytes por su cuenta (con las cookies del sitio y,
  mediante una regla temporal de `declarativeNetRequest`, con el Referer de la página, p. ej. en
  Pixiv); si tampoco puede, lo avisa con un toast y ofrece **Copiar URL**.
- Lienzos (`<canvas>`) contaminados por CORS no se pueden exportar («Lienzo protegido»); los SVG
  inline se exportan «lo mejor posible» (con los `<symbol>` referenciados, sin el CSS de la página);
  los `blob:` ya revocados se recodifican a PNG desde la imagen decodificada.
- Cada imagen de tipo `blob:`/`canvas`/`svg` se transfiere en base64 y está limitada a 32 MB; el
  ZIP (formato STORE, sin ZIP64) admite hasta 65 535 entradas y ~4 GB.
- No hay navegación entre imágenes solo con teclado: el chip aparece al pasar el puntero (ratón o
  trackpad) sobre una imagen; sin puntero, `Tab` solo alcanza la barra.
- Páginas internas (`chrome://`), la tienda de extensiones y el visor PDF no admiten
  extensiones: el badge muestra `!`.
- En ventanas de incógnito la extensión no está probada.

## Desarrollo y pruebas
Requiere Node 22 o superior (probado con Node 26) y `npm install` (instala Playwright como
dependencia de desarrollo; los e2e usan su Chromium propio en modo headless con la extensión
cargada contra un servidor de páginas de prueba local). Para validar los ZIP hacen falta `unzip`
y `python3` en el PATH.

```bash
npm run test:unit        # módulos puros (lib/) y fixtures con node --test
npm run test:e2e         # extensión real en Chromium (un navegador por archivo, en serie)
npm test                 # ambas
npm run test:e2e:large   # opcional (E2E_LARGE=1): ZIP grande con PNG incompresibles
```

Estructura: `lib/` (módulos puros compartidos por content script, service worker, offscreen y
Node: textos, URLs, umbrales, nombres, escritor ZIP, pool), `content/` (resolución y detección por
hover, overlay en shadow DOM cerrado dentro del top layer, selección por marco, controlador),
`background/` (service worker: activación por pestaña, escalera de descarga, lotes y ZIP, cliente
del documento offscreen), `offscreen/` (descarga de bytes y ensamblado del ZIP) y `test/`
(`unit/`, `e2e/` con Playwright, `fixtures/` con el servidor y las páginas `pages/*.html`, cuyos
comentarios `<!-- expect -->` documentan lo que se espera de cada elemento).

Todos los textos visibles viven en `lib/strings.js`; los tests comparan contra esas cadenas.

### Comprobación manual (lo que Playwright no puede hacer)
- Clic real en el icono y `Alt+Shift+D` (`Ctrl+Shift+D` en Mac) alternan el badge `ON`; un
  doble clic rápido no deja la pestaña en un estado incoherente.
- En `chrome://` o en la tienda el badge muestra `!` y el título del icono lo explica.
- Sitios reales: un feed tipo Instagram/Pinterest (imágenes bajo capas transparentes y scroll
  virtualizado: la selección sobrevive al re-renderizado), un blog de WordPress con lazyload, un
  «hero» con imagen de fondo CSS, una galería modal (`<dialog>`: el chip sigue siendo clicable
  dentro del modal) y un sitio con modo oscuro por `filter: invert(1)`.
- Recargar la extensión en `chrome://extensions` con una pestaña activa: el script huérfano se
  desmonta solo y no deja errores en la consola de la página ni del service worker.
- ZIP de ~200 imágenes con `chrome://blob-internals` y el Administrador de tareas abiertos: el
  documento offscreen se cierra a los ~10 s de terminar y no quedan blobs retenidos.
- Con «Preguntar dónde guardar cada archivo» activado: un diálogo por archivo en modo sueltos y
  uno solo para el ZIP.
- Teclado y accesibilidad: `Tab` desde el final de la página llega a la barra (una sola parada),
  `←`/`→` recorren sus botones, `Enter` en **Limpiar** vacía la selección y `Esc` sale; con un
  lector de pantalla se oye «N seleccionadas»; con alto contraste del sistema activado el chip y la
  barra siguen visibles.
- Ventana de incógnito (si se permite la extensión en incógnito): activar, descargar una imagen y
  un ZIP.
