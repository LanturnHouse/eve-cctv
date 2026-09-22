"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, Bell, Box, Check,
  ChevronRight, Crosshair, Eye, EyeOff, FileImage, FolderOpen,
  HelpCircle, LogOut, Pause, Play, Plus, Radar, ScanLine,
  Search, Settings2, ShieldCheck, Ship, Users, Waves, X, Minus,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type EventType = "워프인" | "워프아웃" | "언독" | "도킹" | "점프인" | "점프아웃" | "오버뷰 인" | "오버뷰 아웃" | "시그니처" | "코옵인" | "코옵아웃";
type EventItem = {
  id: number; time: string; type: EventType; name: string; detail: string;
  corp: string; source: string; confidence: number; image: string; filename: string; imageId?:number|null;
  previousImage?: string|null; previousFilename?: string|null;
  verification?: "estimated" | "confirmed";
  ship?: string;
};
type SearchField = "name" | "ship" | "corp";
const SEARCH_FIELDS: {key:SearchField; label:string}[] = [{key:"name",label:"캐릭터"},{key:"ship",label:"함선"},{key:"corp",label:"콥 티커"}];
// Case-insensitive; ignores the [ ] around corp tickers and the trailing * on ship names.
const normalizeSearch = (value:string) => value.toLowerCase().replace(/[\[\]]/g,"").replace(/\*+$/,"").replace(/\s+/g," ").trim();
function eventMatchesSearch(event:EventItem, query:string, exact:boolean, fields:SearchField[]) {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  return fields.some(field => {
    const haystack = normalizeSearch(field === "name" ? event.name : field === "ship" ? event.ship || "" : event.corp);
    return exact ? haystack === needle : haystack.includes(needle);
  });
}
type BoxRect = { x: number; y: number; w: number; h: number; kind: RegionKind };
type RegionKind = "overview" | "probe" | "dock";
type SummaryKey = "docked" | "observed" | "departed";
type CorpKey = "hred" | "worm" | "nova";
const EVENT_FILTERS = ["워프", "도킹/언독", "점프", "코옵", "시그니처", "기타"] as const;
type EventFilter = (typeof EVENT_FILTERS)[number];
type Watcher = { id:string; label:string; character:string; type:string; files:string; live:boolean; regions:number };
type LocalWatcher = { id:string; label:string; character:string; watchType:"structure"|"gate"; enabled:boolean; regionVersion:number; regions:BoxRect[] };
type DockPeak = { watcherId:string; watcherLabel:string; peakCount:number; capturedAt:string; imageId:number; observationId:number; filename:string };
type LocalStatus = {
  online:boolean;
  folder:{path:string;name:string;imageCount:number};
  detectedCharacters:string[];
  characterStats:Record<string,CharacterStat>;
  watchers:LocalWatcher[];
  dockPeaks:DockPeak[];
  recentImages:{id:number;filename:string;character:string;capturedAt:string;status:string}[];
  processing:{pending:number;processing:number;processed:number;failed:number};
  regionWarnings:{watcherId:string;watcherLabel:string;kind:RegionKind;message:string;filename:string}[];
  scanIntervalMs:number;
  lastError:string|null;
  visionMode:VisionMode;
};
type VisionMode = "fallback" | "always" | "off";
type CharacterStat = {imageCount:number;latestCaptureAt:string;latestImageId:number};
type LocalEvent = {
  id:number; time:string; type:string; character:string|null; corporation:string|null;
  ship:string|null; speed:number|null; confidence:number|null; imageId:number|null;
  previousImageId:number|null; previousFilename:string|null;
  details:Record<string,unknown>; watcherId:string|null; watcherLabel:string|null; filename:string|null;
};
type LocalSignature = {
  id:string; name:string|null; groupName:string|null; distance:string|null; confidence:number|null;
  firstSeenAt:string; lastSeenAt:string; imageId:number; watcherId:string; watcherLabel:string;
};
type LocalObject = {
  character:string; ship:string|null; corporation:string|null; distance:string|null; speed:number|null;
  confidence:number|null; lastSeenAt:string; imageId:number; watcherId:string; watcherLabel:string;
  entryType?:string|null; firstSeenAt?:string|null;
};
type LiveCorpGroup = {
  key:string; name:string; ticker:string; detected:number; docked:number; observed:number;
  ships:[string,number][];
  members:{name:string;sightings:{time:string;ship:string;source:string}[]}[];
};
type LiveSummaryRow = { ticker:string; character:string; ship:string; source:string; time:string };

const LOCAL_API = "http://127.0.0.1:8765";

const EVENTS: EventItem[] = [
  { id: 1, time: "01:29:58", type: "점프인", name: "TrumpFarmer", corp: "[WORM]", detail: "Anathema · 126 m/s", source: "동쪽 웜홀", confidence: 96, image: "/cuda-overview.png", filename: "CCTV202609190129584776_CUDA_Toolkit.png" },
  { id: 2, time: "01:28:00", type: "워프인", name: "Jemil", corp: "[HRED]", detail: "Zealot* · 1,775,962 → 84,210 m/s", source: "1번 스트럭쳐", confidence: 99, image: "/lanturn-full.png", filename: "CCTV202609190128002850_LanturnAlBag-i.png", verification:"confirmed" },
  { id: 3, time: "01:27:46", type: "도킹", name: "Stressed Badger", corp: "[HRED]", detail: "Hecate · 도킹 수 0 → 1", source: "1번 스트럭쳐", confidence: 93, image: "/lanturn-full.png", filename: "CCTV202609190127464201_LanturnAlBag-i.png" },
  { id: 4, time: "01:24:27", type: "시그니처", name: "MAC-7", corp: "—", detail: "코어 요새 시그니처 소실", source: "1번 스트럭쳐", confidence: 88, image: "/lanturn-regions.png", filename: "CCTV202609190124277122_LanturnAlBag-i.png" },
  { id: 5, time: "01:21:12", type: "워프아웃", name: "Unknown Pilot", corp: "[NOVA]", detail: "Astero · 412 → 786,231 m/s", source: "동쪽 웜홀", confidence: 84, image: "/cuda-overview.png", filename: "CCTV202609190121128311_CUDA_Toolkit.png", verification:"confirmed" },
  { id: 6, time: "01:17:08", type: "점프아웃", name: "Rooke Den", corp: "[NOVA]", detail: "Buzzard · 웜홀 랜딩 후 소실", source: "동쪽 웜홀", confidence: 91, image: "/cuda-overview.png", filename: "CCTV202609190117085507_CUDA_Toolkit.png" },
];

const INITIAL_REGIONS: Record<string, BoxRect[]> = {
  "watcher-structure-1": [
    {x:42.5,y:9.2,w:55.5,h:24,kind:"overview"}, {x:.5,y:10.5,w:41.5,h:27,kind:"probe"}, {x:0,y:8.6,w:15,h:4,kind:"dock"},
  ],
  "watcher-wormhole-east": [{x:1,y:3,w:98,h:10,kind:"overview"}],
};

const SUMMARY_DATA = {
  docked: { title: "현재 도킹 확인", caption: "도킹 카운터와 이탈 인원이 일치", rows: [["[HRED]", "Jemil", "Zealot"], ["[HRED]", "Stressed Badger", "Hecate"]] },
  observed: { title: "감지 · 미도킹", caption: "현재 위치를 확정하지 못한 대상", rows: [["[WORM]", "TrumpFarmer", "Anathema"], ["[NOVA]", "Unknown Pilot", "Astero"]] },
  departed: { title: "성계 이탈", caption: "최근 60분 웜홀·게이트 이탈", rows: [["[NOVA]", "Rooke Den", "Buzzard"], ["[WORM]", "Leya Ark", "Sabre"], ["[HRED]", "Mora Jin", "Kikimora"]] },
} satisfies Record<SummaryKey, {title:string; caption:string; rows:string[][]}>;

const CORP_DATA = {
  hred: {
    name: "HRED", ticker: "[HRED]", detected: 2, docked: 2, observed: 0,
    ships: [["Zealot", 1], ["Hecate", 1]] as [string, number][],
    members: [
      { name: "Jemil", sightings: [
        { time: "01:28:00", ship: "Zealot", source: "1번 스트럭쳐" },
        { time: "00:42:16", ship: "Sacrilege", source: "2번 스트럭쳐" },
      ]},
      { name: "Stressed Badger", sightings: [
        { time: "01:27:46", ship: "Hecate", source: "1번 스트럭쳐" },
      ]},
    ],
  },
  worm: {
    name: "WORM", ticker: "[WORM]", detected: 1, docked: 0, observed: 1,
    ships: [["Anathema", 1]] as [string, number][],
    members: [
      { name: "TrumpFarmer", sightings: [
        { time: "01:29:58", ship: "Anathema", source: "동쪽 웜홀" },
      ]},
    ],
  },
  nova: {
    name: "NOVA", ticker: "[NOVA]", detected: 1, docked: 0, observed: 1,
    ships: [["Astero", 1]] as [string, number][],
    members: [
      { name: "Unknown Pilot", sightings: [
        { time: "01:21:12", ship: "Astero", source: "동쪽 웜홀" },
      ]},
    ],
  },
} satisfies Record<CorpKey, {
  name:string; ticker:string; detected:number; docked:number; observed:number;
  ships:[string,number][]; members:{name:string;sightings:{time:string;ship:string;source:string}[]}[];
}>;

const iconFor = (type: EventType) => {
  if (type === "코옵인" || type === "코옵아웃") return <EyeOff size={16}/>;
  if (type === "워프인") return <ArrowDownToLine size={16}/>;
  if (type === "워프아웃") return <ArrowUpFromLine size={16}/>;
  if (type === "도킹") return <Box size={16}/>;
  if (type === "점프인" || type === "점프아웃") return <LogOut size={16}/>;
  return <Radar size={16}/>;
};

