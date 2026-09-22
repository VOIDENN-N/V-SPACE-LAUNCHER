// API de "Amigos" para el launcher SKY ASHES 2 / V-SPACE.
//
// Qué hace:
// - Cada launcher, apenas se abre (tenga o no sesión de Microsoft iniciada), manda un
//   "heartbeat" acá (POST /api/heartbeat) con: un "id" de instalación (generado una sola
//   vez y guardado localmente, NO es la cuenta de Microsoft), el nickname editable, y si
//   hay sesión: el uuid + nombre premium reales. Esto arma la lista de "todas las personas
//   que tienen el launcher abierto": se registra sola, y aparece aunque el jugador todavía
//   no haya iniciado sesión.
// - GET /api/friends devuelve esa lista a TODOS los launchers (pública, de solo lectura).
//   No incluye a nadie bloqueado.
// - Los endpoints /api/admin/* (bloquear, desbloquear, eliminar) están protegidos con una
//   clave secreta (ADMIN_KEY) que solo vos conocés.
//
// Nota sobre el bloqueo: cada fila es una "instalación del launcher", no directamente una
// cuenta de Microsoft. Si esa instalación YA tiene un uuid de Microsoft asociado, el
// bloqueo se propaga automáticamente a cualquier otra instalación que use la misma cuenta
// (reinstalar no sirve para evadirlo, el uuid no se puede falsificar). Pero si bloqueás a
// alguien que TODAVÍA no inició sesión (sin uuid), podría evadirlo borrando los datos
// locales del launcher (le generaría un id nuevo). Es una limitación inherente a mostrar
// gente en la lista sin exigirles cuenta.
//
// Guarda los datos en Turso (SQLite en la nube, plan gratis SIN expiración).
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ONLINE_WINDOW_SECONDS = parseInt(process.env.ONLINE_WINDOW_SECONDS || '150', 10);

