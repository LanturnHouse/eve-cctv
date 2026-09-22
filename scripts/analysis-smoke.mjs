import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../local-service/database.mjs";
import { analyzeImage } from "../local-service/analysis.mjs";
import { parseOverviewSpeed } from "../local-service/numbers.mjs";
import { shapeVisionFields } from "../local-service/vision.mjs";

assert.equal(parseOverviewSpeed("1,775,962"),1_775_962,"쉼표는 천 단위 구분자여야 합니다.");
assert.equal(parseOverviewSpeed("1.775.962"),1_775_962,"쉼표를 점으로 잘못 읽어도 큰 속도를 유지해야 합니다.");
assert.equal(parseOverviewSpeed("1.775,962"),1_775_962,"혼합된 구분 기호도 천 단위로 읽어야 합니다.");
assert.equal(parseOverviewSpeed("598,44"),59_844,"OCR이 마지막 숫자를 누락한 쉼표 표기도 소수로 읽으면 안 됩니다.");
assert.equal(parseOverviewSpeed("126.5"),126.5,"실제 소수점 속도는 보존해야 합니다.");
assert.equal(parseOverviewSpeed("0.001"),0.001,"0으로 시작하는 세 자리 소수는 보존해야 합니다.");
const visionSpeed = shapeVisionFields("overview",{visible:true,rows:[{name:"Jemil",ship:"Zealot",corporation:"HRED",distance:"1,069 km",speed:1.775962}]},{},"1,069k Jemil Zealot [HRED] 1.775.962").overviewRows[0].speed;
assert.equal(visionSpeed,1_775_962,"영상 모델이 작은 소수로 반환해도 원본 OCR 속도로 보정해야 합니다.");

const root = await mkdtemp(join(tmpdir(), "eve-cctv-analysis-"));
const store = openDatabase(join(root,"test.sqlite"));
const watcherId = "state-test";
store.db.prepare("INSERT INTO watchers (id,label,character_name,watch_type,enabled,region_version) VALUES (?,?,?,?,1,2)").run(watcherId,"테스트 스트럭쳐","TestPilot","structure");

function overview(rows, detected = true) {
  return {watcherId,kind:"overview",confidence:.95,payload:{fields:{overviewDetected:detected,overviewRows:rows}}};
}

function frame(index, rows, detected = true) {
  const captureKey = String(index).padStart(20,"0");
  const capturedAt = `2026-09-19T01:00:${String(index).padStart(2,"0")}.000`;
  const result = store.db.prepare(`INSERT INTO images
    (folder_path,file_path,filename,character_name,capture_key,captured_at,size_bytes,modified_at)
    VALUES ('test',?,?, 'TestPilot',?,?,1,1)`).run(`test-${index}.png`,`test-${index}.png`,captureKey,capturedAt);
  const image = {id:Number(result.lastInsertRowid),filePath:`test-${index}.png`,filename:`test-${index}.png`,character:"TestPilot",captureKey,capturedAt};
  const observations = [overview(rows,detected)];
  store.completeImage(image.id,observations);
  analyzeImage(store,image,observations);
}

const pilot = speed => ({distance:"100 km",name:"Stable Pilot",ship:"Proteus",corporation:"EE6",speed,confidence:.95});
frame(1,[pilot(250_000)]);
assert.equal(JSON.parse(store.db.prepare("SELECT details_json AS details FROM events WHERE event_type='warp_in'").get().details).verification,"estimated","첫 고속 관측은 추정 워프인이어야 합니다.");
for (let index=2; index<=32; index += 1) frame(index,[pilot(index===32?300_000:450)]);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='warp_in'").get().count,1,"연속 표시 중 워프인 이벤트는 한 번이어야 합니다.");
assert.equal(JSON.parse(store.db.prepare("SELECT details_json AS details FROM events WHERE event_type='warp_in'").get().details).verification,"confirmed","감속이 확인되면 기존 워프인을 확정으로 승격해야 합니다.");

frame(33,[],false);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='warp_out'").get().count,0,"헤더 판독 실패는 퇴장으로 처리하면 안 됩니다.");
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM current_objects").get().count,1,"판독 실패 중 활성 상태가 유지되어야 합니다.");