const toneFor = (type: EventType) => {
  if (type === "코옵인") return "covop-in";
  if (type === "코옵아웃") return "covop-out";
  if (type === "워프아웃") return "out";
  if (type === "도킹") return "dock";
  if (type.includes("점프")) return "jump";
  return "";
};

const categoryFor = (type: EventType): EventFilter => {
  if (type.includes("워프")) return "워프";
  if (type === "도킹" || type === "언독") return "도킹/언독";
  if (type.includes("점프")) return "점프";
  if (type.includes("코옵")) return "코옵";
  if (type === "시그니처") return "시그니처";
  return "기타";
};

function buildLatestStates(events:LocalEvent[], objects:LocalObject[], canonical:(value:string|null)=>string) {
  type State = LiveSummaryRow & { status:SummaryKey; corporation:string };
  const identities = new Map<string,{corporation:string;ship:string;time:string}>();
  const remember = (character:string, corporation:string|null, ship:string|null, time:string) => {
    const previous = identities.get(character);
    identities.set(character, {
      corporation:corporation ? canonical(corporation) : previous?.corporation || "미확인",
      ship:ship || previous?.ship || "미확인 함선",
      time:time > (previous?.time || "") ? time : previous?.time || time,
    });
  };
  objects.forEach(object => remember(object.character, object.corporation, object.ship, object.lastSeenAt));
  [...events].reverse().forEach(event => { if (event.character && !event.type.startsWith("signature_")) remember(event.character,event.corporation,event.ship,event.time); });

  const latest = new Map<string,State>();
  const commit = (character:string,status:SummaryKey,time:string,corporation:string|null,ship:string|null,source:string) => {
    const previous = latest.get(character);
    if (previous && previous.time >= time) return;
    const identity = identities.get(character);
    latest.set(character,{character,status,time,corporation:corporation?canonical(corporation):identity?.corporation||"미확인",ticker:"",ship:ship||identity?.ship||"미확인 함선",source});
  };
  objects.forEach(object => commit(object.character,"observed",object.lastSeenAt,object.corporation,object.ship,object.watcherLabel));
  for (const event of events) {
    if (!event.character || event.type.startsWith("signature_")) continue;
    const status:SummaryKey|null = event.type === "docked" ? "docked" : ["warp_in","jump_in","undocked","appeared","covop_in"].includes(event.type) ? "observed" : ["warp_out","jump_out","disappeared","covop_out"].includes(event.type) ? "departed" : null;
    if (status) commit(event.character,status,event.time,event.corporation,event.ship,event.watcherLabel||"미지정 눈깔");
  }
  return latest;
}

