function parsePayload(row) {
  try { return JSON.parse(row.payload_json || row.payload); } catch { return {}; }
}

function normalizeIdentity(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

// Sustained sub-warp speed rarely exceeds a few thousand m/s even with an
// afterburner; anything above this is effectively always warp (the only real
// exception is an ab-fit frigate stacking speed implants, which is rare
// enough to accept as noise).
const WARP_SPEED_THRESHOLD_MPS = 10_000;

// Hulls that can fit a Covert Ops Cloaking Device II. Warp-in/undock and
// warp-out/dock look identical to overview-based detection for these ships —
// they can warp cloaked, so the "entered at warp speed" vs "just undocked"
// distinction isn't meaningful — so instead of guessing, every appearance/
// disappearance for one of these hulls is reported as a single covop_in /
// covop_out pair. Strategic Cruisers (Tengu/Legion/Proteus/Loki) and Deep
// Space Transports are deliberately left out: their covert capability depends
// on the fitted subsystem, which isn't visible from the overview, so they
// stay classified normally rather than risk a wrong guess.
const COVERT_OPS_SHIPS = new Set([
  // Covert Ops frigates
  "ANATHEMA", "BUZZARD", "HELIOS", "CHEETAH",
  // Stealth Bombers
  "PURIFIER", "MANTICORE", "NEMESIS", "HOUND",
  // Force Recon cruisers
  "PILGRIM", "FALCON", "ARAZU", "RAPIER",
  // Blockade Runners
  "PROWLER", "CRANE", "VIATOR", "PRORATOR",
  // Black Ops battleships
  "REDEEMER", "WIDOW", "SIN", "PANTHER",
  // Sisters of EVE exploration ship — bonused for Covert Ops Cloaking Device
  "ASTERO",
  // ORE covert mining frigate — bonused for Covert Ops Cloaking Device
  "PROSPECT",
  // CONCORD ship
  "PACIFIER",
  // User-confirmed covert-capable hull
  "METAMORPHOSIS",
]);

function isCovertOpsShip(shipName) {
  return COVERT_OPS_SHIPS.has(String(shipName || "").trim().replace(/\*+$/, "").toUpperCase());
}

function cleanShipName(value) {
  const raw = String(value || "").trim();
  // A punctuation mark in the overview's type column is OCR bleed, often
  // followed by digits (e.g. "Zealot=*5"). Dropping punctuation alone would
  // turn that into a different ship, "Zealot5".
  const artifactAt = raw.search(/[^\p{L}\p{N}\s]/u);
  return (artifactAt < 0 ? raw : raw.slice(0, artifactAt)).replace(/\s+/g, " ").trim();
}

// The overview also contains celestials and anchored objects. Their name
// column is not a pilot name, so they must never enter the ship state machine.
// Match the type column, not the name: a player may name their character after
// a structure, and Sunesis is a real ship (not a Sun row).
const NON_PILOT_OVERVIEW_TYPES = /^(?:WORMHOLE|STARGATE|ASTRAHUS|FORTIZAR|KEEPSTAR|RAITARU|AZBEL|SOTIYO|ATHANOR|TATARA|PHAROLYNX|TENEBREX|ANSIBLEX|METENOX MOON DRILL|ORBITAL SKYHOOK|CONTROL TOWER|CUSTOMS OFFICE|MOBILE DEPOT|MOBILE TRACTOR UNIT)(?:\b|\*)/i;
// OCR can collapse "Sun K5" into "SunK5" or misread it as "SunKS5".
// Recognize the spectral-class prefix, but do not swallow the Sunesis ship.
const SUN_TYPE = /^SUN\s*[OBAFGKM][0-9S]{1,2}(?:\b|\*)|^SUN\b/i;

function isPilotOverviewRow(row) {
  const type = String(row.ship || "").trim();
  return Boolean(row.name) && !SUN_TYPE.test(type) && !NON_PILOT_OVERVIEW_TYPES.test(type);
}

function trackableOverviewRows(observations) {
  return observations.flatMap(observation => {
    const payload = observation.payload || {};
    // A missed speed reading does not mean the character left the overview.
    return (payload.fields?.overviewRows || [])
      .map(row => ({ ...row, ship:cleanShipName(row.ship), speed: Number.isFinite(row.speed) ? row.speed : null }))
      .filter(isPilotOverviewRow);
  });
}

function probeRows(observations) {
  return observations.flatMap(observation => observation.payload?.fields?.signatures || []);
}

function dockReadings(observations) {
  const dockObservations = observations.filter(observation => observation.kind === "dock");
  const readings = new Map();
  for (let index = 0; index < dockObservations.length; index += 1) {
    const observation = dockObservations[index];
    const count = observation.payload?.fields?.dockCount;
    if (!Number.isSafeInteger(count) || count < 0) return null;
    const regionIndex = observation.payload?.regionIndex;
    readings.set(Number.isInteger(regionIndex) ? regionIndex : index, count);
  }
  return readings.size === dockObservations.length && readings.size ? readings : null;
}

function dockCounterChange(currentObservations, previousObservations) {
  const current = dockReadings(currentObservations);
  const previous = dockReadings(previousObservations);
  if (!current || !previous || current.size !== previous.size) return null;
  const changes = [];
  for (const [regionIndex, count] of current) {
    if (!previous.has(regionIndex)) return null;
    if (count !== previous.get(regionIndex)) changes.push({regionIndex,before:previous.get(regionIndex),after:count,delta:count-previous.get(regionIndex)});
  }
  // Two changing counters have no reliable mapping back to one overview row.
  return changes.length === 1 ? changes[0] : null;
}

function previousObservations(db, watcherId, captureKey) {
  const previousImage = db.prepare(`
    SELECT i.id
    FROM images i
    JOIN observations o ON o.image_id = i.id
    WHERE o.watcher_id = ? AND i.capture_key < ? AND i.processing_status = 'processed'
    GROUP BY i.id, i.capture_key
    ORDER BY i.capture_key DESC
    LIMIT 1
  `).get(watcherId, captureKey);
  if (!previousImage) return { imageId: null, observations: [] };
  const observations = db.prepare(`
    SELECT region_kind AS kind, payload_json, confidence
    FROM observations WHERE image_id = ? AND watcher_id = ? ORDER BY id
  `).all(previousImage.id, watcherId).map(row => ({
    kind: row.kind,
    payload: parsePayload(row),
    confidence: row.confidence,
  }));
  return { imageId: previousImage.id, observations };
}

function insertEvent(db, event) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO events
      (event_time, event_type, character_name, corporation_ticker, ship_name, speed_mps,
       watcher_id, confidence, image_id, previous_image_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.time,
    event.type,
    event.character || null,
    event.corporation || null,
    event.ship || null,
    Number.isFinite(event.speed) ? event.speed : null,
    event.watcherId,
    event.confidence ?? null,
    event.imageId,
    event.previousImageId ?? null,
    JSON.stringify(event.details || {}),
  );
  return result.changes ? Number(result.lastInsertRowid) : null;
}