if (!ADMIN_KEY) {
  console.warn('[ADVERTENCIA] No configuraste ADMIN_KEY: los endpoints de administración van a rechazar todo hasta que la configures.');
}
if (!process.env.TURSO_DATABASE_URL) {
  console.warn('[ADVERTENCIA] Falta TURSO_DATABASE_URL: la API no va a poder guardar nada.');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// IMPORTANTE si venís del esquema viejo (players.uuid como PRIMARY KEY): la clave primaria
// ahora es "id" (instalación local), no el uuid de Microsoft, porque necesitamos poder
// mostrar gente que todavía no inició sesión. Si ya tenías la tabla vieja en Turso, borrala
// una vez antes de deployar esta versión (turso db shell <db> "DROP TABLE players;"); se
// vuelve a crear sola y la lista arranca de cero.
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      known_uuid TEXT,
      uuid TEXT,
      name TEXT,
      custom_name TEXT,
      status TEXT NOT NULL DEFAULT 'online',
      last_seen INTEGER NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      banned_reason TEXT,
      first_seen INTEGER NOT NULL
    )
  `);
  // Migración suave para bases creadas con la versión anterior de este mismo esquema nuevo
  // (la que todavía no tenía "known_uuid"). Si la columna ya existe, esto tira un error que
  // ignoramos a propósito.
  try {
    await db.execute('ALTER TABLE players ADD COLUMN known_uuid TEXT');
  } catch (err) { /* la columna ya existía, no pasa nada */ }
  try {
    await db.execute('ALTER TABLE players ADD COLUMN tester INTEGER NOT NULL DEFAULT 0');
  } catch (err) { /* la columna ya existia, no pasa nada */ }
  // Mismo tipo de migración suave para el rol cosmético (nombre + color): antes era
  // puramente local (solo lo veía cada uno de sí mismo), ahora se manda en el heartbeat
  // para que se pueda mostrar en el popover de "Amigos" de todos los demás launchers.
  try {
    await db.execute('ALTER TABLE players ADD COLUMN role_tag TEXT');
  } catch (err) { /* la columna ya existía, no pasa nada */ }
  try {
    await db.execute('ALTER TABLE players ADD COLUMN role_color TEXT');
  } catch (err) { /* la columna ya existía, no pasa nada */ }
}

function computeState(row, now) {
  const isRecent = (now - Number(row.last_seen)) < ONLINE_WINDOW_SECONDS * 1000;
  if (!isRecent) return 'offline';
  return row.status === 'away' ? 'away' : 'online';
}

function toPublicFriend(row, now) {
  return {
    id: row.id,
    // "name" es el apodo editable (lápiz); si nunca lo pusieron, el nombre premium DE LA
    // SESIÓN ACTUAL, y si no hay sesión ahora mismo (deslogueado o nunca logueó), un genérico.
    // OJO: "row.uuid"/"row.name" reflejan la sesión ACTUAL (se limpian al cerrar sesión), a
    // diferencia de "known_uuid" que se usa solo internamente para sostener bloqueos.
    name: row.custom_name || row.name || 'Jugador',
    premiumName: row.name || null,
    uuid: row.uuid || null,
    roleTag: row.role_tag || null,
    roleColor: row.role_color || null,
    state: computeState(row, now), // 'online' | 'away' | 'offline'
    tester: !!row.tester
  };
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true, service: 'sky-ashes-friends-api' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Heartbeat (lo llama cada launcher apenas se abre, con o sin sesión) ----------
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { id, uuid, name, customName, status, roleTag, roleColor } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Falta id.' });
    }
    const now = Date.now();
    const safeStatus = status === 'away' ? 'away' : 'online';
    const safeCustomName = typeof customName === 'string' ? customName.trim().slice(0, 20) : null;
    const safeUuid = typeof uuid === 'string' && uuid ? uuid : null;
    const safeName = typeof name === 'string' && name ? name : null;
    const safeRoleTag = typeof roleTag === 'string' ? roleTag.trim().slice(0, 16) || null : null;
    // Solo aceptamos un hex de color válido (#abc o #aabbcc): así nadie puede meter HTML/CSS
    // arbitrario en un campo que se termina usando como "style.color" en el launcher de todos.
    const safeRoleColor = typeof roleColor === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(roleColor.trim())
      ? roleColor.trim()
      : null;

    const existing = await db.execute({ sql: 'SELECT * FROM players WHERE id = ?', args: [id] });

    // "known_uuid" es la cuenta de Microsoft que ALGUNA VEZ usó esta instalación (se fija
    // una sola vez y nunca se borra, ni al cerrar sesión): sirve para que un bloqueo no se
    // pueda evadir cerrando sesión o reinstalando. "uuid"/"name" en cambio reflejan la
    // SESIÓN ACTUAL nada más, y se limpian al cerrar sesión (por eso "Sin conectar" vuelve
    // a aparecer cuando alguien se desloguea, en vez de quedar pegado el nombre viejo).
    const priorKnownUuid = existing.rows.length ? (existing.rows[0].known_uuid || existing.rows[0].uuid || null) : null;
    const effectiveKnownUuid = priorKnownUuid || safeUuid;

    // Si esta cuenta de Microsoft ya está bloqueada desde OTRA instalación, el bloqueo se
    // hereda acá también.
    let inheritedBan = null;
    if (effectiveKnownUuid) {
      const bannedElsewhere = await db.execute({
        sql: 'SELECT banned, banned_reason FROM players WHERE (known_uuid = ? OR uuid = ?) AND banned = 1 LIMIT 1',
        args: [effectiveKnownUuid, effectiveKnownUuid]
      });
      if (bannedElsewhere.rows.length) inheritedBan = bannedElsewhere.rows[0];
    }

    if (existing.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO players (id, known_uuid, uuid, name, custom_name, status, last_seen, banned, banned_reason, first_seen, role_tag, role_color)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id, effectiveKnownUuid, safeUuid, safeName, safeCustomName, safeStatus, now,
          inheritedBan ? 1 : 0, inheritedBan ? inheritedBan.banned_reason : null, now,
          safeRoleTag, safeRoleColor
        ]
      });
      return res.json({ banned: !!inheritedBan, bannedReason: inheritedBan ? inheritedBan.banned_reason : null });
    }

    const row = existing.rows[0];
    const banned = !!row.banned || !!inheritedBan;
    const bannedReason = row.banned ? row.banned_reason : (inheritedBan ? inheritedBan.banned_reason : null);

    await db.execute({
      sql: `UPDATE players SET known_uuid = ?, uuid = ?, name = ?,
            custom_name = ?, status = ?, last_seen = ?, banned = ?, banned_reason = ?,
            role_tag = ?, role_color = ?
            WHERE id = ?`,
      args: [effectiveKnownUuid, safeUuid, safeName, safeCustomName, safeStatus, now, banned ? 1 : 0, bannedReason, safeRoleTag, safeRoleColor, id]
    });

    return res.json({ banned, bannedReason: bannedReason || null, tester: !!row.tester });
  } catch (err) {
    console.error('Error en /api/heartbeat:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ---------- Lista pública de amigos ----------
app.get('/api/friends', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM players WHERE banned = 0');
    const now = Date.now();
    const friends = result.rows
      .map((row) => toPublicFriend(row, now))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
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
    const result = await db.execute('SELECT * FROM players');
    const now = Date.now();
    const friends = result.rows
      .map((row) => ({
        ...toPublicFriend(row, now),
        banned: !!row.banned,
        bannedReason: row.banned_reason || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    res.json({ friends });
  } catch (err) {
    console.error('Error en /api/admin/friends:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { id, reason } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id.' });
    const row = (await db.execute({ sql: 'SELECT known_uuid, uuid FROM players WHERE id = ?', args: [id] })).rows[0];
    await db.execute({ sql: 'UPDATE players SET banned = 1, banned_reason = ? WHERE id = ?', args: [reason || null, id] });
    // Propaga el bloqueo a cualquier otra instalación que ya haya usado la misma cuenta.
    const targetUuid = row && (row.known_uuid || row.uuid);
    if (targetUuid) {
      await db.execute({ sql: 'UPDATE players SET banned = 1, banned_reason = ? WHERE known_uuid = ? OR uuid = ?', args: [reason || null, targetUuid, targetUuid] });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/ban:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/admin/unban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id.' });
    const row = (await db.execute({ sql: 'SELECT known_uuid, uuid FROM players WHERE id = ?', args: [id] })).rows[0];
    await db.execute({ sql: 'UPDATE players SET banned = 0, banned_reason = NULL WHERE id = ?', args: [id] });
    const targetUuid = row && (row.known_uuid || row.uuid);
    if (targetUuid) {
      await db.execute({ sql: 'UPDATE players SET banned = 0, banned_reason = NULL WHERE known_uuid = ? OR uuid = ?', args: [targetUuid, targetUuid] });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/unban:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// Elimina a alguien de la lista (no lo bloquea: si vuelve a abrir el launcher, reaparece).


app.post('/api/admin/tester', requireAdmin, async (req, res) => {
  try {
    const { id, tester } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id.' });
    const row = (await db.execute({ sql: 'SELECT known_uuid, uuid FROM players WHERE id = ?', args: [id] })).rows[0];
    await db.execute({ sql: 'UPDATE players SET tester = ? WHERE id = ?', args: [tester ? 1 : 0, id] });
    const targetUuid = row && (row.known_uuid || row.uuid);
    if (targetUuid) {
      await db.execute({ sql: 'UPDATE players SET tester = ? WHERE known_uuid = ? OR uuid = ?', args: [tester ? 1 : 0, targetUuid, targetUuid] });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/admin/tester:', err);
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