export default function Home() {
  const [monitoring, setMonitoring] = useState(true);
  const [eventFilters, setEventFilters] = useState<EventFilter[]>([...EVENT_FILTERS]);
  const [watcherFilter, setWatcherFilter] = useState("전체");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExact, setSearchExact] = useState(false);
  const [searchFields, setSearchFields] = useState<SearchField[]>(["name","ship","corp"]);
  const [selected, setSelected] = useState<EventItem | null>(null);
  const [summary, setSummary] = useState<SummaryKey | null>(null);
  const [corpDetail, setCorpDetail] = useState<CorpKey | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(0);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("EVE Alert CCTV / CCTV");
  const [folderPath, setFolderPath] = useState("");
  const [folderCount, setFolderCount] = useState(284);
  const [serviceOnline, setServiceOnline] = useState(false);
  const [processingCounts, setProcessingCounts] = useState({pending:0,processing:0,processed:0,failed:0});
  const [localEvents, setLocalEvents] = useState<LocalEvent[]>([]);
  const [localSignatures, setLocalSignatures] = useState<LocalSignature[]>([]);
  const [localObjects, setLocalObjects] = useState<LocalObject[]>([]);
  const [liveCorpDetail, setLiveCorpDetail] = useState<string|null>(null);
  const [latestCaptureAt, setLatestCaptureAt] = useState("");
  const [regionWarnings,setRegionWarnings] = useState<LocalStatus["regionWarnings"]>([]);
  const [dockPeaks,setDockPeaks] = useState<DockPeak[]>([]);
  const [detectedCharacters, setDetectedCharacters] = useState(["LanturnAlBag-i", "CUDA_Toolkit"]);
  const [characterStats, setCharacterStats] = useState<Record<string,CharacterStat>>({});
  const [removingWatcherId,setRemovingWatcherId] = useState<string|null>(null);
  const [toast, setToast] = useState("");
  const [clientName, setClientName] = useState("LanturnAlBag-i");
  const [watchLabel, setWatchLabel] = useState("");
  const [watchType, setWatchType] = useState("structure");
  const [editingWatcherId, setEditingWatcherId] = useState<string | null>(null);
  const [watchers, setWatchers] = useState<Watcher[]>([
    { id:"watcher-structure-1", label:"1번 스트럭쳐", character:"LanturnAlBag-i", type: "스트럭쳐", files: "방금 전", live: true, regions: 3 },
    { id:"watcher-wormhole-east", label:"동쪽 웜홀", character:"CUDA_Toolkit", type: "웜홀 / 게이트", files: "2초 전", live: true, regions: 1 },
  ]);
  const [regionConfigs, setRegionConfigs] = useState<Record<string, BoxRect[]>>(INITIAL_REGIONS);
  const [draftRegions, setDraftRegions] = useState<BoxRect[]>([]);
  const [visionMode, setVisionModeState] = useState<VisionMode>("fallback");
  const inputRef = useRef<HTMLInputElement>(null);

  const applyLocalStatus = (status:LocalStatus) => {
    setServiceOnline(true);
    setFolderPath(status.folder.path);
    setFolderName(status.folder.name || "CCTV 폴더 미지정");
    setFolderCount(status.folder.imageCount);
    setProcessingCounts(status.processing || {pending:0,processing:0,processed:0,failed:0});
    setLatestCaptureAt(status.recentImages?.[0]?.capturedAt || "");
    setRegionWarnings(status.regionWarnings || []);
    setDockPeaks(status.dockPeaks || []);
    setVisionModeState(status.visionMode || "fallback");
    setDetectedCharacters(status.detectedCharacters);
    setCharacterStats(status.characterStats || {});
    setWatchers(status.watchers.map(watcher => ({
      id: watcher.id,
      label: watcher.label,
      character: watcher.character,
      type: watcher.watchType === "structure" ? "스트럭쳐" : "웜홀 / 게이트",
      files: watcher.regionVersion >= 2 ? "감시 대기" : "영역 재설정 필요",
      live: watcher.enabled && watcher.regionVersion >= 2,
      regions: watcher.regions.length,
    })));
    setRegionConfigs(Object.fromEntries(status.watchers.map(watcher => [watcher.id, watcher.regions])));
    if (status.folder.path) {
      window.localStorage.setItem("eve-cctv-folder-configured", "1");
      setFolderOpen(false);
    } else {
      setFolderOpen(true);
    }
  };

  const loadLiveData = async () => {
    try {
      const [eventsResponse, signaturesResponse, objectsResponse] = await Promise.all([
        fetch(`${LOCAL_API}/api/events?limit=250`, { cache: "no-store" }),
        fetch(`${LOCAL_API}/api/signatures/current`, { cache: "no-store" }),
        fetch(`${LOCAL_API}/api/overview/current`, { cache: "no-store" }),
      ]);
      if (eventsResponse.ok) setLocalEvents((await eventsResponse.json() as {events:LocalEvent[]}).events);
      if (signaturesResponse.ok) setLocalSignatures((await signaturesResponse.json() as {signatures:LocalSignature[]}).signatures);
      if (objectsResponse.ok) setLocalObjects((await objectsResponse.json() as {objects:LocalObject[]}).objects);
    } catch { /* status stream will retry */ }
  };

  const corporationAliases = useMemo(() => {
    const counts = new Map<string,number>();
    const clean = (value:string|null) => (value || "").replace(/^\[|\]$/g, "").replace(/\s+/g, "").toUpperCase();
    const fold = (value:string) => value.replace(/G/g,"6").replace(/O/g,"0").replace(/[IL]/g,"1").replace(/S/g,"5").replace(/B/g,"8");
    [...localEvents.map(event => event.corporation), ...localObjects.map(object => object.corporation)].forEach(value => {
      const ticker = clean(value);
      if (ticker) counts.set(ticker, (counts.get(ticker) || 0) + 1);
    });
    const aliases = new Map<string,string>();
    for (const ticker of counts.keys()) {
      const candidates = [...counts.keys()].filter(candidate => candidate.length === ticker.length && fold(candidate) === fold(ticker));
      aliases.set(ticker, candidates.sort((a,b) => (counts.get(b)||0)-(counts.get(a)||0))[0] || ticker);
    }
    return aliases;
  }, [localEvents, localObjects]);
  const canonicalCorporation = useCallback((value:string|null) => {
    const clean = (value || "").replace(/^\[|\]$/g, "").replace(/\s+/g, "").toUpperCase();
    return corporationAliases.get(clean) || clean || "미확인";
  }, [corporationAliases]);

  const mappedLiveEvents = useMemo<EventItem[]>(() => localEvents.map(event => {
    const typeMap:Record<string,EventType> = {
      warp_in:"워프인", warp_out:"워프아웃", docked:"도킹", jump_in:"점프인", jump_out:"점프아웃",
      undocked:"언독", signature_created:"시그니처", signature_destroyed:"시그니처", appeared:"오버뷰 인", disappeared:"오버뷰 아웃",
      covop_in:"코옵인", covop_out:"코옵아웃",
    };
    const type = typeMap[event.type] || "시그니처";
    const dockCountDetail = ["docked","undocked"].includes(event.type)
      && typeof event.details.dockCountBefore === "number" && Number.isSafeInteger(event.details.dockCountBefore)
      && typeof event.details.dockCountAfter === "number" && Number.isSafeInteger(event.details.dockCountAfter)
      ? `도킹 수 ${event.details.dockCountBefore} → ${event.details.dockCountAfter}` : null;
    const detailParts = [event.ship, dockCountDetail, Number.isFinite(event.speed) ? `${Number(event.speed).toLocaleString()} m/s` : null].filter(Boolean);
    const signatureState = event.type === "signature_created" ? "생성" : event.type === "signature_destroyed" ? "소멸" : null;
    const verification = (["warp_in","warp_out","docked","undocked"].includes(event.type))
      && (event.details.verification === "estimated" || event.details.verification === "confirmed")
      ? event.details.verification : undefined;
    return {
      id:event.id,
      time:event.time.slice(11,19),
      type,
      name:event.character || "미확인 대상",
      corp:event.corporation ? `[${canonicalCorporation(event.corporation)}]` : "—",
      detail:signatureState ? `${signatureState} · ${String(event.details.name || "미확인 시그니처")}` : detailParts.join(" · ") || "세부 정보 분석 중",
      source:event.watcherLabel || "미지정 눈깔",
      confidence:Math.round((event.confidence ?? 0) * 100),
      image:event.imageId ? `${LOCAL_API}/api/images/${event.imageId}/source` : "/lanturn-full.png",
      filename:event.filename || "원본 이미지",
      imageId:event.imageId,
      ship:event.ship || "",
      previousImage:event.previousImageId ? `${LOCAL_API}/api/images/${event.previousImageId}/source` : null,
      previousFilename:event.previousFilename || null,
      verification,
    };
  }), [localEvents, canonicalCorporation]);

  const visibleEvents = useMemo(() => {
    const scoped = watcherFilter === "전체" ? (serviceOnline ? mappedLiveEvents : EVENTS) : (serviceOnline ? mappedLiveEvents : EVENTS).filter(e => e.source === watcherFilter);
    // Search runs last, so it only looks inside what the watcher/type filters already let through.
    return scoped
      .filter(event => eventFilters.includes(categoryFor(event.type)))
      .filter(event => eventMatchesSearch(event, searchQuery, searchExact, searchFields));
  }, [eventFilters, watcherFilter, searchQuery, searchExact, searchFields, mappedLiveEvents, serviceOnline]);

  const liveCounts = useMemo(() => {
    const latest = buildLatestStates(localEvents, localObjects, canonicalCorporation);
    return {
      docked: [...latest.values()].filter(item => item.status === "docked").length,
      observed: [...latest.values()].filter(item => item.status === "observed").length,
      departed: [...latest.values()].filter(item => item.status === "departed").length,
    };
  }, [localEvents, localObjects, canonicalCorporation]);
  const liveSummaryRows = useMemo<Record<SummaryKey,LiveSummaryRow[]>>(() => {
    const grouped:Record<SummaryKey,LiveSummaryRow[]> = {docked:[], observed:[], departed:[]};
    for (const item of buildLatestStates(localEvents, localObjects, canonicalCorporation).values()) {
      grouped[item.status].push({ticker:item.corporation==="미확인"?"—":`[${item.corporation}]`,character:item.character,ship:item.ship,source:item.source,time:item.time.slice(11,19)});
    }
    return grouped;
  }, [localEvents, localObjects, canonicalCorporation]);
  const watcherNeedingReview = watchers.find(watcher => !watcher.live && watcher.files === "영역 재설정 필요");
  const recognitionWarning = regionWarnings[0];
  const liveCorpGroups = useMemo<LiveCorpGroup[]>(() => {
    const active = new Map<string,{character:string;ship:string;corporation:string;status:"docked"|"observed";time:string;source:string}>();
    for (const object of localObjects) {
      active.set(object.character, { character:object.character, ship:object.ship||"미확인 함선", corporation:object.corporation||"미확인", status:"observed", time:object.lastSeenAt, source:object.watcherLabel });
    }
    for (const event of localEvents) {
      if (!event.character || active.has(event.character)) continue;
      if (event.type === "docked") active.set(event.character, { character:event.character, ship:event.ship||"미확인 함선", corporation:event.corporation||"미확인", status:"docked", time:event.time, source:event.watcherLabel||"미지정 눈깔" });
    }
    const groups = new Map<string,LiveCorpGroup>();
    for (const member of active.values()) {
      const ticker = canonicalCorporation(member.corporation);
      const key = ticker.toUpperCase();
      const group = groups.get(key) || { key, name:ticker==="미확인"?"소속 미확인":ticker, ticker:ticker==="미확인"?"—":`[${ticker}]`, detected:0, docked:0, observed:0, ships:[], members:[] };
      group.detected += 1;
      group[member.status] += 1;
      const ship = group.ships.find(item => item[0] === member.ship);
      if (ship) ship[1] += 1; else group.ships.push([member.ship,1]);
      const history = localEvents.filter(event => event.character === member.character && event.ship).filter((event,index,array) => array.findIndex(candidate => candidate.ship === event.ship) === index).map(event => ({time:event.time.slice(11,19),ship:event.ship||"미확인 함선",source:event.watcherLabel||"미지정 눈깔"}));
      group.members.push({ name:member.character, sightings:history.length?history:[{time:member.time.slice(11,19),ship:member.ship,source:member.source}] });
      groups.set(key, group);
    }
    return [...groups.values()].sort((a,b) => b.detected-a.detected || a.name.localeCompare(b.name));
  }, [localEvents, localObjects, canonicalCorporation]);

  const headingTimestamp = useMemo(() => {
    if (!latestCaptureAt) return "감시 데이터 대기 중";
    const [date,time=""] = latestCaptureAt.split("T");
    const [year,month,day] = date.split("-");
    const monthName = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][Number(month)-1] || month;
    return `${day} ${monthName} ${year} · ${time.slice(0,5)} KST`;
  }, [latestCaptureAt]);

  useEffect(() => {
    if (!window.localStorage.getItem("eve-cctv-folder-configured")) {
      queueMicrotask(() => setFolderOpen(true));
    }
  }, []);

  const openNewWatcher = useCallback(() => {
    setEditingWatcherId(null); setClientName(detectedCharacters[0] || ""); setWatchLabel(""); setWatchType("structure"); setDraftRegions([]); setSetupStep(0); setSetupOpen(true);
  }, [detectedCharacters]);

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      try {
        const response = await fetch(`${LOCAL_API}/api/status`, { cache: "no-store" });
        if (!response.ok) throw new Error("local service unavailable");
        const status = await response.json() as LocalStatus;
        if (active) { applyLocalStatus(status); void loadLiveData(); }
      } catch {
        if (active) setServiceOnline(false);
      }
    };
    void loadStatus();
    const stream = new EventSource(`${LOCAL_API}/api/stream`);
    stream.addEventListener("status", event => {
      if (!active) return;
      try { applyLocalStatus(JSON.parse((event as MessageEvent).data) as LocalStatus); void loadLiveData(); } catch { /* reconnect on the next event */ }
    });
    stream.onerror = () => setServiceOnline(false);
    return () => { active = false; stream.close(); };
  }, []);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: {signal: AbortSignal}) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: "read_recent_cctv_events",
        title: "최근 CCTV 이벤트 읽기",
        description: "현재 화면에 표시된 최근 EVE CCTV 감지 이벤트를 시간순으로 읽습니다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async () => {
          try {
            const response = await fetch(`${LOCAL_API}/api/events?limit=50`, { cache:"no-store" });
            if (response.ok) return (await response.json() as {events:LocalEvent[]}).events;
          } catch { /* fall through to offline preview data */ }
          return EVENTS.map(({time,type,name,corp,detail,source,confidence}) => ({time,type,name,corp,detail,source,confidence}));
        },
      }, {signal: lifecycle.signal});
      await context.registerTool({
        name: "start_watcher_setup",
        title: "감시 눈깔 설정 시작",
        description: "CCTV 폴더에서 발견된 캐릭터를 선택하고 감지 위치, 감시 타입, 인식 영역을 지정하는 창을 엽니다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: () => { openNewWatcher(); return {status: "opened", step: "character"}; },
      }, {signal: lifecycle.signal});
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [openNewWatcher]);

  const editWatcher = (id:string) => {
    const watcher = watchers.find(w => w.id === id);
    if (!watcher) return;
    setEditingWatcherId(id);
    setClientName(watcher.character);
    setWatchLabel(watcher.label);
    setWatchType(watcher?.type.startsWith("스트") ? "structure" : "gate");
    setDraftRegions([...(regionConfigs[id] || [])]);
    setSetupStep(2); setSetupOpen(true);
  };

  const changeVisionMode = async (mode:VisionMode) => {
    const previous = visionMode;
    setVisionModeState(mode);
    try {
      const response = await fetch(`${LOCAL_API}/api/settings/vision-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error("save failed");
      applyLocalStatus(await response.json() as LocalStatus);
    } catch {
      setVisionModeState(previous);
      setToast("인식 모드를 변경하지 못했습니다. 로컬 서비스를 확인해주세요.");
      window.setTimeout(() => setToast(""), 2600);
    }
  };

  const pickFolder = async () => {
    try {
      const response = await fetch(`${LOCAL_API}/api/folder/select`, { method: "POST" });
      if (response.status === 204) return;
      if (!response.ok) throw new Error("native picker unavailable");
      const status = await response.json() as LocalStatus;
      applyLocalStatus(status);
      setToast(`${status.folder.name} 폴더를 감시합니다.`);
      window.setTimeout(() => setToast(""), 2600);
      return;
    } catch {
      setServiceOnline(false);
    }
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (picker) {
      try {
        const handle = await picker.call(window);
        let count = 0;
        const found = new Set<string>();
        for await (const [filename, entry] of (handle as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
          if (entry.kind === "file" && filename.toLowerCase().endsWith(".png")) {
            count++;
            const match = filename.match(/^CCTV\d+_(.+)\.png$/i);
            if (match?.[1]) found.add(match[1]);
          }
        }
        setFolderName(handle.name);
        setFolderPath(`${handle.name} · 브라우저 임시 연결`);
        setFolderCount(count);
        if (found.size) setDetectedCharacters([...found]);
        window.localStorage.setItem("eve-cctv-folder-configured", "1");
        setFolderOpen(false);
        setToast(`${handle.name} 폴더를 연결했습니다.`);
        window.setTimeout(() => setToast(""), 2600);
        return;
      } catch { return; }
    }
    inputRef.current?.click();
  };

  const handleFolderFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const first = files[0] as File & { webkitRelativePath?: string };
    const found = new Set<string>();
    Array.from(files).forEach(file => { const match=file.name.match(/^CCTV\d+_(.+)\.png$/i); if(match?.[1]) found.add(match[1]); });
    setFolderName(first.webkitRelativePath?.split("/")[0] || "선택한 폴더");
    setFolderPath("브라우저 임시 연결 · 프로그램 재시작 후 다시 선택 필요");
    setFolderCount(Array.from(files).filter(f => f.name.toLowerCase().endsWith(".png")).length);
    if (found.size) setDetectedCharacters([...found]);
    window.localStorage.setItem("eve-cctv-folder-configured", "1");
    setFolderOpen(false);
  };

  const saveSetup = async () => {
    const watcherId = editingWatcherId || `watcher-${Date.now()}`;
    const savedWatcher:Watcher = { id:watcherId, label:watchLabel || clientName, character:clientName, type: watchType === "structure" ? "스트럭쳐" : "웜홀 / 게이트", files: "대기 중", live: serviceOnline, regions: draftRegions.length };
    setRegionConfigs(prev => ({...prev, [watcherId]: draftRegions}));
    if (!editingWatcherId) {
      setWatchers([...watchers, savedWatcher]);
    } else {
      setWatchers(watchers.map(w => w.id === watcherId ? savedWatcher : w));
    }
    setSetupOpen(false); setSetupStep(0);
    try {
      const response = await fetch(`${LOCAL_API}/api/watchers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id:watcherId, label:savedWatcher.label, character:clientName, watchType, enabled:true, regions:draftRegions }),
      });
      if (!response.ok) throw new Error("save failed");
      applyLocalStatus(await response.json() as LocalStatus);
      setToast("감시 설정을 SQLite에 저장했습니다. 새 이미지를 기다리는 중입니다.");
    } catch {
      setServiceOnline(false);
      setToast("화면에는 저장했지만 로컬 감시 서비스가 오프라인입니다.");
    }
    window.setTimeout(() => setToast(""), 3000);
  };

  const removeWatcher = async () => {
    if (!removingWatcherId) return;
    const target = watchers.find(watcher => watcher.id === removingWatcherId);
    try {
      const response = await fetch(`${LOCAL_API}/api/watchers/${encodeURIComponent(removingWatcherId)}`,{method:"DELETE"});
      if (!response.ok) throw new Error("delete failed");
      applyLocalStatus(await response.json() as LocalStatus);
      await loadLiveData();
      setRemovingWatcherId(null);
      setToast(`${target?.label || "감시 클라이언트"}와 해당 감지 기록을 제거했습니다.`);
    } catch {
      setToast("감시 클라이언트를 제거하지 못했습니다. 로컬 서비스를 확인해주세요.");
    }
    window.setTimeout(() => setToast(""),3000);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Eye size={18}/></span><span>EVE CCTV</span></div>
        <div className="top-actions">
          <button className="folder-pill" onClick={() => setFolderOpen(true)}><FolderOpen size={14}/><span>{folderName}</span><small>{folderCount}장</small></button>
          <div className="live-pill"><span className={monitoring && serviceOnline ? "pulse" : "dot amber"}/><span>{!serviceOnline ? "로컬 감시 서비스 오프라인" : monitoring ? `${watchers.length}개 눈깔 감시 중` : "감시 일시정지"}</span></div>
          <button className="btn icon" aria-label="알림"><Bell size={17}/></button>
          <button className="btn icon" aria-label="설정" onClick={() => setFolderOpen(true)}><Settings2 size={17}/></button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-label">감시 클라이언트</div>
          {watchers.map((watcher) => (
            <div className="watcher-row" key={watcher.id}>
              <button className="watcher" onClick={() => editWatcher(watcher.id)}>
                <span className="watcher-icon">{watcher.type.startsWith("스트") ? <Crosshair size={16}/> : <Waves size={16}/>}</span>
                <span className="watcher-copy">
                  <span className="watcher-title">{watcher.label}</span>
                  <span className="watcher-meta"><span className={watcher.live ? "dot" : "dot amber"}/><span className="watcher-meta-text">{watcher.character} · {watcher.live ? `영역 ${watcher.regions}개` : watcher.files}</span></span>
                </span>
              </button>
              <button className="watcher-remove" aria-label={`${watcher.label} 감시 목록에서 제거`} title="감시 목록에서 제거" onClick={() => setRemovingWatcherId(watcher.id)}><Minus size={14}/></button>
            </div>
          ))}
          <button className="empty-add" onClick={openNewWatcher}><Plus size={13} style={{display:"inline",verticalAlign:"-2px"}}/> 눈깔 추가</button>
        </aside>

        <main className="main">
          <section className="heading-row">
            <div><p className="eyebrow">{headingTimestamp}</p><h1>야간 감시 현황</h1><p className="subhead">이미지 {folderCount}장 · OCR {processingCounts.processed}장 완료 · 대기 {processingCounts.pending}장</p></div>
            <div className="top-actions">
              <button className="btn" onClick={() => { setMonitoring(!monitoring); setToast(monitoring ? "감시를 일시정지했습니다." : "감시를 다시 시작했습니다."); window.setTimeout(() => setToast(""), 2200); }}>{monitoring ? <Pause size={16}/> : <Play size={16}/>} {monitoring ? "감시 정지" : "감시 시작"}</button>
              <button className="btn primary" onClick={openNewWatcher}><Plus size={16}/> 눈깔 등록</button>
            </div>
          </section>

          {watcherNeedingReview && <button className="review-banner" onClick={() => editWatcher(watcherNeedingReview.id)}><span className="review-icon"><ScanLine size={17}/></span><span><strong>{watcherNeedingReview.label} 인식 영역을 다시 확인해주세요.</strong><small>세로형 이미지 좌표 보정이 적용되었습니다. 저장하면 폴더 이미지 분석이 자동으로 시작됩니다.</small></span><ChevronRight size={17}/></button>}
          {!watcherNeedingReview && recognitionWarning && <button className="review-banner" onClick={() => editWatcher(recognitionWarning.watcherId)}><span className="review-icon"><ScanLine size={17}/></span><span><strong>{recognitionWarning.watcherLabel} · 영역 재설정 필요</strong><small>{recognitionWarning.message} UI 배율이나 창 위치가 바뀌었다면 영역을 다시 지정해주세요.</small></span><ChevronRight size={17}/></button>}

          <section className="stats" aria-label="감시 요약">
            <Stat title="현재 도킹 확인" value={serviceOnline?String(liveCounts.docked):"2"} note={serviceOnline && dockPeaks.length ? `최고 도킹 수 ${dockPeaks[0].peakCount}명` : "도킹 수 감지 대기"} icon={<ShieldCheck size={18}/>} onClick={() => setSummary("docked")}/>
            <Stat title="감지 · 미도킹" value={serviceOnline?String(liveCounts.observed):"2"} note={serviceOnline?"현재 위치 미확정":"2개 콥 · 함선 2대"} icon={<Users size={18}/>} onClick={() => setSummary("observed")}/>
            <Stat title="성계 이탈" value={serviceOnline?String(liveCounts.departed):"3"} note={serviceOnline?"워프·점프아웃 판정":"최근 60분 · 3개 콥"} icon={<Ship size={18}/>} onClick={() => setSummary("departed")}/>
          </section>

          <section className="content-grid">
            <div className="panel timeline-panel">
              <div className="panel-head">
                <div><h2 className="panel-title">감지 타임라인</h2><div className="panel-note">속도 변화와 화면 이탈을 결합한 판정</div></div>
                <div className="filter-row" role="group" aria-label="표시할 감지 항목">{EVENT_FILTERS.map(category => <button key={category} type="button" className={`filter ${eventFilters.includes(category)?"active":""}`} aria-pressed={eventFilters.includes(category)} onClick={() => setEventFilters(current => current.includes(category) ? current.filter(item => item !== category) : [...current, category])}>{category}</button>)}</div>
              </div>
              {watchers.length>1 && <div className="filter-row watcher-filter-row">{["전체",...watchers.map(w=>w.label)].map(f => <button key={f} className={`filter ${watcherFilter===f?"active":""}`} onClick={() => setWatcherFilter(f)}>{f}</button>)}</div>}
              <div className="timeline-search" role="search">
                <div className="timeline-search-input"><Search size={14}/><input type="search" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="캐릭터 · 함선 · 콥 티커 검색" aria-label="타임라인 검색"/>{searchQuery && <button type="button" aria-label="검색어 지우기" onClick={()=>setSearchQuery("")}><X size={13}/></button>}</div>
                <div className="filter-row" role="group" aria-label="검색 방식">{[false,true].map(exact => <button key={String(exact)} type="button" className={`filter ${searchExact===exact?"active":""}`} aria-pressed={searchExact===exact} onClick={()=>setSearchExact(exact)}>{exact?"완전일치":"일부일치"}</button>)}</div>
                <div className="filter-row" role="group" aria-label="검색 대상">{SEARCH_FIELDS.map(field => <button key={field.key} type="button" className={`filter ${searchFields.includes(field.key)?"active":""}`} aria-pressed={searchFields.includes(field.key)} onClick={()=>setSearchFields(current => current.includes(field.key) ? (current.length>1 ? current.filter(item=>item!==field.key) : current) : [...current, field.key])}>{field.label}</button>)}</div>
              </div>
              <div className="event-list">
                {visibleEvents.length===0 && searchQuery.trim() && eventFilters.length>0 && <div className="panel-empty"><Search size={20}/><strong>검색 결과가 없습니다.</strong><span>현재 선택한 감시 클라이언트·감지 항목 안에서 &quot;{searchQuery.trim()}&quot;을(를) 찾지 못했습니다.</span></div>}
                {visibleEvents.length===0 && (!searchQuery.trim() || !eventFilters.length) && <div className="panel-empty"><Radar size={20}/><strong>{!eventFilters.length ? "표시할 항목을 선택해주세요." : eventFilters.length === EVENT_FILTERS.length ? "아직 판정된 이벤트가 없습니다." : "선택한 조건의 기록이 없습니다."}</strong><span>{!eventFilters.length ? "위의 분류 버튼을 눌러 여러 항목을 함께 표시할 수 있습니다." : eventFilters.length === EVENT_FILTERS.length ? "인식 영역을 확인하면 폴더 이미지를 시간순으로 분석합니다." : "다른 항목을 선택하거나 인식 영역을 확인해주세요."}</span></div>}
                {visibleEvents.map((event) => (
                  <button className="event-row" key={event.id} onClick={() => setSelected(event)}>
                    <span className="event-time">{event.time}</span>
                    <span className={`event-icon ${toneFor(event.type)}`}>{iconFor(event.type)}</span>
                    <span><span className="event-name">{event.name}</span><span className="event-detail">{event.type}{event.verification && <span className={`event-verification ${event.verification}`}>{event.verification === "confirmed" ? "확정" : "추정"}</span>} · {event.detail}</span></span>
                    <span className="corp-ticker">{event.corp}</span>
                    <span className="event-source">{event.source}</span>
                    <span className="confidence">인식 {event.confidence}%</span>
                    <ChevronRight size={16} color="#657394"/>
                  </button>
                ))}
              </div>
            </div>

            <CorpOverview onSelect={setCorpDetail} live={serviceOnline} liveGroups={liveCorpGroups} onSelectLive={setLiveCorpDetail}/>
            <SignaturePanel live={serviceOnline} current={localSignatures} history={localEvents}/>
          </section>
        </main>
      </div>

      <EvidenceDialog event={selected} onClose={() => setSelected(null)}/>
      <SummaryDialog kind={summary} live={serviceOnline} liveRows={summary?liveSummaryRows[summary]:[]} dockPeaks={dockPeaks} onClose={() => setSummary(null)}/>
      <CorpDetailDialog corp={corpDetail} onClose={() => setCorpDetail(null)}/>
      <LiveCorpDetailDialog corp={liveCorpGroups.find(group => group.key===liveCorpDetail)||null} onClose={() => setLiveCorpDetail(null)}/>
      <RemoveWatcherDialog watcher={watchers.find(watcher=>watcher.id===removingWatcherId)||null} onCancel={()=>setRemovingWatcherId(null)} onConfirm={removeWatcher}/>
      <FolderDialog open={folderOpen} onOpenChange={v => { setFolderOpen(v); if(!v && folderPath) window.localStorage.setItem("eve-cctv-folder-configured", "1"); }} folderName={folderName} folderPath={folderPath} folderCount={folderCount} characters={detectedCharacters} serviceOnline={serviceOnline} pickFolder={pickFolder} visionMode={visionMode} setVisionMode={changeVisionMode}/>
      <SetupDialog open={setupOpen} onOpenChange={setSetupOpen} step={setupStep} setStep={setSetupStep} characters={detectedCharacters} characterStats={characterStats} clientName={clientName} setClientName={setClientName} watchLabel={watchLabel} setWatchLabel={setWatchLabel} watchType={watchType} setWatchType={setWatchType} regions={draftRegions} setRegions={setDraftRegions} save={saveSetup}/>
      <input ref={inputRef} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string,string>)} onChange={e => handleFolderFiles(e.target.files)}/>
      {toast && <div className="toast"><Check size={16} color="#68b7ff"/>{toast}</div>}
    </div>
  );
}