frame(34,[]);
const exit = store.db.prepare("SELECT event_time AS time,event_type AS type FROM events WHERE event_type='warp_out'").get();
assert.equal(exit?.time,"2026-09-19T01:00:34.000","정상 프레임에서 처음 사라진 순간이 퇴장 시점이어야 합니다.");
assert.equal(JSON.parse(store.db.prepare("SELECT details_json AS details FROM events WHERE event_type='warp_out'").get().details).verification,"confirmed","가속이 확인된 워프아웃은 확정이어야 합니다.");
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM current_objects").get().count,0,"퇴장 후 활성 상태가 제거되어야 합니다.");

frame(35,[pilot(120)]);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='undocked'").get().count,1,"저속으로 다시 등장하면 새 언독 세션이어야 합니다.");

store.deleteWatcher(watcherId);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM watchers").get().count,0,"감시 클라이언트가 제거되어야 합니다.");
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count,0,"삭제한 눈깔의 이벤트가 초기화되어야 합니다.");
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM observations").get().count,0,"삭제한 눈깔의 관측값이 초기화되어야 합니다.");
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM images").get().count,35,"원본 이미지 인덱스는 유지되어야 합니다.");

store.saveWatcher({id:watcherId,label:"테스트 스트럭쳐",character:"TestPilot",watchType:"structure",enabled:true,regions:[{kind:"overview",x:0,y:0,w:100,h:30}]});
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM images WHERE processing_status='pending'").get().count,35,"다시 등록하면 해당 캐릭터 이미지를 모두 재분석해야 합니다.");

store.db.close();

const rulesStore = openDatabase(join(root,"rules.sqlite"));
for (const [id,type] of [["single-fast","gate"],["gate-low","gate"],["covert","gate"],["missing-speed","structure"],["warp-gap","gate"],["high-plateau","gate"],["flat-exit","gate"],["dock-estimate","structure"],["dock-second","structure"],["ocr-grouped","structure"],["undock-confirm","structure"],["undock-delay","structure"],["undock-unconfirmed","structure"],["dock-delay","structure"],["dock-ambiguous","structure"],["dock-multi-region","structure"],["dock-covert-blocker","structure"],["non-pilot","gate"],["ship-noise","gate"]]) {
  rulesStore.db.prepare("INSERT INTO watchers (id,label,character_name,watch_type,enabled,region_version) VALUES (?,?,?,?,1,2)")
    .run(id,id,"TestPilot",type);
}
function ruleFrame(watcherId,index,rows,dock = null) {
  const captureKey = String(index).padStart(20,"0");
  const capturedAt = `2026-09-19T02:00:${String(index).padStart(2,"0")}.000`;
  const filename = `${watcherId}-${index}.png`;
  const result = rulesStore.db.prepare(`INSERT INTO images
    (folder_path,file_path,filename,character_name,capture_key,captured_at,size_bytes,modified_at)
    VALUES ('test',?,?, 'TestPilot',?,?,1,1)`).run(filename,filename,captureKey,capturedAt);
  const image = {id:Number(result.lastInsertRowid),filename,character:"TestPilot",captureKey,capturedAt};
  const observations = [{watcherId,kind:"overview",confidence:.95,payload:{fields:{overviewDetected:true,overviewRows:rows}}}];
  const dockCounts = Array.isArray(dock) ? dock : Number.isFinite(dock) ? [dock] : [];
  dockCounts.forEach((count,regionIndex) => observations.push({watcherId,kind:"dock",confidence:.95,payload:{regionIndex,fields:{dockCount:count}}}));
  rulesStore.completeImage(image.id,observations);
  analyzeImage(rulesStore,image,observations);
}
const rulePilot = (name,ship,speed) => ({distance:"100 km",name,ship,corporation:"EE6",speed,confidence:.95});

ruleFrame("ocr-grouped",1,[rulePilot("Jemil","Zealot",visionSpeed)]);
assert.equal(rulesStore.db.prepare("SELECT event_type AS type FROM events WHERE watcher_id='ocr-grouped'").get()?.type,"warp_in","잘못 읽힌 천 단위 속도도 첫 등장에 워프인으로 분류해야 합니다.");
ruleFrame("ocr-grouped",2,[rulePilot("Jemil","Zealot",1_200)]);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='ocr-grouped' AND event_type='warp_in'").get().details).verification,"confirmed","후속 프레임 감속으로 같은 워프인을 확정해야 합니다.");

