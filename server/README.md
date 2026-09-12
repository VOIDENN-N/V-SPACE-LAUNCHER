# API de Amigos (SKY ASHES 2 / V-SPACE)

Esta carpeta es un servidor chico, separado del launcher, que guarda "quién tiene el
launcher" y expone la lista de amigos. Se despliega gratis en **Render**; los datos se
guardan en **Turso** (SQLite en la nube, plan gratis que no expira — la Postgres gratis
de Render sí expira a los 30 días, por eso no se usó acá).

No hace falta tocar código para usar esto: solo seguir los pasos.

## 1. Crear la base de datos en Turso (gratis, no expira)

1. Entrá a https://turso.tech y creá una cuenta gratis (podés entrar con GitHub).
2. Desde el dashboard, creá una base de datos nueva (botón **Create Database**). Ponele
   un nombre, por ejemplo `sky-ashes-amigos`.
3. Una vez creada, buscá:
   - La **URL** de conexión (empieza con `libsql://...`).
   - Un **token de acceso** (generalo desde la sección "Tokens" de esa base si no te lo
     muestra directo — tiene que ser un token con permiso de lectura/escritura).
4. Guardá esos dos valores, los vas a necesitar en el paso 3.

## 2. Subir esta carpeta a GitHub

Render despliega desde un repositorio de GitHub. Si todo el launcher ya está en un repo
(como parece por el `config.json`, ej. `VOIDENN-N/V-SPACE-LAUNCHER` o similar), alcanza
con subir esta carpeta `server/` tal cual dentro de ese mismo repo y hacer push.

Si preferís separarlo, también podés crear un repo nuevo solo con el contenido de esta
carpeta `server/`.

## 3. Crear el servicio en Render

1. Entrá a https://render.com y creá una cuenta gratis (no pide tarjeta).
2. **New +** → **Web Service** → conectá tu repo de GitHub.
3. Configurá:
   - **Root Directory**: `server` (si subiste todo el launcher junto en un repo) o vacío
     (si el repo es solo esta carpeta).
   - **Runtime**: Node.
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**.
4. En la sección **Environment**, agregá estas variables (con tus valores reales):
   - `TURSO_DATABASE_URL` → la URL que copiaste de Turso.
   - `TURSO_AUTH_TOKEN` → el token que copiaste de Turso.
   - `ADMIN_KEY` → inventá una clave larga y secreta (ej. generá una random). Es la
     "contraseña" que vas a poner en tu propio launcher para poder bloquear gente.
   - `ONLINE_WINDOW_SECONDS` → opcional, `150` por defecto.
5. Creá el servicio. Cuando termine el deploy, Render te va a dar una URL pública, algo
   como `https://sky-ashes-friends-api.onrender.com`.

## 4. Conectar el launcher a esta API

Editá `config.json` (la raíz del proyecto del launcher, NO esta carpeta) y completá:

```json
"friendsApiUrl": "https://sky-ashes-friends-api.onrender.com"
```

(sin la barra `/` al final). Con eso el launcher ya va a:
- Registrar a cada jugador que inicia sesión (heartbeat automático).
- Mostrar la lista de amigos en el panel derecho.
- Bloquear el login de cualquiera que vos hayas bloqueado.

## 5. Usar el panel de administrador (bloquear / eliminar gente)

En **tu propio launcher** (el tuyo, no el de tus amigos): abrí Configuración → sección
"Administración" → pegá ahí el mismo valor que pusiste en `ADMIN_KEY` en Render, y
guardá. A partir de ahí, en la lista de Amigos te van a aparecer botones para bloquear
o eliminar a cada persona. Nadie más va a ver esos botones a menos que también tenga esa
clave — no la compartas.

## Importante: el plan gratis de Render "duerme"

Los servicios gratis de Render se apagan solos después de 15 minutos sin uso y tardan
~1 minuto en despertar con el primer pedido. Es normal que la primera vez que alguien
abre el launcher en el día, la lista de amigos tarde unos segundos en aparecer (el
launcher ya maneja esto sin romperse: si la API no responde a tiempo, simplemente no
bloquea a nadie y reintenta más tarde). Esto NO afecta la base de datos de Turso, que
sigue intacta siempre.