function Stat({title,value,note,icon,onClick}:{title:string;value:string;note:string;icon:React.ReactNode;onClick:()=>void}) {
  return <button className="stat-card" onClick={onClick}><div className="stat-head"><span>{title}</span><span className="stat-icon">{icon}</span></div><div className="stat-value">{value}</div><div className="stat-note">{note}</div><span className="stat-open">상세 보기 <ChevronRight size={13}/></span></button>;
}

function CorpOverview({onSelect,live,liveGroups,onSelectLive}:{onSelect:(corp:CorpKey)=>void;live:boolean;liveGroups:LiveCorpGroup[];onSelectLive:(key:string)=>void}) {
  return <div className="panel corp-panel">
    <div className="panel-head"><div><h2 className="panel-title">코퍼레이션별 전력 현황</h2><div className="panel-note">도킹 확인과 감지 · 미도킹 대상 집계</div></div><Users size={17} color="#7bbcff"/></div>
    {live ? liveGroups.length ? <div className="corp-card-list">{liveGroups.map((corp,index) => <button className="corp-summary-card" key={corp.key} onClick={() => onSelectLive(corp.key)}>
      <span className={`corp-mark ${index%2?"worm":"nova"}`}>{corp.name.slice(0,2).toUpperCase()}</span>
      <span className="corp-summary-main"><span className="corp-summary-name">{corp.name} <small>{corp.ticker}</small></span><span className="corp-summary-note">도킹 {corp.docked} · 미도킹 {corp.observed} · 함선 {corp.ships.reduce((sum,item)=>sum+item[1],0)}대</span></span>
      <span className="corp-summary-count"><strong>{corp.detected}</strong><small>현재 인원</small></span><ChevronRight size={17} color="#657394"/>
    </button>)}</div> : <div className="panel-empty compact"><Users size={19}/><strong>코퍼레이션 전력 분석 대기</strong><span>오버뷰에서 콥 티커가 인식되면 이곳에 자동 집계됩니다.</span></div> :
    <div className="corp-card-list">
      {(Object.entries(CORP_DATA) as [CorpKey,(typeof CORP_DATA)[CorpKey]][]).map(([key,corp]) => (
        <button className="corp-summary-card" key={key} onClick={() => onSelect(key)}>
          <span className={`corp-mark ${key}`}>{corp.name.slice(0,2)}</span>
          <span className="corp-summary-main">
            <span className="corp-summary-name">{corp.name} <small>{corp.ticker}</small></span>
            <span className="corp-summary-note">도킹 {corp.docked} · 미도킹 {corp.observed} · 함선 {corp.ships.reduce((sum,item) => sum + item[1],0)}대</span>
          </span>
          <span className="corp-summary-count"><strong>{corp.detected}</strong><small>현재 인원</small></span>
          <ChevronRight size={17} color="#657394"/>
        </button>
      ))}
    </div>}
  </div>;
}