ruleFrame("single-fast",1,[rulePilot("Fast Pilot","Proteus",250_000)]);
ruleFrame("single-fast",2,[]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='single-fast' AND event_type='warp_in'").get().count,1,"단일 고속 관측은 추정 워프인 한 번이어야 합니다.");
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='single-fast' AND event_type='warp_in'").get().details).verification,"estimated","감속 없이 사라진 진입은 추정으로 남겨야 합니다.");

ruleFrame("gate-low",1,[rulePilot("Gate Pilot","Proteus",125)]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='gate-low' AND event_type='jump_in'").get().count,1,"게이트의 저속 첫 등장은 즉시 점프인으로 기록해야 합니다.");
ruleFrame("gate-low",2,[]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='gate-low' AND event_type='jump_out'").get().count,1,"게이트에서 저속으로 사라지면 점프아웃이어야 합니다.");

ruleFrame("covert",1,[rulePilot("Covert Pilot","Anathema",null)]);
ruleFrame("covert",2,[rulePilot("Covert Pilot","Anathema",null)]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='covert' AND event_type='covop_in'").get().count,1,"속도 판독 없이도 코옵인은 한 번 감지해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='covert' AND event_type='covop_out'").get().count,0,"속도만 누락된 프레임을 코옵아웃으로 처리하면 안 됩니다.");
ruleFrame("covert",3,[]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='covert' AND event_type='covop_out'").get().count,1,"실제 오버뷰 이탈 시 코옵아웃을 감지해야 합니다.");

ruleFrame("missing-speed",1,[rulePilot("Speed Pilot","Proteus",120)]);
ruleFrame("missing-speed",2,[rulePilot("Speed Pilot","Proteus",null)]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM current_objects WHERE watcher_id='missing-speed'").get().count,1,"속도 OCR 실패 중에도 현재 대상을 유지해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='missing-speed' AND event_type='disappeared'").get().count,0,"속도 OCR 실패로 가짜 이탈을 기록하면 안 됩니다.");
ruleFrame("missing-speed",3,[rulePilot("Speed Pilot","Proteus",300_000)]);
ruleFrame("missing-speed",4,[]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='missing-speed' AND event_type='warp_out'").get().count,1,"마지막 두 유효 속도값의 상승을 유지해야 합니다.");

ruleFrame("warp-gap",1,[rulePilot("Warp Pilot","Proteus",250_000)]);
ruleFrame("warp-gap",2,[rulePilot("Warp Pilot","Proteus",null)]);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='warp-gap' AND event_type='warp_in'").get().details).verification,"estimated","속도 누락 프레임에서는 추정 상태를 유지해야 합니다.");
ruleFrame("warp-gap",3,[rulePilot("Warp Pilot","Proteus",1_000)]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='warp-gap' AND event_type='warp_in'").get().count,1,"다음 유효 속도에서 감속이 확인되면 워프인으로 기록해야 합니다.");
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='warp-gap' AND event_type='warp_in'").get().details).verification,"confirmed","속도 누락 이후 감속되면 같은 기록을 확정해야 합니다.");

ruleFrame("high-plateau",1,[rulePilot("Plateau Pilot","Proteus",250_000)]);
ruleFrame("high-plateau",2,[rulePilot("Plateau Pilot","Proteus",260_000)]);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='high-plateau' AND event_type='warp_in'").get().details).verification,"estimated","고속이 유지되는 동안 워프인은 추정으로 남아야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='high-plateau' AND event_type='jump_in'").get().count,0,"고속 지속만으로 점프인으로 바꾸면 안 됩니다.");
ruleFrame("high-plateau",3,[rulePilot("Plateau Pilot","Proteus",180_000)]);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='high-plateau' AND event_type='warp_in'").get().details).verification,"confirmed","고속 지속 뒤 감속하면 같은 워프인 기록을 확정해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT speed_mps AS speed FROM events WHERE watcher_id='high-plateau' AND event_type='warp_in'").get().speed,250_000,"확정 뒤에도 이벤트 속도는 첫 등장 프레임 값을 유지해야 합니다.");

ruleFrame("flat-exit",1,[rulePilot("Flat Pilot","Proteus",120)]);
ruleFrame("flat-exit",2,[rulePilot("Flat Pilot","Proteus",250_000)]);
ruleFrame("flat-exit",3,[rulePilot("Flat Pilot","Proteus",250_000)]);
ruleFrame("flat-exit",4,[]);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='flat-exit' AND event_type='warp_out'").get().details).verification,"estimated","고속이지만 가속이 없는 이탈은 추정 워프아웃이어야 합니다.");

ruleFrame("dock-estimate",1,[rulePilot("Dock Pilot","Proteus",250_000)],0);
ruleFrame("dock-estimate",2,[],1);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='dock-estimate' AND event_type='docked'").get().count,1,"도킹 숫자 증가는 고속 추정 워프아웃보다 우선해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='dock-estimate' AND event_type='warp_out'").get().count,0,"도킹된 대상을 추정 워프아웃으로 중복 기록하면 안 됩니다.");
assert.equal(rulesStore.listDockPeaks().find(peak => peak.watcherId === "dock-estimate")?.peakCount,1,"감시 위치별 최고 도킹 수를 찾아야 합니다.");
ruleFrame("dock-estimate",3,[],0);
assert.equal(rulesStore.listDockPeaks().find(peak => peak.watcherId === "dock-estimate")?.peakCount,1,"현재 수가 낮아져도 감지 최고 도킹 수는 유지되어야 합니다.");
assert.equal(rulesStore.listDockPeaks().find(peak => peak.watcherId === "dock-estimate")?.filename,"dock-estimate-2.png","최고 수치의 근거 이미지를 보존해야 합니다.");
ruleFrame("dock-second",1,[],4);
assert.deepEqual(rulesStore.listDockPeaks().map(peak => [peak.watcherId,peak.peakCount]),[["dock-second",4],["dock-estimate",1]],"서로 다른 감시 위치의 최고값은 합산하지 않고 각각 보존해야 합니다.");

ruleFrame("undock-confirm",1,[],5);
ruleFrame("undock-confirm",2,[rulePilot("Undock Pilot","Proteus",130)],4);
const confirmedUndock = rulesStore.db.prepare("SELECT event_time AS time,details_json AS details FROM events WHERE watcher_id='undock-confirm' AND event_type='undocked'").get();
assert.equal(confirmedUndock?.time,"2026-09-19T02:00:02.000","언독 시각은 최초 오버뷰 등장 시각을 유지해야 합니다.");
assert.equal(JSON.parse(confirmedUndock.details).verification,"confirmed","도킹 수 감소가 일치하면 언독을 확정해야 합니다.");

ruleFrame("undock-delay",1,[],5);
ruleFrame("undock-delay",2,[rulePilot("Delayed Undock","Proteus",130)],5);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='undock-delay' AND event_type='undocked'").get().details).verification,"estimated","카운터 변화 전에는 언독을 추정으로 표시해야 합니다.");
ruleFrame("undock-delay",3,[rulePilot("Delayed Undock","Proteus",125)],4);
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='undock-delay' AND event_type='undocked'").get().details).verification,"confirmed","한 프레임 늦은 도킹 수 감소도 언독을 확정해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='undock-delay' AND event_type='undocked'").get().count,1,"언독을 중복 기록하면 안 됩니다.");

ruleFrame("undock-unconfirmed",1,[],5);
ruleFrame("undock-unconfirmed",2,[rulePilot("Unknown Arrival","Proteus",130)],5);
ruleFrame("undock-unconfirmed",3,[rulePilot("Unknown Arrival","Proteus",125)],5);
ruleFrame("undock-unconfirmed",4,[rulePilot("Unknown Arrival","Proteus",120)],5);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='undock-unconfirmed' AND event_type='undocked'").get().count,0,"도킹 수 감소가 없으면 언독 확정으로 남겨서는 안 됩니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='undock-unconfirmed' AND event_type='appeared'").get().count,1,"미확정 언독은 오버뷰 인으로 바꿔야 합니다.");

ruleFrame("dock-delay",1,[rulePilot("Delayed Dock","Proteus",130)],0);
ruleFrame("dock-delay",2,[],0);
ruleFrame("dock-delay",3,[],1);
const delayedDock = rulesStore.db.prepare("SELECT event_time AS time,details_json AS details FROM events WHERE watcher_id='dock-delay' AND event_type='docked'").get();
assert.equal(delayedDock?.time,"2026-09-19T02:00:02.000","도킹 시각은 최초 오버뷰 이탈 시각을 유지해야 합니다.");
assert.equal(JSON.parse(delayedDock.details).verification,"confirmed","한 프레임 늦은 도킹 수 증가도 도킹을 확정해야 합니다.");

ruleFrame("dock-ambiguous",1,[rulePilot("Pilot A","Proteus",100),rulePilot("Pilot B","Zealot",110)],0);
ruleFrame("dock-ambiguous",2,[],1);
ruleFrame("dock-ambiguous",3,[],1);
ruleFrame("dock-ambiguous",4,[],1);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='dock-ambiguous' AND event_type='docked'").get().count,0,"두 명 중 한 명만 도킹했을 때 임의의 캐릭터를 확정하면 안 됩니다.");

ruleFrame("dock-multi-region",1,[rulePilot("Region Pilot","Proteus",100)],[3,0]);
ruleFrame("dock-multi-region",2,[],[3,1]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='dock-multi-region' AND event_type='docked'").get().count,1,"두 번째 도킹 영역의 카운터 변화도 판정해야 합니다.");
assert.equal(JSON.parse(rulesStore.db.prepare("SELECT details_json AS details FROM events WHERE watcher_id='dock-multi-region' AND event_type='docked'").get().details).dockRegionIndex,1,"변화가 발생한 도킹 영역을 근거로 남겨야 합니다.");

ruleFrame("dock-covert-blocker",1,[rulePilot("Regular Pilot","Proteus",100),rulePilot("Covert Pilot","Anathema",100)],0);
ruleFrame("dock-covert-blocker",2,[],1);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='dock-covert-blocker' AND event_type='docked'").get().count,0,"코옵과 일반 함선이 동시에 사라지면 일반 함선에 도킹을 임의 귀속하면 안 됩니다.");

const scenery = [
  rulePilot("J133252 - St","Sun K5 (Orange)",null),
  rulePilot("J133252-St","SunKS5 (Oran",null),
  rulePilot("J133252-S","SunK5 (Oran",null),
  rulePilot("Enemy Home","Astrahus*",null),
  rulePilot("Enemy Industry","Raitaru*",null),
  rulePilot("J133252 - st","Wormhole H2",null),
];
ruleFrame("non-pilot",1,[...scenery,rulePilot("Astrahus","Sunesis",120)]);
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM current_objects WHERE watcher_id='non-pilot'").get().count,1,"Sun과 구조물은 제외하되 Sunesis를 탄 캐릭터는 유지해야 합니다.");
ruleFrame("non-pilot",2,scenery);
assert.deepEqual(rulesStore.db.prepare("SELECT character_name AS character FROM events WHERE watcher_id='non-pilot' ORDER BY id").all().map(row => row.character),["Astrahus","Astrahus"],"Sun·구조물·웜홀은 오버뷰 인/아웃 이벤트를 만들면 안 됩니다.");

ruleFrame("ship-noise",1,[rulePilot("Clean Pilot","Osprey Navy Issue=*5",120)]);
ruleFrame("ship-noise",2,[rulePilot("Clean Pilot","Osprey Navy Issue*",125)]);
assert.equal(rulesStore.db.prepare("SELECT ship_name AS ship FROM events WHERE watcher_id='ship-noise' AND event_type='jump_in'").get()?.ship,"Osprey Navy Issue","특수문자와 뒤따른 숫자는 함선 이름에 저장하면 안 됩니다.");
assert.equal(rulesStore.db.prepare("SELECT ship_name AS ship FROM current_objects WHERE watcher_id='ship-noise'").get()?.ship,"Osprey Navy Issue","이후 화면에서도 같은 정리된 함선 이름을 유지해야 합니다.");
assert.equal(rulesStore.db.prepare("SELECT COUNT(*) AS count FROM events WHERE watcher_id='ship-noise'").get().count,1,"OCR 꼬리가 달라져도 같은 오버뷰 세션을 중복 기록하면 안 됩니다.");

rulesStore.db.close();
await rm(root,{recursive:true,force:true});
console.log("analysis state-machine smoke test passed");