function reviseEntryEvent(db, eventId, event) {
  if (!eventId) return false;
  const result = db.prepare(`
    UPDATE events SET event_type = ?, ship_name = ?, speed_mps = ?,
      image_id = ?, previous_image_id = ?, details_json = ?
    WHERE id = ?
  `).run(
    event.type, event.ship || null, Number.isFinite(event.speed) ? event.speed : null,
    event.imageId, event.previousImageId ?? null, JSON.stringify(event.details || {}), eventId,
  );
  return result.changes > 0;
}

const DOCK_CONFIRM_FRAMES = 2;
const DOCK_CONFIRM_WINDOW_MS = 10_000;

function reconcileDockTransitions(db, watcherId, image, currentObservations, previousObservations) {
  const pending = db.prepare(`
    SELECT id, event_time AS time, event_type AS type, image_id AS imageId,
           previous_image_id AS previousImageId, details_json AS detailsJson
    FROM events WHERE watcher_id = ? AND json_extract(details_json, '$.dockPending') IS NOT NULL
    ORDER BY event_time, id
  `).all(watcherId).map(row => ({...row, details:JSON.parse(row.detailsJson)}));
  if (!pending.length) return;

  const update = db.prepare(`
    UPDATE events SET event_type = ?, image_id = ?, previous_image_id = ?, details_json = ? WHERE id = ?
  `);
  const save = (event, type, details, imageId = event.imageId, previousImageId = event.previousImageId) => {
    update.run(type,imageId,previousImageId,JSON.stringify(details),event.id);
  };
  const eligible = pending.filter(event => {
    const elapsed = Date.parse(image.capturedAt) - Date.parse(event.time);
    return elapsed >= 0 && elapsed <= DOCK_CONFIRM_WINDOW_MS && Number(event.details.dockFrames || 0) <= DOCK_CONFIRM_FRAMES;
  });
  const change = dockCounterChange(currentObservations,previousObservations);
  const entries = eligible.filter(event => event.details.dockPending === "entry");
  const exits = eligible.filter(event => event.details.dockPending === "exit");
  const blockers = eligible.filter(event => event.details.dockPending === "entry_blocker" || event.details.dockPending === "exit_blocker");
  const confirmed = new Set();
  const matches = change?.delta < 0 ? entries : change?.delta > 0 ? exits : [];
  if (change && matches.length === Math.abs(change.delta) && matches.length > 0 && blockers.length === 0
      && !(entries.length && exits.length)) {
    for (const event of matches) {
      const details = {...event.details,verification:"confirmed",
        reason:change.delta < 0 ? "overview_added_with_dock_decrease" : "overview_removed_with_dock_increase",
        dockCountBefore:change.before,dockCountAfter:change.after,dockRegionIndex:change.regionIndex,
        transitionImageId:event.imageId,confirmedImageId:image.id};
      delete details.dockPending;
      delete details.dockFrames;
      save(event,change.delta < 0 ? "undocked" : "docked",details,image.id,
        event.imageId === image.id ? event.previousImageId : event.imageId);
      confirmed.add(event.id);
    }
  }

  for (const event of pending) {
    if (confirmed.has(event.id)) continue;
    const elapsed = Date.parse(image.capturedAt) - Date.parse(event.time);
    const frames = Number(event.details.dockFrames || 0);
    if (frames >= DOCK_CONFIRM_FRAMES || elapsed > DOCK_CONFIRM_WINDOW_MS) {
      const details = {...event.details};
      delete details.dockPending;
      delete details.dockFrames;
      if (event.details.dockPending === "entry") {
        details.reason = "dock_count_decrease_not_confirmed";
        delete details.verification;
        save(event,"appeared",details);
        db.prepare("UPDATE current_objects SET entry_type = 'appeared' WHERE watcher_id = ? AND entry_event_id = ?").run(watcherId,event.id);
      } else {
        if (event.details.dockPending === "exit" && event.type === "disappeared") {
          details.reason = "dock_count_increase_not_confirmed";
          delete details.verification;
        }
        save(event,event.type,details);
      }
    } else {
      save(event,event.type,{...event.details,dockFrames:frames + 1});
    }
  }
}