function LiveCorpDetailDialog({corp,onClose}:{corp:LiveCorpGroup|null;onClose:()=>void}) {
  return <Dialog open={!!corp} onOpenChange={v=>!v&&onClose()}><DialogContent className="dialog-wide corp-detail-dialog">{corp&&<>
    <div className="corp-detail-hero"><div className="corp-detail-identity"><span className="corp-mark large nova">{corp.name.slice(0,2).toUpperCase()}</span><div><span className="corp-detail-kicker">코퍼레이션 전력 상세</span><DialogTitle>{corp.name} <small>{corp.ticker}</small></DialogTitle></div></div><div className="corp-detail-headcount"><strong>{corp.detected}</strong><span>현재 감지 인원</span></div></div>
    <div className="corp-detail-body"><section className="corp-member-history"><div className="detail-section-head"><div><h3>캐릭터별 감지 함선</h3><p>동일 캐릭터·동일 함선의 반복 감지는 한 번만 표시합니다.</p></div><b>{corp.members.length}명</b></div><div className="member-history-list">{corp.members.map(member=><article className="member-history" key={member.name}><div className="member-name-row"><span className="member-avatar">{member.name.slice(0,2).toUpperCase()}</span><strong>{member.name}</strong></div><div className="sighting-list">{member.sightings.map(sighting=><div className="sighting-row" key={`${member.name}-${sighting.ship}`}><span className="sighting-branch">└</span><time>{sighting.time}</time><strong>{sighting.ship}</strong><span>{sighting.source}</span></div>)}</div></article>)}</div></section>
      <aside className="corp-force-summary"><div className="detail-section-head"><div><h3>현재 전력 요약</h3><p>마지막 확인 상태 기준</p></div></div><div className="force-counts"><div><span>도킹 확인</span><strong>{corp.docked}</strong></div><div><span>감지 · 미도킹</span><strong>{corp.observed}</strong></div></div><div className="ship-summary-list">{corp.ships.map(([ship,count])=><div key={ship}><span>{ship}</span><strong>× {count}</strong></div>)}</div></aside>
    </div>
  </>}</DialogContent></Dialog>;
}

// "코즈믹" (Cosmic) alone is enough — no other signature type starts with it,
// and OCR routinely truncates or garbles the rest of "시그니처" ("시그L", "시그니" etc.).
const UNSCANNED_SIGNATURE = /^\s*코즈믹/;
function signatureFields(rawName:string, rawGroup:string) {
  const name = rawName || "미확인";
  const unscanned = UNSCANNED_SIGNATURE.test(name);
  return { name, group: unscanned ? "" : (rawGroup || "미확인"), unscanned };
}
// Hand-drawn approximations of EVE's own exploration-type glyphs (ore/gas/relic/
// data/wormhole/combat), matched to the reference icon set rather than picking
// the nearest generic lucide icon.
function OreIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="7.5" r="4"/><circle cx="7" cy="16" r="4"/><circle cx="17" cy="16" r="4"/></svg>;
}
function GasIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><path d="M12 21c5-6 7-9.4 7-12.5a7 7 0 00-14 0C5 11.6 7 15 12 21z"/></svg>;
}
function RelicIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6.5"/><path d="M4.5 8a9 9 0 000 8"/><path d="M19.5 8a9 9 0 010 8"/></svg>;
}
function DataIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><line x1="9" y1="7.5" x2="9" y2="16.5"/><line x1="12" y1="7.5" x2="12" y2="16.5"/><line x1="15" y1="7.5" x2="15" y2="16.5"/></svg>;
}
function WormholeIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">{[0,60,120,180,240,300].map(deg => <path key={deg} transform={`rotate(${deg} 12 12)`} d="M12 12 Q13.6 6.5 12 3 Q10.4 6.5 12 12Z"/>)}</svg>;
}
function CombatIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"><path d="M12 3L21 12L12 21L3 12Z"/><path d="M8 10l4 4 4-4"/></svg>;
}

