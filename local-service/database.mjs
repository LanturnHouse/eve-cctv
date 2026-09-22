import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      character_name TEXT NOT NULL,
      watch_type TEXT NOT NULL CHECK (watch_type IN ('structure', 'gate')),
      enabled INTEGER NOT NULL DEFAULT 1,
      region_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('overview', 'probe', 'dock')),
      x REAL NOT NULL,
      y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      character_name TEXT NOT NULL,
      capture_key TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'pending',
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      watcher_id TEXT REFERENCES watchers(id) ON DELETE SET NULL,
      region_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      confidence REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_time TEXT NOT NULL,
      event_type TEXT NOT NULL,
      character_name TEXT,
      corporation_ticker TEXT,
      ship_name TEXT,
      speed_mps REAL,
      watcher_id TEXT REFERENCES watchers(id) ON DELETE SET NULL,
      confidence REAL,
      image_id INTEGER REFERENCES images(id) ON DELETE CASCADE,
      previous_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS current_objects (
      watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
      identity_key TEXT NOT NULL,
      character_name TEXT NOT NULL,
      ship_name TEXT,
      corporation_ticker TEXT,
      distance_text TEXT,
      speed_mps REAL,
      confidence REAL,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL,
      entry_type TEXT,
      first_seen_at TEXT,
      missing_count INTEGER NOT NULL DEFAULT 0,
      missing_since_at TEXT,
      missing_image_id INTEGER,
      pending_exit_type TEXT,
      pending_exit_reason TEXT,
      last_brightness REAL,
      previous_speed_mps REAL,
      entry_confirmed INTEGER NOT NULL DEFAULT 0,
      entry_previous_image_id INTEGER,
      entry_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      PRIMARY KEY (watcher_id, identity_key)
    );
    CREATE TABLE IF NOT EXISTS current_signatures (
      watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
      signature_id TEXT NOT NULL,
      name TEXT,
      group_name TEXT,
      distance_text TEXT,
      confidence REAL,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watcher_id, signature_id)
    );
    CREATE INDEX IF NOT EXISTS idx_images_folder_capture ON images(folder_path, capture_key DESC);
    CREATE INDEX IF NOT EXISTS idx_images_character_capture ON images(character_name, capture_key DESC);
    CREATE INDEX IF NOT EXISTS idx_images_status_capture ON images(processing_status, capture_key);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time DESC);
    CREATE INDEX IF NOT EXISTS idx_events_watcher_time ON events(watcher_id, event_time DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
      ON events(watcher_id, event_time, event_type, IFNULL(character_name, ''), IFNULL(details_json, ''));
    CREATE INDEX IF NOT EXISTS idx_regions_watcher ON regions(watcher_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_observations_dock_watcher ON observations(watcher_id, image_id) WHERE region_kind = 'dock';
    PRAGMA optimize;
  `);
  const watcherColumns = db.prepare("PRAGMA table_info(watchers)").all();
  if (!watcherColumns.some(column => column.name === "region_version")) {
    db.exec("ALTER TABLE watchers ADD COLUMN region_version INTEGER NOT NULL DEFAULT 1");
  }
  const eventColumns = db.prepare("PRAGMA table_info(events)").all();
  if (!eventColumns.some(column => column.name === "previous_image_id")) {
    db.exec("ALTER TABLE events ADD COLUMN previous_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL");
  }
  const signatureColumns = db.prepare("PRAGMA table_info(current_signatures)").all();
  if (!signatureColumns.some(column => column.name === "missing_count")) {
    db.exec("ALTER TABLE current_signatures ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0");
  }
  const objectColumns = db.prepare("PRAGMA table_info(current_objects)").all();
  const objectMigrations = [
    ["entry_type", "ALTER TABLE current_objects ADD COLUMN entry_type TEXT"],
    ["first_seen_at", "ALTER TABLE current_objects ADD COLUMN first_seen_at TEXT"],
    ["missing_count", "ALTER TABLE current_objects ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0"],
    ["missing_since_at", "ALTER TABLE current_objects ADD COLUMN missing_since_at TEXT"],
    ["missing_image_id", "ALTER TABLE current_objects ADD COLUMN missing_image_id INTEGER"],
    ["pending_exit_type", "ALTER TABLE current_objects ADD COLUMN pending_exit_type TEXT"],
    ["pending_exit_reason", "ALTER TABLE current_objects ADD COLUMN pending_exit_reason TEXT"],
    ["last_brightness", "ALTER TABLE current_objects ADD COLUMN last_brightness REAL"],
    ["previous_speed_mps", "ALTER TABLE current_objects ADD COLUMN previous_speed_mps REAL"],
    ["entry_confirmed", "ALTER TABLE current_objects ADD COLUMN entry_confirmed INTEGER NOT NULL DEFAULT 0"],
    ["entry_previous_image_id", "ALTER TABLE current_objects ADD COLUMN entry_previous_image_id INTEGER"],
    ["entry_event_id", "ALTER TABLE current_objects ADD COLUMN entry_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL"],
  ];
  const hadEntryConfirmed = objectColumns.some(column => column.name === "entry_confirmed");
  for (const [name, sql] of objectMigrations) {
    if (!objectColumns.some(column => column.name === name)) db.exec(sql);
  }
  if (!hadEntryConfirmed) {
    // Ships already being tracked before this migration have no recorded "first
    // sighting speed" to compare against — treat them as already-confirmed with
    // whatever entry_type they already have, rather than misreading their current
    // stored speed as a fresh first sighting on their next update.
    db.exec("UPDATE current_objects SET entry_confirmed = 1 WHERE entry_confirmed = 0");
  }

  const getSettingStatement = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStatement = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);

  return {
    db,
    getSetting(key, fallback = null) {
      const row = getSettingStatement.get(key);
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },
    setSetting(key, value) {
      setSettingStatement.run(key, JSON.stringify(value));
    },
    listWatchers() {
      const watchers = db.prepare(`
        SELECT id, label, character_name AS character, watch_type AS watchType, enabled,
               region_version AS regionVersion
        FROM watchers ORDER BY created_at
      `).all();
      const regionStatement = db.prepare(`
        SELECT kind, x, y, width AS w, height AS h
        FROM regions WHERE watcher_id = ? ORDER BY sort_order
      `);
      return watchers.map((watcher) => ({
        ...watcher,
        enabled: Boolean(watcher.enabled),
        regions: regionStatement.all(watcher.id),
      }));
    },
    listDockPeaks() {
      return db.prepare(`
        SELECT watcherId, watcherLabel, peakCount, capturedAt, imageId, observationId, filename
        FROM (
          SELECT w.id AS watcherId, w.label AS watcherLabel,
                 json_extract(o.payload_json, '$.fields.dockCount') AS peakCount,
                 i.captured_at AS capturedAt, i.id AS imageId, o.id AS observationId, i.filename,
                 ROW_NUMBER() OVER (
                   PARTITION BY w.id
                   ORDER BY json_extract(o.payload_json, '$.fields.dockCount') DESC,
                            i.capture_key DESC, o.id DESC
                 ) AS peakRank
          FROM observations o
          JOIN watchers w ON w.id = o.watcher_id
          JOIN images i ON i.id = o.image_id
          WHERE w.watch_type = 'structure' AND w.enabled = 1 AND o.region_kind = 'dock'
            AND json_type(o.payload_json, '$.fields.dockCount') = 'integer'
            AND json_extract(o.payload_json, '$.fields.dockCount') >= 0
        ) WHERE peakRank = 1
        ORDER BY peakCount DESC, capturedAt DESC, watcherLabel
      `).all();
    },
    saveWatcher(watcher) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db.prepare("SELECT character_name AS character FROM watchers WHERE id = ?").get(watcher.id);
        if (previous && previous.character !== watcher.character) {
          db.prepare("DELETE FROM events WHERE watcher_id = ?").run(watcher.id);
          db.prepare("DELETE FROM observations WHERE watcher_id = ?").run(watcher.id);
          db.prepare("DELETE FROM current_objects WHERE watcher_id = ?").run(watcher.id);
          db.prepare("DELETE FROM current_signatures WHERE watcher_id = ?").run(watcher.id);
        }
        db.prepare(`
          INSERT INTO watchers (id, label, character_name, watch_type, enabled, region_version, updated_at)
          VALUES (?, ?, ?, ?, ?, 2, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            character_name = excluded.character_name,
            watch_type = excluded.watch_type,
            enabled = excluded.enabled,
            region_version = 2,
            updated_at = CURRENT_TIMESTAMP
        `).run(watcher.id, watcher.label, watcher.character, watcher.watchType, watcher.enabled === false ? 0 : 1);
        db.prepare("DELETE FROM regions WHERE watcher_id = ?").run(watcher.id);
        const insertRegion = db.prepare(`
          INSERT INTO regions (watcher_id, kind, x, y, width, height, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        watcher.regions.forEach((region, index) => {
          insertRegion.run(watcher.id, region.kind, region.x, region.y, region.w, region.h, index);
        });
        db.prepare("DELETE FROM events WHERE watcher_id IN (SELECT id FROM watchers WHERE character_name = ?)").run(watcher.character);
        db.prepare("DELETE FROM observations WHERE watcher_id IN (SELECT id FROM watchers WHERE character_name = ?)").run(watcher.character);
        db.prepare("DELETE FROM current_objects WHERE watcher_id IN (SELECT id FROM watchers WHERE character_name = ?)").run(watcher.character);
        db.prepare("DELETE FROM current_signatures WHERE watcher_id IN (SELECT id FROM watchers WHERE character_name = ?)").run(watcher.character);
        db.prepare("UPDATE images SET processing_status = 'pending' WHERE character_name = ?").run(watcher.character);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    deleteWatcher(watcherId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const watcher = db.prepare("SELECT character_name AS character FROM watchers WHERE id = ?").get(watcherId);
        if (!watcher) throw new Error("삭제할 감시 클라이언트를 찾을 수 없습니다.");
        db.prepare("DELETE FROM events WHERE watcher_id = ?").run(watcherId);
        db.prepare("DELETE FROM observations WHERE watcher_id = ?").run(watcherId);
        db.prepare("DELETE FROM current_objects WHERE watcher_id = ?").run(watcherId);
        db.prepare("DELETE FROM current_signatures WHERE watcher_id = ?").run(watcherId);
        db.prepare("DELETE FROM watchers WHERE id = ?").run(watcherId);
        db.exec("COMMIT");
        return watcher;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    resetDerivedData() {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM events");
        db.exec("DELETE FROM observations");
        db.exec("DELETE FROM current_objects");
        db.exec("DELETE FROM current_signatures");
        db.exec("DELETE FROM images");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getNextPendingImage() {
      return db.prepare(`
        SELECT i.id, i.file_path AS filePath, i.filename, i.character_name AS character,
               i.capture_key AS captureKey, i.captured_at AS capturedAt
        FROM images i
        WHERE i.processing_status = 'pending'
          AND EXISTS (
            SELECT 1 FROM watchers w
            WHERE w.character_name = i.character_name AND w.enabled = 1 AND w.region_version >= 2
          )
        ORDER BY i.capture_key
        LIMIT 1
      `).get();
    },
    getWatcherRegions(character) {
      return db.prepare(`
        SELECT w.id AS watcherId, w.label AS watcherLabel, w.watch_type AS watchType,
               r.kind, r.x, r.y, r.width AS w, r.height AS h, r.sort_order AS sortOrder
        FROM watchers w
        JOIN regions r ON r.watcher_id = w.id
        WHERE w.character_name = ? AND w.enabled = 1 AND w.region_version >= 2
        ORDER BY w.created_at, r.sort_order
      `).all(character);
    },
    completeImage(imageId, observations) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM observations WHERE image_id = ?").run(imageId);
        const insert = db.prepare(`
          INSERT INTO observations (image_id, watcher_id, region_kind, payload_json, confidence)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const observation of observations) {
          insert.run(imageId, observation.watcherId, observation.kind, JSON.stringify(observation.payload), observation.confidence);
        }
        db.prepare("UPDATE images SET processing_status = 'processed' WHERE id = ?").run(imageId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    failImage(imageId, message) {
      db.prepare("UPDATE images SET processing_status = 'failed' WHERE id = ?").run(imageId);
      setSettingStatement.run(`imageError:${imageId}`, JSON.stringify(message));
    },
  };
}
