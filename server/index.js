// API de "Amigos" para el launcher SKY ASHES 2 / V-SPACE.
//
// Qué hace:
// - Cada launcher, mientras hay sesión de Microsoft iniciada, manda un "heartbeat" acá
//   (POST /api/heartbeat) con el uuid y nombre premium del jugador. Esto es lo que arma
//   la lista de "todas las personas que tienen el launcher": se registra sola, nadie
//   agrega ni saca amigos a mano.
// - GET /api/friends devuelve esa lista a TODOS los launchers (pública, de solo lectura).
//   No incluye a nadie bloqueado.
// - Los endpoints /api/admin/* (bloquear, desbloquear, eliminar) están protegidos con una
//   clave secreta (ADMIN_KEY) que solo vos conocés. Un jugador bloqueado deja de poder
//   loguearse/jugar (el launcher corta el login) y desaparece de la lista pública.
//
// Guarda los datos en Turso (SQLite en la nube, plan gratis SIN expiración), para que
// sobreviva a los reinicios/deploys de Render sin perder la lista cada 30 días como
// pasaría con la Postgres gratis de Render.
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// Ventana de "en línea": si el último heartbeat de alguien fue hace menos de esto, se
// muestra como online. El launcher manda un heartbeat cada 60s mientras está abierto
// (ver src/main.js), así que 150s da margen de sobra sin que parpadee entre online/offline.
const ONLINE_WINDOW_SECONDS = parseInt(process.env.ONLINE_WINDOW_SECONDS || '150', 10);

if (!ADMIN_KEY) {
  console.warn('[ADVERTENCIA] No configuraste ADMIN_KEY como variable de entorno: ' +
    'los endpoints de administración van a rechazar TODOS los pedidos hasta que la configures.');
}
if (!process.env.TURSO_DATABASE_URL) {
  console.warn('[ADVERTENCIA] Falta TURSO_DATABASE_URL: la API no va a poder guardar nada.');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS players (
      uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      banned_reason TEXT,
      first_seen INTEGER NOT NULL
    )
  `);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true, service: 'sky-ashes-friends-api' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Heartbeat (lo llama cada launcher con sesión activa) ----------
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { uuid, name } = req.body || {};
    if (!uuid || !name || typeof uuid !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ error: 'Falta uuid o name.' });
    }
    const now = Date.now();

    const existing = await db.execute({
      sql: 'SELECT banned, banned_reason FROM players WHERE uuid = ?',
      args: [uuid]
    });

    if (existing.rows.length === 0) {
      await db.execute({
        sql: 'INSERT INTO players (uuid, name, last_seen, banned, first_seen) VALUES (?, ?, ?, 0, ?)',
        args: [uuid, name, now, now]
      });
      return res.json({ banned: false });
    }

    // Actualiza nombre (por si cambió el nombre de Minecraft) y last_seen siempre,
    // pero NO toca el estado de baneo: eso solo lo cambia un admin.
    await db.execute({
      sql: 'UPDATE players SET name = ?, last_seen = ? WHERE uuid = ?',
      args: [name, now, uuid]
    });

    const row = existing.rows[0];
    return res.json({
      banned: !!row.banned,
      bannedReason: row.banned_reason || null
    });
  } catch (err) {
    console.error('Error en /api/heartbeat:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ---------- Lista pública de amigos ----------
app.get('/api/friends', async (req, res) => {
  try {
    const result = await db.execute('SELECT uuid, name, last_seen FROM players WHERE banned = 0 ORDER BY name COLLATE NOCASE ASC');
    const now = Date.now();
    const friends = result.rows.map((row) => ({
      uuid: row.uuid,
      name: row.name,
      online: (now - Number(row.last_seen)) < ONLINE_WINDOW_SECONDS * 1000
    }));
    res.json({ friends });
  } catch (err) {
    console.error('Error en /api/friends:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ---------- Middleware de admin ----------
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Clave de administrador inválida.' });
  }
  next();
}

// Lista completa para el panel de admin (incluye bloqueados)
app.get('/api/admin/friends', requireAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT uuid, name, last_seen, banned, banned_reason FROM players ORDER BY name COLLATE NOCASE ASC');
    const now = Date.now();
    const friends = result.rows.map((row) => ({
      uuid: row.uuid,
      name: row.name,
      online: (now - Number(row.last_seen)) < ONLINE_WINDOW_SECONDS * 1000,
      banned: !!row.banned,
      bannedReason: row.banned_reason || null
    }));
    res.json({ friends });
  } catch (err) {
    console.error('Error en /api/admin/friends:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { uuid, reason } = req.body || {};
    if (!uuid) return res.status(400).json({ error: 'Falta uuid.' });
    await db.execute({
      sql: 'UPDATE players SET banned = 1, banned_reason = ? WHERE uuid = ?',
      args: [reason || null, uuid]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/ban:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/admin/unban', requireAdmin, async (req, res) => {
  try {
    const { uuid } = req.body || {};
    if (!uuid) return res.status(400).json({ error: 'Falta uuid.' });
    await db.execute({
      sql: 'UPDATE players SET banned = 0, banned_reason = NULL WHERE uuid = ?',
      args: [uuid]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/unban:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// Elimina a alguien de la lista (no lo bloquea: si vuelve a loguearse, reaparece).
// Útil para limpiar cuentas de prueba, gente que ya no juega, etc.
app.post('/api/admin/delete', requireAdmin, async (req, res) => {
  try {
    const { uuid } = req.body || {};
    if (!uuid) return res.status(400).json({ error: 'Falta uuid.' });
    await db.execute({ sql: 'DELETE FROM players WHERE uuid = ?', args: [uuid] });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/delete:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`sky-ashes-friends-api escuchando en puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