function iconForSignature(group:string, unscanned:boolean) {
  if (unscanned) return <HelpCircle size={14}/>;
  if (group.includes("웜홀")) return <WormholeIcon/>;
  if (group.includes("전투")) return <CombatIcon/>;
  if (group.includes("데이터")) return <DataIcon/>;
  if (group.includes("유물")) return <RelicIcon/>;
  if (group.includes("가스")) return <GasIcon/>;
  if (group.includes("광물") || group.includes("광석")) return <OreIcon/>;
  return <Radar size={14}/>;
}

function SignaturePanel({live,current:liveCurrent,history:liveHistory}:{live:boolean;current:LocalSignature[];history:LocalEvent[]}) {
  const sampleCurrent = [
    {state:"현재", time:"01:30", id:"DZC-4", name:"불안정한 웜홀", group:"웜홀"},
    {state:"현재", time:"00:54", id:"AHQ-5", name:"코어 요새", group:"전투 사이트"},
    {state:"현재", time:"23:41", id:"DEZ-0", name:"잊힌 전초기지", group:"데이터"},
    {state:"현재", time:"22:18", id:"LFJ-5", name:"코즈믹 시그니처", group:"미확인"},
  ];
  const sampleHistory = [
    {state:"생성", time:"01:26", id:"DZC-4", name:"불안정한 웜홀", group:"웜홀"},
    {state:"소멸", time:"01:24", id:"MAC-7", name:"코어 요새", group:"전투 사이트"},
    {state:"생성", time:"00:54", id:"AHQ-5", name:"코어 요새", group:"전투 사이트"},
    {state:"소멸", time:"00:31", id:"GTR-2", name:"미확인 유물", group:"유물"},
  ];
  const current = live ? liveCurrent.map(signature => ({state:"현재",time:signature.lastSeenAt.slice(11,16),id:signature.id,...signatureFields(signature.name||"",signature.groupName||"")})) : sampleCurrent.map(row => ({...row,...signatureFields(row.name,row.group)}));
  const history = live ? liveHistory.filter(event => event.type.startsWith("signature_")).map(event => ({state:event.type==="signature_created"?"생성":"소멸",time:event.time.slice(11,16),id:event.character||"---",...signatureFields(String(event.details.name||""),String(event.details.group||""))})) : sampleHistory.map(row => ({...row,...signatureFields(row.name,row.group)}));
  const latestSignatureTime = [...liveCurrent.map(item => item.lastSeenAt), ...liveHistory.filter(event => event.type.startsWith("signature_")).map(event => event.time)].sort().at(-1);
  const signatureWatcher = liveCurrent[0]?.watcherLabel || liveHistory.find(event => event.type.startsWith("signature_"))?.watcherLabel || "시그니처 감시 눈깔";
  const currentList = (rows:typeof current) => <div className="signature-list">
    <div className="signature-row signature-header current"><span/><span>시간</span><span>ID</span><span>시그니처 이름</span><span>그룹</span></div>
    {rows.map((row,i) => <div className="signature-row current" key={`${row.id}-${i}`}>
      <span className="signature-icon">{iconForSignature(row.group,row.unscanned)}</span>
      <span className="signature-time">{row.time}</span><strong>{row.id}</strong><span>{row.name}</span><span className="signature-group">{row.group}</span>
    </div>)}
  </div>;
  const historyList = (rows:typeof history) => <div className="signature-list">
    <div className="signature-row signature-header history"><span/><span/><span>시간</span><span>ID</span><span>시그니처 이름</span><span>그룹</span></div>
    {rows.map((row,i) => <div className="signature-row history" key={`${row.id}-${row.state}-${i}`}>
      <span className={`signature-delta ${row.state === "소멸" ? "lost" : "gained"}`}>{row.state === "소멸" ? <Minus size={12}/> : <Plus size={12}/>}</span>
      <span className="signature-icon">{iconForSignature(row.group,row.unscanned)}</span>
      <span className="signature-time">{row.time}</span><strong>{row.id}</strong><span>{row.name}</span><span className="signature-group">{row.group}</span>
    </div>)}
  </div>;
  return <section className="panel signature-panel">
    <div className="panel-head"><div><h2 className="panel-title">프로빙 변화</h2><div className="panel-note">{live ? `${signatureWatcher} · 마지막 갱신 ${latestSignatureTime?.slice(11,19) || "대기 중"}` : "1번 스트럭쳐 · 마지막 갱신 01:30:02"}</div></div><ScanLine size={17} color="#a58cff"/></div>
    <div className="signature-columns">
      <div className="signature-column"><div className="signature-column-title"><span>현재 존재하는 시그니처</span><b>{current.length}</b></div>{current.length?currentList(current):<div className="signature-empty">현재 인식된 시그니처 없음</div>}</div>
      <div className="signature-column"><div className="signature-column-title"><span>생성 · 소멸 기록</span><b>전체 기록</b></div>{history.length?historyList(history):<div className="signature-empty">생성·소멸 기록 없음</div>}</div>
    </div>
  </section>;
}

function SummaryDialog({kind,live,liveRows,dockPeaks,onClose}:{kind:SummaryKey|null;live:boolean;liveRows:LiveSummaryRow[];dockPeaks:DockPeak[];onClose:()=>void}) {
  const data = kind ? SUMMARY_DATA[kind] : null;
  const rows:LiveSummaryRow[] = kind ? (live ? liveRows : SUMMARY_DATA[kind].rows.map(row => ({ticker:row[0],character:row[1],ship:row[2],source:"미리보기",time:"--:--:--"}))) : [];
  return <Dialog open={!!kind} onOpenChange={v => !v && onClose()}><DialogContent className="dialog-wide summary-dialog">
    {data && <><div className="dialog-head"><DialogHeader><DialogTitle>{data.title} 상세</DialogTitle><DialogDescription>{data.caption}</DialogDescription></DialogHeader></div>
    <div className="dialog-body">
    {kind === "docked" && <section className="dock-peak-section">
      <div className="dock-peak-head"><strong>감지된 최고 도킹 수</strong><span>스트럭쳐 감시 위치별 최고 기록 · 서로 다른 위치의 숫자는 합산하지 않습니다.</span></div>
      {live && dockPeaks.length ? <div className="dock-peak-list">{dockPeaks.map(peak => <div className="dock-peak-row" key={peak.watcherId}>
        <strong title={peak.watcherLabel}>{peak.watcherLabel}</strong><b>{peak.peakCount}명</b><time>{peak.capturedAt?.slice(0,19).replace("T"," ")}</time>
        <span className="dock-peak-evidence"><a href={`${LOCAL_API}/api/images/${peak.imageId}/source`} target="_blank" rel="noreferrer">원본 이미지</a><a href={`${LOCAL_API}/api/observations/${peak.observationId}/crop`} target="_blank" rel="noreferrer">인식 영역</a></span>
      </div>)}</div> : <div className="dock-peak-empty">아직 도킹 숫자를 읽은 이미지가 없습니다.</div>}
    </section>}
    <div className="summary-table">
      <div className="summary-row summary-row-head"><span>콥 티커</span><span>캐릭터</span><span>함선</span><span>감지 위치</span><span>시간</span></div>
      {rows.length===0?<div className="panel-empty compact"><span>현재 조건에 해당하는 인원이 없습니다.</span></div>:rows.map((row,i) => <div className="summary-row" key={`${row.character}-${i}`}><span className="corp-ticker">{row.ticker}</span><strong>{row.character}</strong><span>{row.ship}</span><span>{row.source}</span><time>{row.time}</time></div>)}
    </div><div className="summary-foot">총 {rows.length}명 · {new Set(rows.map(row => row.ticker)).size}개 코퍼레이션 · 함선 {rows.length}대</div></div></>}
  </DialogContent></Dialog>;
}

function CorpDetailDialog({corp,onClose}:{corp:CorpKey|null;onClose:()=>void}) {
  const data = corp ? CORP_DATA[corp] : null;
  return <Dialog open={!!corp} onOpenChange={v => !v && onClose()}><DialogContent className="dialog-wide corp-detail-dialog">
    {data && <>
      <div className="corp-detail-hero">
        <div className="corp-detail-identity">
          <span className={`corp-mark large ${corp}`}>{data.name.slice(0,2)}</span>
          <div><span className="corp-detail-kicker">코퍼레이션 전력 상세</span><DialogTitle>{data.name} <small>{data.ticker}</small></DialogTitle></div>
        </div>
        <div className="corp-detail-headcount"><strong>{data.detected}</strong><span>현재 감지 인원</span></div>
      </div>
      <div className="corp-detail-body">
        <section className="corp-member-history">
          <div className="detail-section-head"><div><h3>캐릭터별 감지 함선</h3><p>동일 캐릭터·동일 함선의 반복 감지는 한 번만 표시합니다.</p></div><b>{data.members.length}명</b></div>
          <div className="member-history-list">
            {data.members.map(member => <article className="member-history" key={member.name}>
              <div className="member-name-row"><span className="member-avatar">{member.name.slice(0,2).toUpperCase()}</span><strong>{member.name}</strong></div>
              <div className="sighting-list">
                {member.sightings.map(sighting => <div className="sighting-row" key={`${member.name}-${sighting.ship}`}>
                  <span className="sighting-branch">└</span><time>{sighting.time}</time><strong>{sighting.ship}</strong><span>{sighting.source}</span>
                </div>)}
              </div>
            </article>)}
          </div>
        </section>
        <aside className="corp-force-summary">
          <div className="detail-section-head"><div><h3>현재 전력 요약</h3><p>마지막 확인 상태 기준</p></div></div>
          <div className="force-counts"><div><span>도킹 확인</span><strong>{data.docked}</strong></div><div><span>감지 · 미도킹</span><strong>{data.observed}</strong></div></div>
          <div className="ship-summary-list">
            {data.ships.map(([ship,count]) => <div key={ship}><span>{ship}</span><strong>× {count}</strong></div>)}
          </div>
        </aside>
      </div>
    </>}
  </DialogContent></Dialog>;
}