function closePendingDockEntry(db, entryEventId) {
  if (!entryEventId) return;
  const event = db.prepare("SELECT event_type AS type, details_json AS detailsJson FROM events WHERE id = ?").get(entryEventId);
  if (!event) return;
  const details = JSON.parse(event.detailsJson);
  if (details.dockPending !== "entry" && details.dockPending !== "entry_blocker") return;
  const wasUndockEstimate = details.dockPending === "entry";
  delete details.dockPending;
  delete details.dockFrames;
  if (wasUndockEstimate) {
    delete details.verification;
    details.reason = "dock_count_decrease_not_confirmed_before_exit";
  }
  db.prepare("UPDATE events SET event_type = ?, details_json = ? WHERE id = ?")
    .run(wasUndockEstimate ? "appeared" : event.type, JSON.stringify(details), entryEventId);
}

function editDistance(left, right) {
  const a = normalizeIdentity(left).replace(/[^A-Z0-9가-힣]/g, "");
  const b = normalizeIdentity(right).replace(/[^A-Z0-9가-힣]/g, "");
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function overviewIsReliable(observations) {
  const overview = observations.filter(item => item.kind === "overview");
  return overview.length > 0 && overview.every(item => item.payload?.fields?.overviewDetected === true);
}

function reconcileCurrentObjects(db, watcherId, watcher, image, currentObservations, previous, rows) {
  const existingRows = db.prepare(`
    SELECT identity_key AS identity, character_name AS name, ship_name AS ship,
           corporation_ticker AS corporation, distance_text AS distance, speed_mps AS speed,
           previous_speed_mps AS previousSpeed, confidence, entry_type AS entryType,
           first_seen_at AS firstSeenAt, last_brightness AS lastBrightness,
           image_id AS lastImageId, entry_confirmed AS entryConfirmed,
           entry_previous_image_id AS entryPreviousImageId,
           entry_event_id AS entryEventId
    FROM current_objects WHERE watcher_id = ?
  `).all(watcherId);
  const existing = new Map(existingRows.map(row => [row.identity, row]));
  const matchedExisting = new Set();
  const resolved = new Map();

  for (const row of rows) {
    const exact = normalizeIdentity(row.name);
    let identity = existing.has(exact) && !matchedExisting.has(exact) ? exact : null;
    if (!identity) {
      const rowShip = normalizeIdentity(row.ship);
      const candidates = existingRows.filter(candidate => !matchedExisting.has(candidate.identity)
        && normalizeIdentity(candidate.ship) === rowShip
        && Math.abs(normalizeIdentity(candidate.name).length - normalizeIdentity(row.name).length) <= 2
        && editDistance(candidate.name, row.name) <= 2);
      if (candidates.length === 1) identity = candidates[0].identity;
    }
    identity ||= exact;
    matchedExisting.add(identity);
    resolved.set(identity, row);
  }

  const insert = db.prepare(`
    INSERT INTO current_objects
      (watcher_id, identity_key, character_name, ship_name, corporation_ticker,
       distance_text, speed_mps, confidence, image_id, last_seen_at, entry_type,
       first_seen_at, missing_count, last_brightness, entry_confirmed,
       entry_previous_image_id, entry_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE current_objects SET character_name = ?, ship_name = COALESCE(?, ship_name),
      corporation_ticker = COALESCE(?, corporation_ticker),
      distance_text = COALESCE(?, distance_text),
      previous_speed_mps = CASE WHEN ? IS NOT NULL THEN speed_mps ELSE previous_speed_mps END,
      speed_mps = COALESCE(?, speed_mps), confidence = ?, image_id = ?,
      last_seen_at = ?, last_brightness = ?, missing_count = 0, missing_since_at = NULL,
      missing_image_id = NULL, pending_exit_type = NULL, pending_exit_reason = NULL
    WHERE watcher_id = ? AND identity_key = ?
  `);
  const confirmEntry = db.prepare(`
    UPDATE current_objects SET entry_type = ?, entry_confirmed = 1 WHERE watcher_id = ? AND identity_key = ?
  `);
  const entrySpeed = db.prepare("SELECT speed_mps AS speed FROM events WHERE id = ?");

  for (const [identity, row] of resolved) {
    if (existing.has(identity)) {
      const previousRow = existing.get(identity);
      // The last couple of frames before a ship leaves warp/the loaded range, EVE
      // fades that whole row toward black and the speed reading goes stale (usually
      // 0) — comparing this row's own brightness against its last known-good
      // brightness catches that fade (it drops to ~25-30%) without being fooled by
      // rows that are just naturally dim (unhighlighted, black background), since
      // those never had a bright baseline to fall from. Skip the update entirely so
      // the stale reading never overwrites the last real speed/brightness — this
      // identity still counts as "present" (not departed), just unchanged this frame.
      const isFaded = Number.isFinite(previousRow.lastBrightness) && Number.isFinite(row.brightness)
        && row.brightness < previousRow.lastBrightness * 0.5;
      if (isFaded) continue;

      if (!previousRow.entryConfirmed) {
        const lastSpeed = previousRow.speed;
        const recordedSpeed = previousRow.entryEventId ? entrySpeed.get(previousRow.entryEventId)?.speed : null;
        const firstSpeed = Number.isFinite(recordedSpeed) ? recordedSpeed : lastSpeed;
        const knownShip = row.ship || previousRow.ship;
        const isCovert = isCovertOpsShip(knownShip);
        const isWarpIn = !isCovert && Number.isFinite(lastSpeed)
          && lastSpeed >= WARP_SPEED_THRESHOLD_MPS && Number.isFinite(row.speed) && row.speed < lastSpeed;
        // A high reading may persist over several frames. Keep its estimate
        // pending until a valid lower speed establishes the landing trend.
        const canDecide = isCovert || (knownShip && Number.isFinite(firstSpeed) && firstSpeed < WARP_SPEED_THRESHOLD_MPS)
          || (knownShip && !Number.isFinite(firstSpeed) && Number.isFinite(row.speed))
          || (knownShip && isWarpIn);
        if (canDecide) {
          const entryType = isCovert ? "covop_in" : isWarpIn ? "warp_in"
            : !Number.isFinite(firstSpeed) ? "appeared" : watcher.watchType === "gate" ? "jump_in" : "undocked";
          confirmEntry.run(entryType, watcherId, identity);
          const decidedEvent = {
            time:previousRow.firstSeenAt,type:entryType,character:previousRow.name,corporation:previousRow.corporation,ship:knownShip,
            speed:firstSpeed,watcherId,confidence:previousRow.confidence,imageId:image.id,previousImageId:previousRow.lastImageId,
            details:{distance:previousRow.distance,reason:isCovert?"covert_ops_hull":isWarpIn?"decelerated_from_warp_speed":entryType==="appeared"?"first_speed_unreadable":watcher.watchType==="gate"?"first_seen_at_gate":"first_seen_at_structure",
              ...(isWarpIn?{verification:"confirmed",firstSpeed,previousSpeed:lastSpeed,nextSpeed:row.speed}:{}),
              ...(entryType==="undocked"?{verification:"estimated",dockPending:"entry",dockFrames:0}:{}),
              ...(isCovert && watcher.watchType==="structure"?{dockPending:"entry_blocker",dockFrames:0}:{})},
          };
          if (!reviseEntryEvent(db, previousRow.entryEventId, decidedEvent)) insertEvent(db, decidedEvent);
        }
      }

      const brightness = Number.isFinite(row.brightness) ? row.brightness : previousRow.lastBrightness ?? null;
      update.run(row.name,row.ship||null,row.corporation||null,row.distance||null,row.speed,row.speed,row.confidence??null,image.id,image.capturedAt,brightness,watcherId,identity);
      continue;
    }
    if (isCovertOpsShip(row.ship)) {
      // Covert-cloak-capable hulls can warp while cloaked, so the warp-vs-jump
      // distinction (and the speed trend it depends on) isn't meaningful for them —
      // report immediately, no need to wait for a second frame.
      const entryEventId = insertEvent(db,{
        time:image.capturedAt,type:"covop_in",character:row.name,corporation:row.corporation,ship:row.ship,
        speed:row.speed,watcherId,confidence:row.confidence,imageId:image.id,previousImageId:previous.imageId,
        details:{distance:row.distance,reason:"covert_ops_hull",
          ...(watcher.watchType==="structure"?{dockPending:"entry_blocker",dockFrames:0}:{})},
      });
      insert.run(watcherId,identity,row.name,row.ship||null,row.corporation||null,row.distance||null,row.speed,row.confidence??null,image.id,image.capturedAt,"covop_in",image.capturedAt,Number.isFinite(row.brightness)?row.brightness:null,1,previous.imageId,entryEventId);
      continue;
    }
    // A known low-speed arrival cannot satisfy the warp-in condition, so a
    // gate jump-in (or structure undock) can be reported on its first frame.
    const immediateType = row.ship && Number.isFinite(row.speed) && row.speed < WARP_SPEED_THRESHOLD_MPS
      ? watcher.watchType === "gate" ? "jump_in" : "undocked" : null;
    const estimatedWarp = Number.isFinite(row.speed) && row.speed >= WARP_SPEED_THRESHOLD_MPS;
    const entryType = immediateType || (estimatedWarp ? "warp_in" : null);
    const entryEventId = entryType ? insertEvent(db,{
      time:image.capturedAt,type:entryType,character:row.name,corporation:row.corporation,ship:row.ship,
      speed:row.speed,watcherId,confidence:row.confidence,imageId:image.id,previousImageId:previous.imageId,
      details:{distance:row.distance,reason:estimatedWarp?"high_first_speed":watcher.watchType==="gate"?"first_seen_at_gate":"first_seen_at_structure",
        ...(estimatedWarp?{verification:"estimated",firstSpeed:row.speed}:{}),
        ...(immediateType==="undocked"?{verification:"estimated",dockPending:"entry",dockFrames:0}:{})},
    }) : null;
    insert.run(watcherId,identity,row.name,row.ship||null,row.corporation||null,row.distance||null,row.speed,row.confidence??null,image.id,image.capturedAt,entryType,image.capturedAt,Number.isFinite(row.brightness)?row.brightness:null,immediateType?1:0,previous.imageId,entryEventId);
  }

  if (overviewIsReliable(currentObservations)) for (const [identity, row] of existing) {
    if (resolved.has(identity)) continue;
    const isCovert = isCovertOpsShip(row.ship);
    if (watcher.watchType === "structure") closePendingDockEntry(db,row.entryEventId);

    if (!row.entryConfirmed && !row.entryEventId) {
      // No usable first speed or known hull: record the appearance without
      // inventing a warp estimate after it has already left.
      const entryType = isCovert ? "covop_in" : "appeared";
      insertEvent(db,{
        time:row.firstSeenAt,type:entryType,character:row.name,corporation:row.corporation,ship:row.ship,
        speed:row.speed,watcherId,confidence:row.confidence,imageId:row.lastImageId,previousImageId:row.entryPreviousImageId,
        details:{distance:row.distance,reason:"entry_unconfirmed_before_exit"},
      });
    }

    // A high final speed is an estimated warp-out. A rise from the previous
    // valid reading confirms it. A counter change can confirm docking only
    // when the number of exit candidates is unambiguous.
    const isAccelerating = Number.isFinite(row.previousSpeed) && Number(row.speed) > Number(row.previousSpeed);
    const isWarpSpeed = !isCovert && Number.isFinite(row.speed) && row.speed >= WARP_SPEED_THRESHOLD_MPS;
    const warpConfirmed = isWarpSpeed && isAccelerating;
    let type = "disappeared";
    let reason = "overview_row_removed";
    if (isCovert) { type = "covop_out"; reason = "covert_ops_hull"; }
    else if (warpConfirmed) { type = "warp_out"; reason = "accelerated_to_warp_speed"; }
    else if (isWarpSpeed) { type = "warp_out"; reason = "high_last_speed"; }
    else if (watcher.watchType === "gate") { type = "jump_out"; reason = "overview_removed_at_gate"; }
    const dockPending = watcher.watchType === "structure"
      ? isCovert ? "exit_blocker" : warpConfirmed ? null : "exit" : null;
    insertEvent(db,{
      // The current frame confirms it's GONE — the useful comparison shot is the
      // last frame we actually saw it in, which may be a few frames back (e.g. if
      // fade-frame skipping held onto an older reading).
      time:image.capturedAt,type,character:row.name,corporation:row.corporation,ship:row.ship,speed:row.speed,
      watcherId,confidence:row.confidence,imageId:image.id,previousImageId:row.lastImageId ?? previous.imageId,
      details:{distance:row.distance,reason,...(type==="warp_out"?{verification:warpConfirmed?"confirmed":"estimated",previousSpeed:row.previousSpeed,lastSpeed:row.speed}:{}),
        ...(dockPending?{dockPending,dockFrames:0}:{})},
    });
    db.prepare("DELETE FROM current_objects WHERE watcher_id = ? AND identity_key = ?").run(watcherId,identity);
  }
  if (watcher.watchType === "structure") {
    reconcileDockTransitions(db,watcherId,image,currentObservations,previous.observations);
  }
}

function reconcileCurrentSignatures(db, watcherId, image, signatures, previousImageId) {
  const existing = new Map(db.prepare(`
    SELECT signature_id AS id, name, group_name AS groupName, distance_text AS distance,
           confidence, first_seen_at AS firstSeenAt, missing_count AS missingCount, image_id AS lastImageId
    FROM current_signatures WHERE watcher_id = ?
  `).all(watcherId).map(row => [row.id, row]));
  const current = new Map(signatures.map(signature => [signature.id, signature]));
  const insert = db.prepare(`
    INSERT INTO current_signatures
      (watcher_id, signature_id, name, group_name, distance_text, confidence,
       image_id, first_seen_at, last_seen_at, missing_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const update = db.prepare(`
    UPDATE current_signatures SET name = ?, group_name = ?, distance_text = ?, confidence = ?,
      image_id = ?, last_seen_at = ?, missing_count = 0
    WHERE watcher_id = ? AND signature_id = ?
  `);
  for (const [id, signature] of current) {
    if (!existing.has(id)) {
      insert.run(watcherId,id,signature.name||null,signature.group||null,signature.distance||null,signature.confidence??null,image.id,image.capturedAt,image.capturedAt);
      insertEvent(db,{time:image.capturedAt,type:"signature_created",character:id,watcherId,confidence:signature.confidence,imageId:image.id,previousImageId,details:{name:signature.name,group:signature.group,distance:signature.distance}});
    } else {
      update.run(signature.name||null,signature.group||null,signature.distance||null,signature.confidence??null,image.id,image.capturedAt,watcherId,id);
    }
  }
  for (const [id, signature] of existing) {
    if (current.has(id)) continue;
    if (Number(signature.missingCount) < 1) {
      db.prepare("UPDATE current_signatures SET missing_count = missing_count + 1 WHERE watcher_id = ? AND signature_id = ?").run(watcherId,id);
      continue;
    }
    db.prepare("DELETE FROM current_signatures WHERE watcher_id = ? AND signature_id = ?").run(watcherId,id);
    insertEvent(db,{time:image.capturedAt,type:"signature_destroyed",character:id,watcherId,confidence:signature.confidence,imageId:image.id,previousImageId:signature.lastImageId ?? previousImageId,details:{name:signature.name,group:signature.groupName,distance:signature.distance}});
  }
}

export function analyzeImage(store, image, observations) {
  const byWatcher = new Map();
  for (const observation of observations) {
    const list = byWatcher.get(observation.watcherId) || [];
    list.push(observation);
    byWatcher.set(observation.watcherId, list);
  }

  for (const [watcherId, current] of byWatcher) {
    const watcher = store.db.prepare("SELECT watch_type AS watchType FROM watchers WHERE id = ?").get(watcherId);
    if (!watcher) continue;
    const previous = previousObservations(store.db, watcherId, image.captureKey);
    const currentOverview = trackableOverviewRows(current.filter(item => item.kind === "overview"));
    reconcileCurrentObjects(store.db, watcherId, watcher, image, current, previous, currentOverview);

    const currentProbe = probeRows(current.filter(item => item.kind === "probe"));
    // A hidden/blank probing window is not evidence that every signature disappeared.
    // Reconcile only when at least one valid row is visible, and require two consecutive
    // successful scans to agree before recording a disappearance.
    if (currentProbe.length) reconcileCurrentSignatures(store.db, watcherId, image, currentProbe, previous.imageId);
  }
}