function EvidenceDialog({event,onClose}:{event:EventItem|null;onClose:()=>void}) {
  const [observations,setObservations] = useState<{kind:RegionKind;payload:{sourceBox?:{left:number;top:number;width:number;height:number}}}[]>([]);
  const [imageSize,setImageSize] = useState({width:0,height:0});
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setObservations([]);
      setImageSize({width:0,height:0});
    });
    if (!event?.imageId) return () => { active = false; };
    fetch(`${LOCAL_API}/api/images/${event.imageId}`,{cache:"no-store"}).then(response => response.ok?response.json():null).then((data:unknown) => {
      if (active && data && typeof data === "object" && "observations" in data && Array.isArray(data.observations)) setObservations(data.observations);
    }).catch(() => undefined);
    return () => { active = false; };
  },[event?.imageId]);
  const targetKind:RegionKind = event?.type === "시그니처" ? "probe" : event?.type === "도킹" ? "dock" : "overview";
  const sourceBox = observations.find(observation => observation.kind === targetKind)?.payload?.sourceBox;
  const overlayStyle = sourceBox && imageSize.width && imageSize.height ? {
    left:`${sourceBox.left/imageSize.width*100}%`,top:`${sourceBox.top/imageSize.height*100}%`,width:`${sourceBox.width/imageSize.width*100}%`,height:`${sourceBox.height/imageSize.height*100}%`,right:"auto",
  } : undefined;
  return <Dialog open={!!event} onOpenChange={v => !v && onClose()}><DialogContent className="dialog-wide">
    {event && <><div className="dialog-head"><DialogHeader><DialogTitle>{event.type} 판정 근거</DialogTitle><DialogDescription>{event.filename}</DialogDescription></DialogHeader></div>
    <div className="dialog-body"><div className="evidence-grid">
      <div className="evidence-image-col">
        {event.previousImage && <div className="evidence-image compare">
          <span className="evidence-compare-tag">비교: 이전 프레임{event.previousFilename?` · ${event.previousFilename}`:""}</span>
          <img src={event.previousImage} alt={`${event.name} 이전 프레임`}/>
        </div>}
        <div className="evidence-image">
          {event.previousImage && <span className="evidence-compare-tag current">판정 프레임</span>}
          <img src={event.image} alt={`${event.name} 감지 원본 스크린샷`} onLoad={e=>setImageSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})}/>
          <div className={`evidence-box ${sourceBox?"measured":""}`} style={overlayStyle}><span className="evidence-label">{targetKind==="probe"?"프로빙":targetKind==="dock"?"도킹 숫자":"오버뷰"} 추출 영역</span></div>
        </div>
      </div>
      <div>
        <div className="fact"><div className="fact-label">판정</div><div className="fact-value"><strong>{event.type}{event.verification ? ` · ${event.verification === "confirmed" ? "확정" : "추정"}` : ""}</strong> · 인식 신뢰도 {event.confidence}%</div></div>
        <div className="fact"><div className="fact-label">캐릭터 / 콥 / 함선</div><div className="fact-value">{event.name} · {event.corp}<br/>{event.detail}</div></div>
        <div className="fact"><div className="fact-label">감시 눈깔</div><div className="fact-value">{event.source}</div></div>
        <div className="fact"><div className="fact-label">판정 규칙</div><div className="fact-value">{event.type === "워프인" ? event.verification === "estimated" ? "첫 관측 속도가 고속이지만 이후 감속은 아직 확인되지 않아 추정합니다." : "첫 관측 속도가 높고 다음 유효 관측에서 감속을 확인했습니다." : event.type === "워프아웃" ? event.verification === "estimated" ? "오버뷰 이탈 전 마지막 속도가 높지만 가속 변화는 확인되지 않아 추정합니다." : "오버뷰 이탈 전 마지막 속도가 높고 이전 유효 관측보다 상승했습니다." : event.type === "도킹" ? "오버뷰 이탈과 도킹 수 증가가 전후 2프레임 안에서 일치했습니다." : event.type === "언독" ? event.verification === "confirmed" ? "오버뷰 진입과 도킹 수 감소가 전후 2프레임 안에서 일치했습니다." : "오버뷰에 저속으로 등장했지만 도킹 수 감소는 아직 확인되지 않아 언독 추정입니다." : event.type.includes("점프") ? "웜홀 반경에서 감지된 뒤 오버뷰 진입·이탈 패턴이 확인됐습니다." : "전후 프레임의 지정 영역을 비교해 변화를 감지했습니다."}</div></div>
        <a className="btn" style={{width:"100%",marginTop:16}} href={event.image} target="_blank" rel="noreferrer"><FileImage size={16}/> 판정 프레임 원본 열기</a>
        {event.previousImage && <a className="btn" style={{width:"100%",marginTop:8}} href={event.previousImage} target="_blank" rel="noreferrer"><FileImage size={16}/> 이전 프레임 원본 열기</a>}
      </div>
    </div></div></>}
  </DialogContent></Dialog>;
}

function RemoveWatcherDialog({watcher,onCancel,onConfirm}:{watcher:Watcher|null;onCancel:()=>void;onConfirm:()=>void}) {
  return <Dialog open={!!watcher} onOpenChange={open=>!open&&onCancel()}><DialogContent className="remove-watcher-dialog">
    {watcher&&<><div className="dialog-head"><DialogHeader><DialogTitle>{watcher.label} 감시를 제거할까요?</DialogTitle><DialogDescription>{watcher.character}로 분석한 이 눈깔의 이벤트, 현재 대상 및 시그니처 기록이 초기화됩니다.</DialogDescription></DialogHeader></div>
    <div className="dialog-body"><div className="fact"><div className="fact-label">CCTV 원본 이미지</div><div className="fact-value">폴더의 PNG 파일은 삭제하지 않습니다. 같은 캐릭터를 다시 등록하면 폴더에 남은 스크린샷을 처음부터 다시 분석합니다.</div></div><div className="dialog-actions"><button className="btn" onClick={onCancel}>취소</button><button className="btn danger" onClick={onConfirm}><Minus size={15}/> 감시 제거</button></div></div></>}
  </DialogContent></Dialog>;
}

type SetupProps = {
  open:boolean; onOpenChange:(v:boolean)=>void; step:number; setStep:(n:number)=>void;
  characters:string[]; characterStats:Record<string,CharacterStat>; clientName:string; setClientName:(v:string)=>void;
  watchLabel:string; setWatchLabel:(v:string)=>void; watchType:string; setWatchType:(v:string)=>void;
  regions:BoxRect[]; setRegions:(v:BoxRect[])=>void; save:()=>void;
};

function SetupDialog(p:SetupProps) {
  return <Dialog open={p.open} onOpenChange={v => {p.onOpenChange(v); if(!v)p.setStep(0);}}><DialogContent className="dialog-wide">
    <div className="dialog-head"><DialogHeader><DialogTitle>감시 눈깔 등록</DialogTitle><DialogDescription>CCTV 캐릭터, 감지 위치, 감시 타입과 인식 영역을 설정합니다.</DialogDescription></DialogHeader></div>
    <div className="dialog-body">
      <div className="setup-steps">{[0,1,2].map(n => <span key={n} className={`setup-step ${n<=p.step?"on":""}`}/>)}</div>
      {p.step === 0 && <CharacterStep characters={p.characters} stats={p.characterStats} selected={p.clientName} setSelected={p.setClientName}/>}
      {p.step === 1 && <WatcherInfoStep character={p.clientName} label={p.watchLabel} setLabel={p.setWatchLabel} type={p.watchType} setType={p.setWatchType}/>}
      {p.step === 2 && <RegionEditor clientName={p.clientName} displayName={p.watchLabel} latestImageId={p.characterStats[p.clientName]?.latestImageId} latestCaptureAt={p.characterStats[p.clientName]?.latestCaptureAt} boxes={p.regions} setBoxes={p.setRegions}/>}
      <div className="dialog-actions">{p.step>0 && <button className="btn" onClick={() => p.setStep(p.step-1)}>이전</button>}<button className="btn primary" disabled={p.step===0&&!p.clientName || p.step===1&&!p.watchLabel.trim()} onClick={() => p.step<2 ? p.setStep(p.step+1) : p.save()}>{p.step<2 ? "다음" : "설정 저장"}</button></div>
    </div>
  </DialogContent></Dialog>;
}

const VISION_MODE_OPTIONS: {value:VisionMode; label:string; note:string}[] = [
  { value:"fallback", label:"Tesseract 우선 (기본)", note:"평소엔 빠른 로컬 OCR을 쓰고, 헤더 인식에 실패했을 때만 로컬 비전 모델(Ollama)로 보조 인식합니다." },
  { value:"always", label:"항상 비전 모델 사용", note:"매번 로컬 비전 모델을 호출합니다. 정확도는 가장 높지만 영역마다 처리 시간이 늘어납니다." },
  { value:"off", label:"비전 모델 사용 안 함", note:"Tesseract 결과만 사용합니다. Ollama가 없어도 동작합니다." },
];

function FolderDialog({open,onOpenChange,folderName,folderPath,folderCount,characters,serviceOnline,pickFolder,visionMode,setVisionMode}:{open:boolean;onOpenChange:(v:boolean)=>void;folderName:string;folderPath:string;folderCount:number;characters:string[];serviceOnline:boolean;pickFolder:()=>void;visionMode:VisionMode;setVisionMode:(mode:VisionMode)=>void}) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="dialog-wide folder-dialog">
    <div className="dialog-head"><DialogHeader><DialogTitle>설정</DialogTitle><DialogDescription>모든 눈깔의 스크린샷을 읽는 공용 폴더입니다. 최초 한 번만 지정합니다.</DialogDescription></DialogHeader></div>
    <div className="dialog-body"><div className={`service-banner ${serviceOnline?"online":"offline"}`}><span className={serviceOnline?"pulse":"dot amber"}/><span>{serviceOnline ? "로컬 감시 서비스 연결됨 · 2초마다 폴더 확인" : "로컬 감시 서비스 오프라인 · 브라우저 임시 선택만 가능"}</span></div><button type="button" className={`folder-card ${folderPath?"connected":""}`} onClick={pickFolder}><FolderOpen size={25} color="#70b7ff"/><div className="folder-copy"><div className="folder-name">{folderName}</div><div className="folder-path">{folderPath || "아직 선택된 폴더가 없습니다."}</div><div className="folder-path">PNG {folderCount}개 · 캐릭터 {characters.length}명 발견</div></div>{folderPath&&<ShieldCheck size={18} color="#70b7ff"/>}</button>
      <div className="detected-strip"><span>발견된 캐릭터</span>{characters.map(name=><b key={name}>{name}</b>)}</div>
      <div className="fact"><div className="fact-label">텍스트 인식 방식</div><div className="fact-value">인식 영역(오버뷰·프로빙 창·도킹 숫자)을 읽을 때 로컬 비전 모델(Ollama)을 얼마나 쓸지 정합니다.</div></div>
      <div className="vision-mode-list">{VISION_MODE_OPTIONS.map(option => (
        <button key={option.value} type="button" className={`vision-mode-option ${visionMode===option.value?"active":""}`} disabled={!serviceOnline} onClick={()=>setVisionMode(option.value)}>
          <span className="radio-dot">{visionMode===option.value && <Check size={12}/>}</span>
          <span><strong>{option.label}</strong><small>{option.note}</small></span>
        </button>
      ))}</div>
      <div className="fact"><div className="fact-label">폴더 기준 데이터 구성</div><div className="fact-value">프로그램을 켤 때 이 폴더에 남아 있는 이미지만 다시 불러옵니다. 폴더 이미지를 비운 뒤 재실행하면 이전 감지 데이터도 초기화됩니다.</div></div>
      <div className="dialog-actions"><button className="btn primary" onClick={()=>onOpenChange(false)}>확인</button></div>
    </div>
  </DialogContent></Dialog>;
}

function CharacterStep({characters,stats,selected,setSelected}:{characters:string[];stats:Record<string,CharacterStat>;selected:string;setSelected:(v:string)=>void}) {
  return <div><p className="eyebrow">01 · CHARACTER</p><h3 style={{margin:"0 0 8px",fontSize:19}}>감시에 사용할 캐릭터</h3><p className="subhead" style={{marginBottom:16}}>전역 CCTV 폴더의 파일명에서 발견된 캐릭터입니다.</p>
    <div className="character-grid">{characters.map(name=><button className={`character-card ${selected===name?"selected":""}`} key={name} onClick={()=>setSelected(name)}><span className="character-avatar">{name.slice(0,2).toUpperCase()}</span><span><strong>{name}</strong><small>스크린샷 {stats[name]?.imageCount ?? 0}장 · 최근 {stats[name]?.latestCaptureAt?.slice(11,19) || "미확인"}</small></span><span className="radio-dot">{selected===name&&<Check size={12}/>}</span></button>)}</div>
    <div className="folder-source-note"><FolderOpen size={14}/><span>EVE Alert CCTV / CCTV에서 불러옴</span></div>
  </div>;
}

function WatcherInfoStep({character,label,setLabel,type,setType}:{character:string;label:string;setLabel:(v:string)=>void;type:string;setType:(v:string)=>void}) {
  return <div><p className="eyebrow">02 · WATCHER</p><h3 style={{margin:"0 0 16px",fontSize:19}}>감시 위치 정보</h3><div className="form-grid"><div className="field"><label htmlFor="watch-label">감지 이름</label><input id="watch-label" placeholder="예: 1번 스트럭쳐" value={label} onChange={e=>setLabel(e.target.value)}/></div><div className="field"><label htmlFor="watch-type">감시 타입</label><select id="watch-type" value={type} onChange={e=>setType(e.target.value)}><option value="structure">스트럭쳐 감시</option><option value="gate">웜홀 / 게이트 감시</option></select></div></div><div className="selected-character-line"><span>선택된 캐릭터</span><strong>{character}</strong></div><div className="fact" style={{marginTop:12}}><div className="fact-label">적용 판정</div><div className="fact-value">{type === "structure" ? "도킹 카운터와 오버뷰 이탈을 함께 비교해 도킹 여부를 판정합니다." : "웜홀·게이트 랜딩 후 오버뷰 이탈을 점프아웃으로, 신규 출현을 점프인으로 판정합니다."}</div></div></div>;
}

function RegionEditor({clientName,displayName,latestImageId,latestCaptureAt,boxes,setBoxes}:{clientName:string;displayName:string;latestImageId?:number;latestCaptureAt?:string;boxes:BoxRect[];setBoxes:(v:BoxRect[])=>void}) {
  const [kind,setKind] = useState<RegionKind>("overview");
  const [start,setStart] = useState<{x:number;y:number}|null>(null);
  const [draft,setDraft] = useState<BoxRect|null>(null);
  const [contentBox,setContentBox] = useState({left:0,top:0,width:1,height:1});
  const editorRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const measureImageContent = () => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth || !image.naturalHeight) return;
    // offsetWidth/offsetHeight/offsetLeft/offsetTop reflect the layout box and are
    // unaffected by the dialog's open animation (CSS transform: scale), unlike
    // getBoundingClientRect() which returns mid-animation (shrunken) values and
    // caused already-saved regions to render shifted toward the top-left.
    const scale = Math.min(image.offsetWidth / image.naturalWidth, image.offsetHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    setContentBox({
      left: image.offsetLeft + (image.offsetWidth - width) / 2,
      top: image.offsetTop + (image.offsetHeight - height) / 2,
      width,
      height,
    });
  };
  useEffect(() => {
    const observer = new ResizeObserver(measureImageContent);
    if (editorRef.current) observer.observe(editorRef.current);
    if (imageRef.current) observer.observe(imageRef.current);
    window.addEventListener("resize", measureImageContent);
    measureImageContent();
    return () => { observer.disconnect(); window.removeEventListener("resize", measureImageContent); };
  }, [clientName]);
  const point = (e:React.PointerEvent) => { const r=editorRef.current!.getBoundingClientRect(); return {x:Math.max(0,Math.min(100,(e.clientX-r.left-contentBox.left)/contentBox.width*100)),y:Math.max(0,Math.min(100,(e.clientY-r.top-contentBox.top)/contentBox.height*100))}; };
  const down=(e:React.PointerEvent)=>{ editorRef.current?.setPointerCapture(e.pointerId); const p=point(e);setStart(p);setDraft({x:p.x,y:p.y,w:0,h:0,kind}); };
  const move=(e:React.PointerEvent)=>{ if(!start)return; const p=point(e);setDraft({x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y),kind}); };
  const up=()=>{ if(draft&&draft.w>2&&draft.h>2)setBoxes([...boxes,draft]);setDraft(null);setStart(null); };
  const color=(k:RegionKind)=>k==="overview"?"#65a9ff":k==="probe"?"#9b8cff":"#ff78b9";
  const sourceImage = latestImageId ? `${LOCAL_API}/api/images/${latestImageId}/source` : clientName === "CUDA_Toolkit" ? "/cuda-overview.png" : "/lanturn-full.png";
  return <div><p className="eyebrow">03 · DETECTION REGIONS</p><div className="region-title-row"><h3 style={{margin:"0 0 10px",fontSize:19}}>인식 영역 지정</h3><span className="editing-client">{displayName || clientName} · {clientName}</span></div>
    <div className="region-toolbar"><button className={`region-chip ${kind==="overview"?"active":""}`} onClick={()=>setKind("overview")}><span className="color"/>오버뷰</button><button className={`region-chip ${kind==="probe"?"active":""}`} onClick={()=>setKind("probe")}><span className="color"/>프로빙 창</button><button className={`region-chip ${kind==="dock"?"active":""}`} onClick={()=>setKind("dock")}><span className="color"/>도킹 숫자</button><button className="region-chip" onClick={()=>setBoxes([])}><X size={13}/> 모두 지우기</button></div>
    <div className={`editor ${clientName === "CUDA_Toolkit" ? "editor-wide" : ""}`} ref={editorRef} onPointerDown={down} onPointerMove={move} onPointerUp={up}><img ref={imageRef} onLoad={measureImageContent} src={sourceImage} alt={`${clientName} 영역 지정을 위한 감시 화면`}/>{[...boxes,...(draft?[draft]:[])].map((b,i)=><span key={i} className="selection" style={{left:contentBox.left+contentBox.width*b.x/100,top:contentBox.top+contentBox.height*b.y/100,width:contentBox.width*b.w/100,height:contentBox.height*b.h/100,borderColor:color(b.kind)}}/>)}</div>
    <p className="editor-help">CCTV 폴더에서 <strong>{clientName}</strong>의 가장 최근 스크린샷{latestCaptureAt?` (${latestCaptureAt.slice(11,19)})`:""}을 사용합니다. 이 영역은 다른 눈깔 설정에 영향을 주지 않습니다.</p></div>;
}
