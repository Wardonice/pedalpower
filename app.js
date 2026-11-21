'use strict';

/* =========================================================================
   KONŠTANTY
   ========================================================================= */
const MAPY_API_KEY = 'hGyz0ci75emI0QP9CjrtfA_Hx3qXyHFu_gaau1M8r8A';

const UUID_FTMS = '00001826-0000-1000-8000-00805f9b34fb';
const UUID_IBD  = '00002ad2-0000-1000-8000-00805f9b34fb';
const UUID_CP   = '00002ad9-0000-1000-8000-00805f9b34fb';
const UUID_FMS  = '00002ada-0000-1000-8000-00805f9b34fb';
const UUID_HRS  = '0000180d-0000-1000-8000-00805f9b34fb';
const UUID_HRM  = '00002a37-0000-1000-8000-00805f9b34fb';

const GRADE_MIN = -30;
const GRADE_MAX = 30;
const ELE_SMOOTH_HALF_M = 20;
const GRADE_WINDOW_HALF_M = 40;
const GRADE_AVG_HALF_M = 20;
const GRADE_FILTER_TAU_S = 1.4;
const GRADE_MAX_RATE = 3.5;
const PROFILE_MAX_POINTS = 800;
const MAP_MAX_POINTS = 4500;
const SIM_INTERVAL_MS = 650;
const CP_TIMEOUT_MS = 6000;
const CYCLING_EFFICIENCY = 0.24;
const KJ_PER_KCAL = 4.184;
const BIKE_WEIGHT_KG = 8.5;
const DRIVETRAIN_EFFICIENCY = 0.975;
const ROLLING_CRR = 0.004;
const AIR_RHO = 1.225;
const RIDER_CDA = 0.32;
const VIRTUAL_SPEED_TAU_S = 2.0;
const VIRTUAL_SPEED_MAX_MPS = 23.6; // ~85 km/h

function solveCyclingSpeedMps(powerW, gradePct, riderWeightKg) {
  const wheelPower = Math.max(0, powerW) * DRIVETRAIN_EFFICIENCY;
  if (wheelPower <= 0.1) return 0;

  const totalMass = Math.max(35, (Number(riderWeightKg) || 75) + BIKE_WEIGHT_KG);
  const slope = clamp(Number(gradePct) || 0, GRADE_MIN, GRADE_MAX) / 100;
  const hyp = Math.hypot(1, slope);
  const sinT = slope / hyp;
  const cosT = 1 / hyp;

  const a = 0.5 * AIR_RHO * RIDER_CDA;
  const b = totalMass * 9.80665 * (sinT + ROLLING_CRR * cosT);

  // Riešime a*v^3 + b*v - wheelPower = 0 na [0, VIRTUAL_SPEED_MAX_MPS].
  let lo = 0;
  let hi = VIRTUAL_SPEED_MAX_MPS;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) * 0.5;
    const f = a * mid * mid * mid + b * mid - wheelPower;
    if (f < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/* -------------------------------------------------------------------------
   SUPABASE – KONTO A ULOŽENÉ TRASY
   Doplň údaje z projektu: Supabase → Project Settings → API.
   Používaj iba verejný "anon public" kľúč. Service role kľúč sem NIKDY nedávaj.
   Prístup k trasám chráni RLS (Row Level Security) – pozri SETUP_SUPABASE.md.
   ------------------------------------------------------------------------- */
const SUPABASE_URL = 'https://bfxovzbjcsonukxvwylq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lpm7Yr64VjbRckKmvpqmLQ_ql2yawMq';
const ROUTES_TABLE = 'routes';
const ACTIVITIES_TABLE = 'activities';
const MAX_GPX_BYTES = 2 * 1024 * 1024;

const RIDER_WEIGHT_KEY = 'vct.riderWeight';
const RIDER_WEIGHT_UPDATED_KEY = 'vct.riderWeightUpdatedAt';
const RIDER_WEIGHT_MIN = 30;
const RIDER_WEIGHT_MAX = 250;
const RIDER_WEIGHT_META_KEY = 'rider_weight_kg';
const RIDER_WEIGHT_META_UPDATED_KEY = 'rider_weight_updated_at';

const GRADE_COLORS = {
  descent: '#38bdf8',
  flat: '#34d399',
  climb: '#f59e0b',
  steep: '#ef4444'
};

const POWER_ZONES = [
  { zone: 1, maxPct: 55, label: 'Z1', name: 'Regenerácia', color: '#94a3b8', textColor: '#cbd5e1' },
  { zone: 2, maxPct: 75, label: 'Z2', name: 'Vytrvalosť', color: '#38bdf8', textColor: '#38bdf8' },
  { zone: 3, maxPct: 90, label: 'Z3', name: 'Tempo', color: '#34d399', textColor: '#34d399' },
  { zone: 4, maxPct: 105, label: 'Z4', name: 'Prah (FTP)', color: '#c6f432', textColor: '#c6f432' },
  { zone: 5, maxPct: 120, label: 'Z5', name: 'VO2max', color: '#f59e0b', textColor: '#f59e0b' },
  { zone: 6, maxPct: Infinity, label: 'Z6', name: 'Anaeróbna', color: '#ef4444', textColor: '#ef4444' }
];

function powerZoneForPct(pct) {
  for (const item of POWER_ZONES) {
    if (pct < item.maxPct) return item;
  }
  return POWER_ZONES[POWER_ZONES.length - 1];
}

function powerZoneForWatts(power, ftp) {
  if (!(power > 0)) return null;
  const pct = (power / Math.max(50, ftp || 200)) * 100;
  return powerZoneForPct(pct);
}

const CP_RESULT_TEXT = {
  [-1]: 'trenažér neodpovedal (timeout)',
  [-2]: 'zápis do Control Point zlyhal',
  [-3]: 'spojenie sa prerušilo',
  [0x01]: 'úspech',
  [0x02]: 'príkaz nie je podporovaný',
  [0x03]: 'neplatný parameter',
  [0x04]: 'operácia zlyhala',
  [0x05]: 'kontrolu prevzala iná aplikácia'
};

const COLORS = {
  info: '#38bdf8',
  success: '#c6f432',
  warning: '#fbbf24',
  error: '#f87171'
};

/* =========================================================================
   WORKOUT – DEFINÍCIE A NASTAVENIA
   ========================================================================= */
const FTP_KEY = 'vct.ftp';
const FTP_UPDATED_KEY = 'vct.ftpUpdatedAt';
const FTP_MIN = 50;
const FTP_MAX = 600;
const FTP_DEFAULT = 200;
const FTP_META_KEY = 'ftp_w';
const FTP_META_UPDATED_KEY = 'ftp_updated_at';

const ERG_INTERVAL_MS = 1500;
const ERG_MIN_W = 0;
const ERG_MAX_W = 1500;
const ERG_MIN_DIFF_W = 3;

const WORKOUT_DEFS = [
  {
    id: 'threshold-vo2',
    name: '30/15 Threshold + VO2max',
    subtitle: '6× 30/15 na 85 % a 6× 30/15 na 115 %',
    phases: [
      { label: 'Rozcvička', kind: 'ramp', duration: 300, from: 50, to: 70 },
      { label: 'Threshold', kind: 'interval', repeat: 6, onDuration: 30, onPower: 85, offDuration: 15, offPower: 60 },
      { label: 'Z2', kind: 'z2', duration: 600, from: 65, to: 65 },
      { label: 'VO2max', kind: 'interval', repeat: 6, onDuration: 30, onPower: 115, offDuration: 15, offPower: 60 },
      { label: 'Upokojenie', kind: 'ramp', duration: 300, from: 60, to: 40 }
    ]
  },
  {
    id: 'threshold-2x20',
    name: '2× 20 min threshold',
    subtitle: 'Dva dlhé bloky na 95 % FTP s 5 min pauzou',
    phases: [
      { label: 'Rozcvička', kind: 'ramp', duration: 600, from: 50, to: 70 },
      { label: 'Threshold 1/2', kind: 'interval', duration: 1200, from: 95, to: 95 },
      { label: 'Pauza', kind: 'recover', duration: 300, from: 55, to: 55 },
      { label: 'Threshold 2/2', kind: 'interval', duration: 1200, from: 95, to: 95 },
      { label: 'Upokojenie', kind: 'ramp', duration: 300, from: 60, to: 40 }
    ]
  },
  {
    id: 'vo2max-4x4',
    name: '4× 4 min VO2max',
    subtitle: '4× 4 min na 115 % s 4 min výklusom',
    phases: [
      { label: 'Rozcvička', kind: 'ramp', duration: 600, from: 50, to: 70 },
      { label: 'VO2max', kind: 'interval', repeat: 4, onDuration: 240, onPower: 115, offDuration: 240, offPower: 50 },
      { label: 'Upokojenie', kind: 'ramp', duration: 300, from: 60, to: 40 }
    ]
  }
];

function workoutIntensity(phases, total) {
  if (!total) return 0;
  let sum = 0;
  for (const phase of phases) {
    const avg = ((phase.from + phase.to) / 2) / 100;
    sum += avg * avg * phase.duration;
  }
  return Math.sqrt(sum / total);
}

function expandWorkout(def) {
  const phases = [];

  for (const item of def.phases) {
    if (item.repeat) {
      for (let i = 0; i < item.repeat; i++) {
        phases.push({
          label: `${item.label} ${i + 1}/${item.repeat}`,
          kind: item.kind || 'interval',
          duration: item.onDuration,
          from: item.onPower,
          to: item.onPower
        });
        phases.push({
          label: `Pauza ${i + 1}/${item.repeat}`,
          kind: 'recover',
          duration: item.offDuration,
          from: item.offPower,
          to: item.offPower
        });
      }
    } else {
      phases.push({
        label: item.label,
        kind: item.kind || 'steady',
        duration: item.duration,
        from: item.from,
        to: item.to === undefined ? item.from : item.to
      });
    }
  }

  let start = 0;
  for (const phase of phases) {
    phase.start = start;
    start += phase.duration;
  }

  return {
    ...def,
    phases,
    totalDuration: start,
    intervalCount: phases.filter((phase) => phase.kind === 'interval').length,
    intensity: workoutIntensity(phases, start)
  };
}

const WORKOUTS = WORKOUT_DEFS.map(expandWorkout);
let selectedWorkoutId = WORKOUTS[0].id;

function workoutById(id) {
  return WORKOUTS.find((workout) => workout.id === id) || WORKOUTS[0];
}

/* =========================================================================
   DOM
   ========================================================================= */
const $ = (id) => document.getElementById(id);

const el = {
  map: $('map'),
  rideTime: $('rideTime'),
  timeCell: $('timeCell'),
  timeKicker: $('timeKicker'),
  gradeCell: $('gradeCell'),
  gradeChip: $('gradeChip'),
  gradeFill: $('gradeFill'),
  debugPanel: $('debugPanel'),
  debugText: $('debugText'),
  liveDot: $('liveDot'),
  hrValue: $('hrValue'),
  powerCell: $('powerCell'),
  powerZoneBadge: $('powerZoneBadge'),
  powerValue: $('powerValue'),
  wkgCell: $('wkgCell'),
  wkgValue: $('wkgValue'),

  btnTrainer: $('btnTrainer'),
  btnHr: $('btnHr'),
  btnGpx: $('btnGpx'),
  btnFinish: $('btnFinish'),
  btnHelp: $('btnHelp'),
  helpModal: $('helpModal'),
  btnCloseHelp: $('btnCloseHelp'),
  btnCloseHelpAction: $('btnCloseHelpAction'),

  btnWorkout: $('btnWorkout'),
  workoutModal: $('workoutModal'),
  btnCloseWorkout: $('btnCloseWorkout'),
  btnCloseWorkoutAction: $('btnCloseWorkoutAction'),
  workoutList: $('workoutList'),
  workoutFtp: $('workoutFtp'),
  btnFtpMinus: $('btnFtpMinus'),
  btnFtpPlus: $('btnFtpPlus'),
  btnWorkoutErg: $('btnWorkoutErg'),
  btnWorkoutManual: $('btnWorkoutManual'),
  workoutErgHint: $('workoutErgHint'),
  workoutRouteSelect: $('workoutRouteSelect'),
  workoutRouteText: $('workoutRouteText'),
  wpRouteLoad: $('wpRouteLoad'),
  workoutPreview: $('workoutPreview'),
  btnStartWorkout: $('btnStartWorkout'),

  workoutPanel: $('workoutPanel'),
  wpTarget: $('wpTarget'),
  wpSkip: $('wpSkip'),
  wpRemaining: $('wpRemaining'),
  wpGraph: $('wpGraph'),
  wpDoneShade: $('wpDoneShade'),
  wpPlayhead: $('wpPlayhead'),
  wpPlayDot: $('wpPlayDot'),
  wpPhaseLabel: $('wpPhaseLabel'),
  wpPhaseTime: $('wpPhaseTime'),
  wpBarFill: $('wpBarFill'),
  wpStop: $('wpStop'),

  btnRoutes: $('btnRoutes'),
  routesModal: $('routesModal'),
  btnCloseRoutes: $('btnCloseRoutes'),
  btnCloseRoutesAction: $('btnCloseRoutesAction'),
  btnActivities: $('btnActivities'),
  activitiesModal: $('activitiesModal'),
  btnCloseActivities: $('btnCloseActivities'),
  btnCloseActivitiesAction: $('btnCloseActivitiesAction'),
  activityDetailEmpty: $('activityDetailEmpty'),
  activityDetailContent: $('activityDetailContent'),
  adTime: $('adTime'),
  adDistance: $('adDistance'),
  adAvgPower: $('adAvgPower'),
  adAvgWkg: $('adAvgWkg'),
  adNp: $('adNp'),
  adNpWkg: $('adNpWkg'),
  adAvgHr: $('adAvgHr'),
  adAscent: $('adAscent'),
  adCalories: $('adCalories'),
  adWeight: $('adWeight'),

  btnAccount: $('btnAccount'),
  accountDot: $('accountDot'),
  accountModal: $('accountModal'),
  btnCloseAccount: $('btnCloseAccount'),
  btnCloseAccountAction: $('btnCloseAccountAction'),
  accountSubtitle: $('accountSubtitle'),
  accountSetup: $('accountSetup'),
  accountSetupNote: $('accountSetupNote'),
  accountRedirect: $('accountRedirect'),
  accountSignedOut: $('accountSignedOut'),
  accountSignedIn: $('accountSignedIn'),
  btnGoogleLogin: $('btnGoogleLogin'),
  accountAvatar: $('accountAvatar'),
  accountEmail: $('accountEmail'),
  btnSignOut: $('btnSignOut'),
  accountCurrent: $('accountCurrent'),
  btnSaveRoute: $('btnSaveRoute'),
  accountList: $('accountList'),
  accountEmpty: $('accountEmpty'),
  accountCount: $('accountCount'),
  accountError: $('accountError'),
  profileWeight: $('profileWeight'),
  profileFtp: $('profileFtp'),
  profileFtpWkg: $('profileFtpWkg'),
  btnMapTourist: $('btnMapTourist'),
  btnMapSatellite: $('btnMapSatellite'),
  btnMap3d: $('btnMap3d'),
  btnMapNorth: $('btnMapNorth'),
  btnMapHeading: $('btnMapHeading'),
  trainerDot: $('trainerDot'),
  hrDot: $('hrDot'),

  gpxInput: $('gpxInput'),
  btnLoadGpxEmpty: $('btnLoadGpxEmpty'),
  btnLoadDemoGpx: $('btnLoadDemoGpx'),
  profileEmpty: $('profileEmpty'),
  routeName: $('routeName'),
  routeMeta: $('routeMeta'),
  remainValue: $('remainValue'),
  profileCanvas: $('profileChart'),
  profileHover: $('profileHover'),

  finishModal: $('finishModal'),
  statRouteName: $('statRouteName'),
  statTime: $('statTime'),
  statDist: $('statDist'),
  statAscent: $('statAscent'),
  statAvgPower: $('statAvgPower'),
  statNp: $('statNp'),
  statCalories: $('statCalories'),
  statAvgWkg: $('statAvgWkg'),
  statAvgHr: $('statAvgHr'),
  btnCloseModal: $('btnCloseModal'),
  btnResetRide: $('btnResetRide'),
  btnResumeRide: $('btnResumeRide'),
  btnSaveActivity: $('btnSaveActivity'),
  btnExportStrava: $('btnExportStrava'),
  finishBadgeText: $('finishBadgeText'),
  btnActivityClose: $('btnActivityClose'),
  btnActivityDelete: $('btnActivityDelete'),
  activityList: $('activityList'),
  activityEmpty: $('activityEmpty'),
  activityCount: $('activityCount'),
  activityError: $('activityError'),

  toasts: $('toasts')
};

/* =========================================================================
   STAV APLIKÁCIE
   ========================================================================= */
const state = {
  route: null,
  routeGpxText: '',
  routeFileName: '',
  routeSavedId: null,
  rideM: 0,
  startM: 0,
  routeTravelBaseM: 0,
  rideSeconds: 0,
  power: 0,
  cadence: 0,
  speed: 0,
  hr: null,
  weight: 75,

  powerSum: 0,
  powerTime: 0,
  powerSamples: [],
  npBucketSum: 0,
  npBucketTime: 0,
  npWindow: [],
  npFourthSum: 0,
  npFourthCount: 0,
  tcxSamples: [],
  energyKcal: 0,
  ascentM: 0,
  lastEle: null,
  hrMovingSum: 0,
  hrMovingTime: 0,
  hrAllSum: 0,
  hrAllTime: 0,
  ridePaused: false,
  lastSavedRideSeconds: null,
  lastSavedRideM: null,

  currentGrade: 0,
  targetGrade: 0,
  profileKm: 0,
  lastBikeAt: 0,
  lastHrAt: 0,
  routeFinished: false,
  mapRideStarted: false,

  trainerBaseM: null,
  trainerDistOffset: 0,
  hasTotalDistance: false,
  lastTotalM: null,
  lastTotalAt: 0,
  lastTotalDistance: null,
  lastTotalDelta: 0,
  lastDistChangeAt: 0,
  distanceFallback: false,
  virtualSpeedMps: 0,
  connectingTrainer: false,
  connectingHr: false,

  simErrorShown: false,

  ftp: FTP_DEFAULT,
  workout: null,
  workoutActive: false,
  workoutPaused: false,
  workoutPhaseIndex: 0,
  workoutPhaseElapsed: 0,
  workoutElapsed: 0,
  workoutTargetPower: 0,
  workoutLoopIndex: 0,
  workoutErg: false,
  workoutErgPreferred: true,
  workoutBeepMuted: false,
  workoutLastBeepSecond: null,
  workoutSummaryName: ''
};

try {
  const storedWeight = parseFloat(localStorage.getItem(RIDER_WEIGHT_KEY));
  if (Number.isFinite(storedWeight) && storedWeight >= RIDER_WEIGHT_MIN && storedWeight <= RIDER_WEIGHT_MAX) {
    state.weight = storedWeight;
  }
} catch (_) {}

try {
  const storedFtp = normalizeFtp(localStorage.getItem(FTP_KEY));
  if (storedFtp !== null) state.ftp = storedFtp;
} catch (_) {}

/* =========================================================================
   POMOCNÉ FUNKCIE
   ========================================================================= */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

function formatGrade(grade) {
  if (!Number.isFinite(grade)) grade = 0;
  const sign = grade > 0 ? '+' : '';
  return `${sign}${grade.toFixed(1)} %`;
}

function formatKm(km, decimals = 2) {
  if (!Number.isFinite(km)) return '--';
  if (Math.abs(km) >= 100) return km.toFixed(1);
  return km.toFixed(decimals);
}

function gradeColor(grade) {
  if (!Number.isFinite(grade)) return GRADE_COLORS.flat;
  if (grade < -1) return GRADE_COLORS.descent;
  if (grade < 2) return GRADE_COLORS.flat;
  if (grade < 10) return GRADE_COLORS.climb;
  return GRADE_COLORS.steep;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* =========================================================================
   TOASTY
   ========================================================================= */
let toastTimers = new Map();

function showToast(message, type = 'info', duration = 4500) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.setProperty('--tc', COLORS[type] || COLORS.info);

  const text = document.createElement('div');
  text.textContent = message;
  text.style.minWidth = '0';

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Zavrieť');
  close.textContent = '×';
  close.addEventListener('click', () => removeToast(toast));

  toast.append(text, close);
  el.toasts.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  // Odstraňuj hneď (nie s animáciou) – inak by podmienka cyklu zostala
  // pravdivá a pri piatom toaste by sa stránka zablokovala v nekonečnom cykle.
  while (el.toasts.children.length > 4) {
    const oldest = el.toasts.firstElementChild;
    if (!oldest) break;
    const timer = toastTimers.get(oldest);
    if (timer) clearTimeout(timer);
    toastTimers.delete(oldest);
    oldest.remove();
  }

  const timer = setTimeout(() => removeToast(toast), duration);
  toastTimers.set(toast, timer);
}

function removeToast(toast) {
  if (!toast || !toast.isConnected) return;
  const timer = toastTimers.get(toast);
  if (timer) clearTimeout(timer);
  toastTimers.delete(toast);
  toast.classList.remove('show');
  toast.classList.add('hide');
  setTimeout(() => toast.remove(), 220);
}

/* =========================================================================
   MAPA – Mapy.com dlaždice + MapLibre GL JS (2D / 3D terén)
   ========================================================================= */
const MAPY_TILE_SIZE = window.devicePixelRatio > 1 ? '256@2x' : '256';
const MAPY_ATTRIBUTION = '<a href="https://api.mapy.com/copyright" target="_blank" rel="noopener">&copy; Seznam.cz a.s. a další</a>';
const TERRAIN_DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAP_3D_KEY = 'vct.map3d';
const MAP_HEADING_KEY = 'vct.mapHeading';
const MAP_3D_PITCH = 58;
const MAP_3D_EXAGGERATION = 1.25;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const MAP_TYPES = {
  tourist: {
    url: `https://api.mapy.com/v1/maptiles/outdoor/${MAPY_TILE_SIZE}/{z}/{x}/{y}?apikey=${MAPY_API_KEY}&lang=sk`,
    maxZoom: 19
  },
  satellite: {
    url: `https://api.mapy.com/v1/maptiles/aerial/256/{z}/{x}/{y}?apikey=${MAPY_API_KEY}&lang=sk`,
    maxZoom: 18
  }
};

// Počiatočný pohľad: celé Slovensko [lon, lat].
const SLOVAKIA_BOUNDS = [[16.80, 47.70], [22.60, 49.65]];

let activeMapType = 'satellite';
let map3dEnabled = false;
let mapHeadingEnabled = false;
let mapReady = false;
let routeBounds = null;
let pendingRouteLine = EMPTY_FC;
let pendingRouteEndpoints = EMPTY_FC;
let lastFollowAt = 0;
let lastUserInteractAt = 0;

try {
  // Predvolene (pri prvej návšteve) je mapa 3D v režime Smer; neskôr platí posledná voľba.
  const stored3d = localStorage.getItem(MAP_3D_KEY);
  const storedHeading = localStorage.getItem(MAP_HEADING_KEY);
  map3dEnabled = stored3d === null ? true : stored3d === '1';
  mapHeadingEnabled = storedHeading === null ? true : storedHeading === '1';
} catch (_) {
  map3dEnabled = true;
  mapHeadingEnabled = true;
}

const map = new maplibregl.Map({
  container: 'map',
  center: [19.6, 48.85],
  zoom: 6.8,
  minZoom: 2,
  maxZoom: 18,
  maxPitch: 75,
  attributionControl: false,
  dragRotate: true,
  pitchWithRotate: true,
  style: {
    version: 8,
    sources: {
      'mapy-tourist': {
        type: 'raster',
        tiles: [MAP_TYPES.tourist.url],
        tileSize: 256,
        maxzoom: MAP_TYPES.tourist.maxZoom,
        attribution: MAPY_ATTRIBUTION
      },
      'mapy-satellite': {
        type: 'raster',
        tiles: [MAP_TYPES.satellite.url],
        tileSize: 256,
        maxzoom: MAP_TYPES.satellite.maxZoom,
        attribution: MAPY_ATTRIBUTION
      },
      'terrain-dem': {
        type: 'raster-dem',
        tiles: [TERRAIN_DEM_TILES],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: 'Elevation: AWS Open Data'
      },
      'route-line': {
        type: 'geojson',
        data: EMPTY_FC
      },
      'route-endpoints': {
        type: 'geojson',
        data: EMPTY_FC
      }
    },
    layers: [
      {
        id: 'layer-tourist',
        type: 'raster',
        source: 'mapy-tourist',
        layout: { visibility: 'none' }
      },
      {
        id: 'layer-satellite',
        type: 'raster',
        source: 'mapy-satellite',
        layout: { visibility: 'visible' }
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route-line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#071018',
          'line-width': 8,
          'line-opacity': 0.52
        }
      },
      {
        id: 'route-main',
        type: 'line',
        source: 'route-line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ef4444',
          'line-width': 4.5,
          'line-opacity': 0.98
        }
      },
      {
        id: 'route-endpoints-layer',
        type: 'circle',
        source: 'route-endpoints',
        paint: {
          'circle-radius': 5.5,
          'circle-stroke-color': '#081017',
          'circle-stroke-width': 2,
          'circle-color': ['match', ['get', 'kind'], 'end', '#c6f432', '#ffffff']
        }
      }
    ]
  }
});

map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

function markUserMapInteraction(ev) {
  if (ev && ev.originalEvent) lastUserInteractAt = Date.now();
}
map.on('dragstart', markUserMapInteraction);
map.on('rotatestart', markUserMapInteraction);
map.on('pitchstart', markUserMapInteraction);
map.on('wheel', markUserMapInteraction);

const riderMarkerEl = document.createElement('div');
riderMarkerEl.className = 'rider-marker-wrap';
riderMarkerEl.innerHTML = '<div class="rider-marker"><span class="rider-pulse"></span><span class="rider-core"></span></div>';

const riderMarker = new maplibregl.Marker({
  element: riderMarkerEl,
  anchor: 'center'
}).setLngLat([19.6, 48.85]);

let riderMarkerAdded = false;
function setRiderPosition(lat, lon, ensureAdded = false) {
  riderMarker.setLngLat([lon, lat]);
  if (ensureAdded && !riderMarkerAdded) {
    riderMarker.addTo(map);
    riderMarkerAdded = true;
  }
}

function getProfilePanelHeight() {
  return parseFloat(getComputedStyle(document.body).getPropertyValue('--profile-h')) || 168;
}

function riderCameraPadding() {
  const panelH = getProfilePanelHeight();
  if (map3dEnabled && mapHeadingEnabled) {
    return {
      top: Math.round(window.innerHeight * 0.28),
      bottom: panelH + 12,
      left: 20,
      right: 20
    };
  }
  return {
    top: 96,
    bottom: panelH + 16,
    left: 20,
    right: 20
  };
}

function currentRouteDistM() {
  if (!state.route) return 0;
  return clamp(state.startM + state.rideM - state.routeTravelBaseM, 0, state.route.totalM);
}

function computeRouteBearing(distM = currentRouteDistM()) {
  if (!state.route || state.route.points.length < 2) return 0;
  const lookAhead = 45;
  let d0 = clamp(distM, 0, state.route.totalM);
  let d1 = Math.min(state.route.totalM, d0 + lookAhead);
  if (d1 - d0 < 5 && d0 > 5) {
    d1 = d0;
    d0 = Math.max(0, d1 - lookAhead);
  }
  const p0 = sampleRoute(d0);
  const p1 = sampleRoute(d1);
  if (!p0 || !p1) return 0;
  const rad = Math.PI / 180;
  const lat1 = p0.lat * rad;
  const lat2 = p1.lat * rad;
  const dLon = (p1.lon - p0.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

function currentTargetBearing(distM = currentRouteDistM()) {
  if (!mapHeadingEnabled) return 0;
  return state.route ? computeRouteBearing(distM) : map.getBearing();
}

function applyTerrainAndSky() {
  if (!mapReady) return;
  try {
    if (map3dEnabled) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: MAP_3D_EXAGGERATION });
      if (typeof map.setSky === 'function') {
        map.setSky({
          'sky-color': '#4c79b0',
          'horizon-color': '#bfd4e8',
          'fog-color': '#c7d8e8',
          'sky-horizon-blend': 0.55,
          'horizon-fog-blend': 0.7,
          'fog-ground-blend': 0.85,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0.75]
        });
      }
    } else {
      map.setTerrain(null);
      if (typeof map.setSky === 'function') {
        map.setSky(undefined);
      }
    }
  } catch (err) {
    console.warn('3D terrain toggle error:', err);
  }
}

function syncMapTypeUi() {
  const isTourist = activeMapType === 'tourist';
  document.body.classList.toggle('map-tourist', isTourist);
  el.btnMapTourist.classList.toggle('active', isTourist);
  el.btnMapSatellite.classList.toggle('active', !isTourist);
  el.btnMapTourist.setAttribute('aria-pressed', String(isTourist));
  el.btnMapSatellite.setAttribute('aria-pressed', String(!isTourist));
}

function setMapType(type) {
  if (!MAP_TYPES[type]) return;
  activeMapType = type;
  const maxZoom = MAP_TYPES[type].maxZoom;
  map.setMaxZoom(maxZoom);
  if (map.getZoom() > maxZoom) map.setZoom(maxZoom);

  if (mapReady) {
    map.setLayoutProperty('layer-tourist', 'visibility', type === 'tourist' ? 'visible' : 'none');
    map.setLayoutProperty('layer-satellite', 'visibility', type === 'satellite' ? 'visible' : 'none');
  }
  syncMapTypeUi();
}

function syncMap3dUi() {
  if (!el.btnMap3d) return;
  el.btnMap3d.classList.toggle('active', map3dEnabled);
  el.btnMap3d.setAttribute('aria-pressed', String(map3dEnabled));
  el.btnMap3d.title = map3dEnabled
    ? '3D pohľad zapnutý (kliknutím prepneš na 2D)'
    : '3D pohľad s reliéfom terénu';
}

function setMap3d(enabled, animate = true) {
  map3dEnabled = Boolean(enabled);
  try { localStorage.setItem(MAP_3D_KEY, map3dEnabled ? '1' : '0'); } catch (_) {}
  syncMap3dUi();
  if (!mapReady) return;

  applyTerrainAndSky();
  const targetPitch = map3dEnabled ? MAP_3D_PITCH : 0;
  map.easeTo({
    pitch: targetPitch,
    bearing: currentTargetBearing(),
    padding: riderCameraPadding(),
    duration: animate ? 650 : 0
  });
}

function syncMapHeadingUi() {
  if (!el.btnMapHeading || !el.btnMapNorth) return;
  el.btnMapHeading.classList.toggle('active', mapHeadingEnabled);
  el.btnMapNorth.classList.toggle('active', !mapHeadingEnabled);
  el.btnMapHeading.setAttribute('aria-pressed', String(mapHeadingEnabled));
  el.btnMapNorth.setAttribute('aria-pressed', String(!mapHeadingEnabled));
}

function setMapHeading(enabled, animate = true) {
  mapHeadingEnabled = Boolean(enabled);
  try { localStorage.setItem(MAP_HEADING_KEY, mapHeadingEnabled ? '1' : '0'); } catch (_) {}
  syncMapHeadingUi();
  if (!mapReady) return;

  map.easeTo({
    bearing: currentTargetBearing(),
    padding: riderCameraPadding(),
    duration: animate ? 500 : 0
  });
}

syncMapTypeUi();
syncMap3dUi();
syncMapHeadingUi();

el.btnMapTourist.addEventListener('click', () => setMapType('tourist'));
el.btnMapSatellite.addEventListener('click', () => setMapType('satellite'));
if (el.btnMap3d) el.btnMap3d.addEventListener('click', () => setMap3d(!map3dEnabled));
if (el.btnMapHeading) el.btnMapHeading.addEventListener('click', () => setMapHeading(true));
if (el.btnMapNorth) el.btnMapNorth.addEventListener('click', () => setMapHeading(false));

function fitSlovakiaOnMap() {
  map.fitBounds(SLOVAKIA_BOUNDS, {
    padding: { top: 118, bottom: 196, left: 24, right: 24 },
    maxZoom: 7.5,
    pitch: map3dEnabled ? MAP_3D_PITCH : 0,
    bearing: 0,
    duration: 0
  });
}

map.on('load', () => {
  mapReady = true;
  map.setLayoutProperty('layer-tourist', 'visibility', activeMapType === 'tourist' ? 'visible' : 'none');
  map.setLayoutProperty('layer-satellite', 'visibility', activeMapType === 'satellite' ? 'visible' : 'none');
  map.getSource('route-line').setData(pendingRouteLine);
  map.getSource('route-endpoints').setData(pendingRouteEndpoints);
  applyTerrainAndSky();
  if (routeBounds) {
    fitRouteOnMap(false);
  } else {
    fitSlovakiaOnMap();
  }
});

function trainerInMotion() {
  if (!trainer) return false;
  const now = performance.now();
  if (now - state.lastBikeAt > 6000) return false;
  return state.speed > 0.8 || state.power > 10;
}

function flyToRider(latlng, zoom) {
  const targetZoom = Math.min(zoom, MAP_TYPES[activeMapType].maxZoom);
  map.flyTo({
    center: [latlng[1], latlng[0]],
    zoom: targetZoom,
    pitch: map3dEnabled ? MAP_3D_PITCH : 0,
    bearing: currentTargetBearing(),
    padding: riderCameraPadding(),
    duration: 1100
  });
}

function updateMapPosition(sample, force = false) {
  if (!sample) return;
  const latlng = [sample.lat, sample.lon];
  setRiderPosition(sample.lat, sample.lon);

  // Kamera sleduje jazdca iba počas jazdy. Keď trenažér stojí,
  // mapa zostane na mieste a dá sa voľne posúvať, nakláňať a približovať.
  if (!trainerInMotion()) return;

  const now = Date.now();
  // Po ručnom posune alebo otočení mapy dáme používateľovi 5 s pokoj.
  if (!force && now - lastUserInteractAt < 5000) return;

  if (!state.mapRideStarted) {
    if (state.rideM > 20) {
      state.mapRideStarted = true;
      flyToRider(latlng, map3dEnabled ? 15 : 14.5);
      lastFollowAt = now;
    }
    return;
  }

  if (!force && now - lastFollowAt < 950) return;

  const easeOpts = {
    center: [sample.lon, sample.lat],
    padding: riderCameraPadding(),
    duration: 950,
    easing: (t) => t
  };
  if (mapHeadingEnabled) {
    easeOpts.bearing = computeRouteBearing(sample.distM);
  }
  map.easeTo(easeOpts);
  lastFollowAt = now;
}

function fitRouteOnMap(animate = true) {
  if (!routeBounds) return;
  const isNarrow = window.innerWidth <= 980;
  const panelH = getProfilePanelHeight();
  map.fitBounds(routeBounds, {
    padding: {
      top: isNarrow ? 175 : 140,
      bottom: panelH + 40,
      left: isNarrow ? 24 : 56,
      right: isNarrow ? 24 : 56
    },
    maxZoom: 15,
    pitch: map3dEnabled ? MAP_3D_PITCH : 0,
    bearing: mapHeadingEnabled && state.route ? computeRouteBearing(state.startM) : 0,
    duration: animate ? 700 : 0
  });
}

/* =========================================================================
   VÝŠKOVÝ PROFIL – Chart.js (FAREBNÝ PODĽA SKLONU, BEZ ČÍSEL)
   ========================================================================= */
let profileChart = null;

const areaByGradePlugin = {
  id: 'areaByGrade',
  beforeDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const points = meta && meta.data;
    const data = chart.data.datasets[0] && chart.data.datasets[0].data;
    if (!points || !data || points.length < 2) return;

    const { ctx, chartArea } = chart;
    ctx.save();
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const g0 = Number(data[i]?.grade) || 0;
      const g1 = Number(data[i + 1]?.grade) || 0;
      const color = gradeColor((g0 + g1) / 2);
      ctx.fillStyle = hexToRgba(color, 0.22);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p1.x, chartArea.bottom);
      ctx.lineTo(p0.x, chartArea.bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
};

const currentPositionPlugin = {
  id: 'currentPosition',
  afterDatasetsDraw(chart) {
    if (!state.route || !Number.isFinite(state.profileKm)) return;
    const { ctx, chartArea } = chart;
    const x = clamp(
      chart.scales.x.getPixelForValue(state.profileKm),
      chartArea.left + 2,
      chartArea.right - 2
    );

    const meta = chart.getDatasetMeta(0);
    const points = meta && meta.data;
    if (!points || points.length === 0) return;

    let nearest = points[0];
    let bestDistance = Infinity;
    for (const point of points) {
      const distance = Math.abs(point.x - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = point;
      }
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(198, 244, 50, 0.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.shadowColor = 'rgba(198, 244, 50, 0.95)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, nearest.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#c6f432';
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(x, nearest.y, 7.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(198, 244, 50, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
};

const startPositionPlugin = {
  id: 'startPosition',
  afterDatasetsDraw(chart) {
    if (!state.route || !Number.isFinite(state.startM) || state.startM < 1) return;
    const { ctx, chartArea } = chart;
    const x = clamp(
      chart.scales.x.getPixelForValue(state.startM / 1000),
      chartArea.left + 2,
      chartArea.right - 2
    );

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top + 6);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(x, chartArea.bottom - 1);
    ctx.lineTo(x - 4, chartArea.bottom - 7);
    ctx.lineTo(x + 4, chartArea.bottom - 7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();
    ctx.restore();
  }
};

let profileHoverKm = null;
let profileHoverRaf = 0;

const hoverPositionPlugin = {
  id: 'hoverPosition',
  afterDatasetsDraw(chart) {
    if (!state.route || !Number.isFinite(profileHoverKm)) return;
    const { ctx, chartArea } = chart;
    const x = clamp(
      chart.scales.x.getPixelForValue(profileHoverKm),
      chartArea.left + 2,
      chartArea.right - 2
    );

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top + 6);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

function scheduleProfileHoverDraw() {
  if (profileHoverRaf) return;
  profileHoverRaf = requestAnimationFrame(() => {
    profileHoverRaf = 0;
    if (profileChart) profileChart.update('none');
  });
}

function buildChartSamples(points) {
  const step = Math.max(1, Math.ceil(points.length / PROFILE_MAX_POINTS));
  const samples = [];
  for (let i = 0; i < points.length; i += step) {
    samples.push({
      x: points[i].dist / 1000,
      y: points[i].eleSmooth,
      grade: points[i].grade
    });
  }
  const lastIndex = points.length - 1;
  if ((lastIndex % step) !== 0) {
    const last = points[lastIndex];
    samples.push({ x: last.dist / 1000, y: last.eleSmooth, grade: last.grade });
  }
  return samples;
}

function createOrUpdateChart(route) {
  const samples = route.chartSamples;
  if (!samples.length) return;

  const elevations = samples.map((s) => s.y);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const range = Math.max(1, maxEle - minEle);
  const yMin = Math.floor(minEle - Math.max(4, range * 0.10));
  const yMax = Math.ceil(maxEle + Math.max(4, range * 0.12));
  const totalKm = Math.max(0.01, route.totalM / 1000);

  state.profileKm = state.startM / 1000;

  if (!profileChart) {
    profileChart = new Chart(el.profileCanvas, {
      type: 'line',
      data: {
        datasets: [{
          data: samples,
          parsing: false,
          normalized: true,
          borderWidth: 2,
          borderColor: '#9ca3af',
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 0,
          fill: false,
          tension: 0.22,
          spanGaps: true,
          segment: {
            borderColor: (ctx) => {
              const data = ctx.chart.data.datasets[ctx.datasetIndex].data;
              const a = data[ctx.p0DataIndex];
              const b = data[ctx.p1DataIndex];
              return gradeColor(((a?.grade ?? 0) + (b?.grade ?? 0)) / 2);
            }
          }
        }]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        events: [],
        layout: { padding: { top: 8, right: 2, bottom: 2, left: 2 } },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: totalKm,
            display: false,
            grid: { display: false },
            border: { display: false },
            ticks: { display: false }
          },
          y: {
            min: yMin,
            max: yMax,
            display: false,
            grid: { display: false },
            border: { display: false },
            ticks: { display: false }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        }
      },
      plugins: [areaByGradePlugin, startPositionPlugin, currentPositionPlugin, hoverPositionPlugin]
    });
  } else {
    profileChart.data.datasets[0].data = samples;
    profileChart.options.scales.x.max = totalKm;
    profileChart.options.scales.y.min = yMin;
    profileChart.options.scales.y.max = yMax;
    profileChart.update('none');
  }
}

/* Výber nového štartu kliknutím / ťuknutím na výškový profil. */
function profilePointerKm(event) {
  if (!profileChart || !state.route) return null;

  const rect = el.profileCanvas.getBoundingClientRect();
  if (!rect.width) return null;

  const x = event.clientX - rect.left;
  const area = profileChart.chartArea;
  if (!area || x < area.left || x > area.right) return null;

  const km = profileChart.scales.x.getValueForPixel(x);
  if (!Number.isFinite(km)) return null;

  return clamp(km, 0, state.route.totalM / 1000);
}

function hideProfileHover() {
  if (el.profileHover.hidden) return;
  el.profileHover.hidden = true;
  profileHoverKm = null;
  scheduleProfileHoverDraw();
}

el.profileCanvas.addEventListener('mousemove', (event) => {
  const km = profilePointerKm(event);
  if (km === null) {
    hideProfileHover();
    return;
  }

  const sample = sampleRoute(km * 1000);
  const elevation = sample && Number.isFinite(sample.ele) ? Math.round(sample.ele) : '--';

  profileHoverKm = km;
  el.profileHover.hidden = false;
  el.profileHover.textContent = `${formatKm(km, 2)} km · ${elevation} m`;

  const wrapRect = el.profileCanvas.parentElement.getBoundingClientRect();
  const left = clamp(event.clientX - wrapRect.left, 58, wrapRect.width - 58);
  el.profileHover.style.left = `${left}px`;

  scheduleProfileHoverDraw();
});

el.profileCanvas.addEventListener('mouseleave', hideProfileHover);

el.profileCanvas.addEventListener('click', (event) => {
  const km = profilePointerKm(event);
  if (km === null) return;
  setRouteStart(km * 1000);
});

/* =========================================================================
   GPX – parsovanie, výpočet sklonu, vykreslenie trasy
   ========================================================================= */
function lowerBoundByDistance(points, distance) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < distance) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, points.length - 1);
}

function parseGPX(xmlText, fileName) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');

  if (xml.getElementsByTagNameNS('*', 'parsererror').length > 0) {
    throw new Error('súbor nie je platné XML');
  }

  let nodes = Array.from(xml.getElementsByTagNameNS('*', 'trkpt'));
  if (nodes.length === 0) {
    nodes = Array.from(xml.getElementsByTagNameNS('*', 'rtept'));
  }
  if (nodes.length === 0) {
    throw new Error('GPX neobsahuje žiadne body <trkpt> ani <rtept>');
  }

  const rawPoints = [];
  let lastEle = null;
  let firstEle = null;
  let hasElevation = false;

  for (const node of nodes) {
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const eleNode = node.getElementsByTagNameNS('*', 'ele')[0];
    let ele = eleNode ? parseFloat(eleNode.textContent) : NaN;
    if (Number.isFinite(ele)) {
      hasElevation = true;
      if (firstEle === null) firstEle = ele;
      lastEle = ele;
    } else {
      ele = lastEle !== null ? lastEle : null;
    }

    rawPoints.push({ lat, lon, ele });
  }

  const fallbackEle = firstEle !== null ? firstEle : 0;
  for (const pt of rawPoints) {
    if (pt.ele === null) pt.ele = fallbackEle;
  }

  if (rawPoints.length < 2) {
    throw new Error('trasa obsahuje menej ako 2 platné body');
  }

  const points = [];
  let cumulative = 0;

  for (const raw of rawPoints) {
    if (points.length > 0) {
      const prev = points[points.length - 1];
      const segment = haversineMeters(prev, raw);
      if (segment < 0.5) continue;
      cumulative += segment;
    }
    points.push({
      lat: raw.lat,
      lon: raw.lon,
      ele: raw.ele,
      dist: cumulative,
      rawGrade: 0,
      grade: 0
    });
  }

  if (points.length < 2 || cumulative < 10) {
    throw new Error('trasa je príliš krátka');
  }

  points[0].rawGrade = 0;
  for (let i = 1; i < points.length; i++) {
    const deltaDist = points[i].dist - points[i - 1].dist;
    const deltaEle = points[i].ele - points[i - 1].ele;
    points[i].rawGrade = deltaDist > 0.2
      ? clamp((deltaEle / deltaDist) * 100, -35, 35)
      : 0;
  }

  const prefix = new Float64Array(points.length + 1);
  for (let i = 0; i < points.length; i++) prefix[i + 1] = prefix[i] + points[i].ele;
  for (let i = 0; i < points.length; i++) {
    const from = lowerBoundByDistance(points, points[i].dist - ELE_SMOOTH_HALF_M);
    const to = lowerBoundByDistance(points, points[i].dist + ELE_SMOOTH_HALF_M);
    points[i].eleSmooth = (prefix[to + 1] - prefix[from]) / (to - from + 1);
  }

  const n = points.length;
  const sumD = new Float64Array(n + 1);
  const sumE = new Float64Array(n + 1);
  const sumDE = new Float64Array(n + 1);
  const sumDD = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = points[i].dist;
    const e = points[i].ele;
    sumD[i + 1] = sumD[i] + d;
    sumE[i + 1] = sumE[i] + e;
    sumDE[i + 1] = sumDE[i] + d * e;
    sumDD[i + 1] = sumDD[i] + d * d;
  }

  for (let i = 0; i < n; i++) {
    let from = lowerBoundByDistance(points, points[i].dist - GRADE_WINDOW_HALF_M);
    let to = lowerBoundByDistance(points, points[i].dist + GRADE_WINDOW_HALF_M);
    while (to - from < 8) {
      if (from > 0) from--;
      else if (to < n - 1) to++;
      else break;
    }

    const count = to - from + 1;
    const sx = sumD[to + 1] - sumD[from];
    const sy = sumE[to + 1] - sumE[from];
    const sxy = sumDE[to + 1] - sumDE[from];
    const sxx = sumDD[to + 1] - sumDD[from];
    const denom = count * sxx - sx * sx;
    const slope = denom > 1e-6 ? (count * sxy - sx * sy) / denom : points[i].rawGrade;

    points[i].grade = clamp(slope * 100, GRADE_MIN, GRADE_MAX);
  }

  const gradePrefix = new Float64Array(points.length + 1);
  for (let i = 0; i < points.length; i++) gradePrefix[i + 1] = gradePrefix[i] + points[i].grade;
  for (let i = 0; i < points.length; i++) {
    const from = lowerBoundByDistance(points, points[i].dist - GRADE_AVG_HALF_M);
    const to = lowerBoundByDistance(points, points[i].dist + GRADE_AVG_HALF_M);
    const avg = (gradePrefix[to + 1] - gradePrefix[from]) / (to - from + 1);
    points[i].grade = clamp(avg, GRADE_MIN, GRADE_MAX);
  }

  let ascent = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].eleSmooth - points[i - 1].eleSmooth;
    if (delta > 0) ascent += delta;
  }

  const trk = xml.getElementsByTagNameNS('*', 'trk')[0];
  const metadata = xml.getElementsByTagNameNS('*', 'metadata')[0];
  let name = trk?.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim();
  if (!name) name = metadata?.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim();
  if (!name) name = (fileName || 'GPX trasa').replace(/\.gpx$/i, '');

  const totalM = points[points.length - 1].dist;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
  }

  return {
    name,
    points,
    totalM,
    ascentM: ascent,
    hasElevation,
    bounds: [[minLon, minLat], [maxLon, maxLat]],
    chartSamples: []
  };
}

function decimateRoutePoints(points, maxPoints) {
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  const list = [];
  for (let i = 0; i < points.length; i += step) list.push(points[i]);
  if ((points.length - 1) % step !== 0) list.push(points[points.length - 1]);
  return list;
}

function renderRouteOnMap(route) {
  const renderPoints = decimateRoutePoints(route.points, MAP_MAX_POINTS);
  const coords = renderPoints.map((p) => [p.lon, p.lat]);

  pendingRouteLine = {
    type: 'FeatureCollection',
    features: coords.length >= 2 ? [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords }
    }] : []
  };

  pendingRouteEndpoints = {
    type: 'FeatureCollection',
    features: coords.length >= 1 ? [
      {
        type: 'Feature',
        properties: { kind: 'start' },
        geometry: { type: 'Point', coordinates: coords[0] }
      },
      {
        type: 'Feature',
        properties: { kind: 'end' },
        geometry: { type: 'Point', coordinates: coords[coords.length - 1] }
      }
    ] : []
  };

  if (mapReady) {
    map.getSource('route-line').setData(pendingRouteLine);
    map.getSource('route-endpoints').setData(pendingRouteEndpoints);
  }

  routeBounds = route.bounds;
}

function resetRideStats(fitMap = true) {
  state.rideM = 0;
  state.rideSeconds = 0;
  state.powerSum = 0;
  state.powerTime = 0;
  state.powerSamples = [];
  state.npBucketSum = 0;
  state.npBucketTime = 0;
  state.npWindow = [];
  state.npFourthSum = 0;
  state.npFourthCount = 0;
  state.tcxSamples = [];
  state.energyKcal = 0;
  state.ascentM = 0;
  state.lastEle = null;
  state.hrMovingSum = 0;
  state.hrMovingTime = 0;
  state.hrAllSum = 0;
  state.hrAllTime = 0;
  state.routeFinished = false;
  state.routeTravelBaseM = 0;
  state.mapRideStarted = false;
  state.profileKm = state.startM / 1000;
  state.trainerBaseM = null;
  state.trainerDistOffset = 0;
  state.hasTotalDistance = false;
  state.lastTotalM = null;
  state.lastTotalAt = 0;
  state.lastTotalDistance = null;
  state.lastTotalDelta = 0;
  state.lastDistChangeAt = 0;
  state.distanceFallback = false;
  state.virtualSpeedMps = 0;
  state.ridePaused = false;
  state.lastSavedRideSeconds = null;
  state.lastSavedRideM = null;
  state.workoutLoopIndex = 0;
  state.workoutSummaryName = '';

  if (state.route) {
    const startSample = sampleRoute(state.startM);
    state.currentGrade = startSample?.grade || 0;
    state.targetGrade = state.currentGrade;
    if (startSample) {
      setRiderPosition(startSample.lat, startSample.lon);
    }
    if (fitMap) fitRouteOnMap();
  } else {
    state.currentGrade = 0;
    state.targetGrade = 0;
  }

  updateGradeChip(state.currentGrade);
  renderHUD();
  updateChartMarker(true);
}

function setRouteStart(distanceM) {
  if (!state.route) return;
  if (state.workoutActive) {
    showToast('Počas tréningu sa štart nedá meniť.', 'info', 3500);
    return;
  }

  const maxStart = Math.max(0, state.route.totalM - 50);
  const startM = clamp(distanceM, 0, maxStart);
  const startKm = startM / 1000;

  if (state.rideM > 20) {
    const answer = window.confirm(
      `Presunúť štart na ${formatKm(startKm, 2)} km?\n\nAktuálna jazda (${formatKm(state.rideM / 1000, 2)} km) sa vynuluje a kilometre sa budú počítať od nového bodu.`
    );
    if (!answer) return;
  }

  state.startM = startM;
  resetRideStats(false);

  const sample = sampleRoute(startM);
  if (sample) {
    setRiderPosition(sample.lat, sample.lon, true);
    flyToRider([sample.lat, sample.lon], Math.max(map.getZoom(), 13));
  }

  if (trainer) {
    lastSimGrade = null;
    lastSimSentAt = 0;
    queueSimulation();
  }

  showToast(
    `Štart presunutý na ${formatKm(startKm, 2)} km. Prejdené km a štatistiky sa počítajú až od tohto bodu.`,
    'success',
    5200
  );
}

function applyRoute(route, gpxText = '', fileName = '', savedId = null) {
  state.route = route;
  state.routeGpxText = gpxText;
  state.routeFileName = fileName || `${route.name || 'trasa'}.gpx`;
  state.routeSavedId = savedId;
  state.startM = 0;
  resetRideStats();

  route.chartSamples = buildChartSamples(route.points);

  el.routeName.textContent = route.name;
  el.routeMeta.textContent = `${formatKm(route.totalM / 1000, 1)} km · +${Math.round(route.ascentM)} m`;
  el.remainValue.textContent = `${formatKm(route.totalM / 1000, 1)} km`;
  el.profileEmpty.classList.add('hidden');

  renderRouteOnMap(route);
  createOrUpdateChart(route);

  const first = route.points[0];
  setRiderPosition(first.lat, first.lon, true);
  fitRouteOnMap();

  updateGradeChip(state.currentGrade);
  renderHUD();
  updateChartMarker(true);

  if (trainer) {
    lastSimGrade = null;
    lastSimSentAt = 0;
    if (!state.workoutActive) queueSimulation();
  }

  if (!route.hasElevation) {
    showToast('GPX neobsahuje výškové údaje <ele> – sklon bude 0 %.', 'warning', 6500);
  }

  refreshAccountCurrentRoute();
  if (el.workoutModal && el.workoutModal.classList.contains('open')) {
    refreshWorkoutRouteNote();
    renderWorkoutPreview();
  }
}

async function loadGPXFile(file) {
  if (!file) return;
  if (state.workoutActive) {
    showToast('Počas tréningu sa trasa nedá meniť. Najprv tréning ukonči.', 'info', 4000);
    el.gpxInput.value = '';
    return;
  }
  if (!requireLogin('Nahranie vlastnej GPX')) {
    el.gpxInput.value = '';
    return;
  }
  try {
    el.btnGpx.disabled = true;
    const text = await file.text();
    const route = parseGPX(text, file.name);
    applyRoute(route, text, file.name);
    showToast(
      `Trasa „${route.name}“ načítaná · ${formatKm(route.totalM / 1000, 1)} km · +${Math.round(route.ascentM)} m. Kliknutím na profil zvolíš iný štart.`,
      'success',
      5200
    );
  } catch (error) {
    console.error('GPX:', error);
    showToast(`GPX sa nepodarilo načítať: ${error.message}`, 'error', 7500);
  } finally {
    el.btnGpx.disabled = false;
    el.gpxInput.value = '';
  }
}

function openGpxPicker() {
  if (state.workoutActive) {
    showToast('Počas tréningu sa trasa nedá meniť. Najprv tréning ukonči.', 'info', 4000);
    return;
  }
  if (!requireLogin('Nahranie vlastnej GPX')) return;
  el.gpxInput.click();
}

/* Ukážková trasa uložená v externom súbore demo.gpx – načíta sa tlačidlom „Nahrať ukážkové GPX“. */
let demoRouteCache = '';
async function loadDemoRoute(options) {
  const silent = Boolean(options && options.silent === true);
  if (state.workoutActive) {
    if (!silent) showToast('Počas tréningu sa trasa nedá meniť. Najprv tréning ukonči.', 'info', 4000);
    return false;
  }

  try {
    if (el.btnLoadDemoGpx) el.btnLoadDemoGpx.disabled = true;
    if (el.wpRouteDemo) el.wpRouteDemo.disabled = true;

    let gpxText = demoRouteCache;
    if (!gpxText) {
      const response = await fetch('demo.gpx', { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} pri načítaní demo.gpx`);
      }
      gpxText = (await response.text()).trim();
      demoRouteCache = gpxText;
    }

    const route = parseGPX(gpxText, 'demo.gpx');
    route.name = 'Liptovská Osada - Srekovica';
    route.isDemo = true;
    applyRoute(route, gpxText, 'demo.gpx');
    if (!silent) {
      showToast(
        `${route.name} načítaná · ${formatKm(route.totalM / 1000, 1)} km · +${Math.round(route.ascentM)} m. Kliknutím na profil zvolíš iný štart.`,
        'success',
        6000
      );
    }
    return true;
  } catch (error) {
    console.error('Demo GPX:', error);
    showToast('Ukážkovú trasu (demo.gpx) sa nepodarilo načítať. Skontroluj, či je súbor demo.gpx v rovnakom priečinku a stránka beží cez webový server.', 'error', 7500);
    return false;
  } finally {
    if (el.btnLoadDemoGpx) el.btnLoadDemoGpx.disabled = false;
    if (el.wpRouteDemo) el.wpRouteDemo.disabled = false;
  }
}

/* =========================================================================
   KONTO – SUPABASE (Google prihlásenie + uložené GPX trasy)
   ========================================================================= */
let supa = null;
let accountUser = null;
let savedRoutes = [];
let savedRoutesLoading = false;
let savedRoutesError = '';
let savedActivities = [];
let savedActivitiesLoading = false;
let savedActivitiesError = '';
let activityBusy = false;
let viewingActivityId = null;
let selectedActivityId = null;
let accountBusy = false;

function normalizeRiderWeight(value) {
  const weight = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(weight) || weight < RIDER_WEIGHT_MIN || weight > RIDER_WEIGHT_MAX) return null;
  return Math.round(weight * 10) / 10;
}

function readLocalRiderWeight() {
  try {
    return {
      weight: normalizeRiderWeight(localStorage.getItem(RIDER_WEIGHT_KEY)),
      updatedAt: Number(localStorage.getItem(RIDER_WEIGHT_UPDATED_KEY)) || 0
    };
  } catch (_) {
    return { weight: null, updatedAt: 0 };
  }
}

function storeRiderWeightLocally(weight, updatedAt = Date.now()) {
  try {
    localStorage.setItem(RIDER_WEIGHT_KEY, String(weight));
    localStorage.setItem(RIDER_WEIGHT_UPDATED_KEY, String(updatedAt));
  } catch (_) {}
}

function syncProfileInputs() {
  if (el.profileWeight && document.activeElement !== el.profileWeight) {
    el.profileWeight.value = String(state.weight);
  }
  if (el.profileFtp && document.activeElement !== el.profileFtp) {
    el.profileFtp.value = String(state.ftp);
  }
  if (el.profileFtpWkg) {
    const wkg = state.ftp / Math.max(1, state.weight);
    el.profileFtpWkg.textContent = `${wkg.toFixed(2)} W/kg`;
  }
}

function applyRiderWeight(weight) {
  const normalized = normalizeRiderWeight(weight);
  if (normalized === null) return;
  state.weight = normalized;
  syncProfileInputs();
  renderHUD();
}

function readAccountRiderWeight(user) {
  const meta = user && user.user_metadata ? user.user_metadata : null;
  if (!meta) return { weight: null, updatedAt: 0 };
  const rawUpdatedAt = meta[RIDER_WEIGHT_META_UPDATED_KEY];
  return {
    weight: normalizeRiderWeight(meta[RIDER_WEIGHT_META_KEY]),
    updatedAt: typeof rawUpdatedAt === 'string' ? (Date.parse(rawUpdatedAt) || 0) : 0
  };
}

async function saveRiderWeightToAccount(weight, updatedAt = Date.now()) {
  if (!supa || !accountUser) return false;
  const normalized = normalizeRiderWeight(weight);
  if (normalized === null) return false;

  try {
    const meta = accountUser && accountUser.user_metadata ? accountUser.user_metadata : {};
    const { data, error } = await supa.auth.updateUser({
      data: {
        ...meta,
        [RIDER_WEIGHT_META_KEY]: normalized,
        [RIDER_WEIGHT_META_UPDATED_KEY]: new Date(updatedAt).toISOString()
      }
    });
    if (error) throw error;
    if (data && data.user) accountUser = data.user;
    return true;
  } catch (error) {
    console.error('Uloženie hmotnosti do účtu:', error);
    showToast(`Hmotnosť sa nepodarilo uložiť do účtu: ${accountErrorMessage(error)}`, 'error', 6500);
    return false;
  }
}

async function syncRiderWeightWithAccount(user) {
  if (!user) return;

  const local = readLocalRiderWeight();
  const remote = readAccountRiderWeight(user);

  if (remote.weight !== null) {
    const localIsNewer = local.weight !== null && local.weight !== remote.weight &&
      local.updatedAt > remote.updatedAt;
    if (localIsNewer) {
      // Hmotnosť zmenená na tomto zariadení bez prihlásenia má prednosť.
      applyRiderWeight(local.weight);
      await saveRiderWeightToAccount(local.weight, local.updatedAt);
      return;
    }
    // Účet je zdroj pravdy – hmotnosť sa tak zapamätá aj na iných zariadeniach.
    applyRiderWeight(remote.weight);
    storeRiderWeightLocally(remote.weight, remote.updatedAt || Date.now());
    return;
  }

  if (local.weight !== null) {
    // Prvé prihlásenie: ulož do účtu hmotnosť, ktorú má používateľ nastavenú lokálne.
    applyRiderWeight(local.weight);
    await saveRiderWeightToAccount(local.weight, local.updatedAt || Date.now());
  }
}

/* ---------------------------- FTP ---------------------------- */
function normalizeFtp(value) {
  const ftp = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(ftp) || ftp < FTP_MIN || ftp > FTP_MAX) return null;
  return Math.round(ftp);
}

function readLocalFtp() {
  try {
    return {
      ftp: normalizeFtp(localStorage.getItem(FTP_KEY)),
      updatedAt: Number(localStorage.getItem(FTP_UPDATED_KEY)) || 0
    };
  } catch (_) {
    return { ftp: null, updatedAt: 0 };
  }
}

function storeFtpLocally(ftp, updatedAt = Date.now()) {
  try {
    localStorage.setItem(FTP_KEY, String(ftp));
    localStorage.setItem(FTP_UPDATED_KEY, String(updatedAt));
  } catch (_) {}
}

function applyFtp(ftp) {
  const normalized = normalizeFtp(ftp);
  if (normalized === null) return;
  state.ftp = normalized;
  if (el.workoutFtp) el.workoutFtp.value = String(normalized);
  syncProfileInputs();
  renderHUD();
}

function setFtp(value, save = true) {
  const normalized = normalizeFtp(value);
  if (normalized === null) return false;

  state.ftp = normalized;
  if (el.workoutFtp) el.workoutFtp.value = String(normalized);
  syncProfileInputs();
  renderHUD();

  if (save) {
    const now = Date.now();
    storeFtpLocally(normalized, now);
    if (supa && accountUser) saveFtpToAccount(normalized, now);
  }
  return true;
}

function readAccountFtp(user) {
  if (!user || !user.user_metadata) return { ftp: null, updatedAt: 0 };
  const meta = user.user_metadata;
  const rawUpdatedAt = meta[FTP_META_UPDATED_KEY];
  return {
    ftp: normalizeFtp(meta[FTP_META_KEY]),
    updatedAt: typeof rawUpdatedAt === 'string' ? (Date.parse(rawUpdatedAt) || 0) : 0
  };
}

async function saveFtpToAccount(ftp, updatedAt = Date.now()) {
  if (!supa || !accountUser) return false;
  const normalized = normalizeFtp(ftp);
  if (normalized === null) return false;

  try {
    const meta = accountUser && accountUser.user_metadata ? accountUser.user_metadata : {};
    const { data, error } = await supa.auth.updateUser({
      data: {
        ...meta,
        [FTP_META_KEY]: normalized,
        [FTP_META_UPDATED_KEY]: new Date(updatedAt).toISOString()
      }
    });
    if (error) throw error;
    if (data && data.user) accountUser = data.user;
    return true;
  } catch (error) {
    console.error('Uloženie FTP do účtu:', error);
    showToast(`FTP sa nepodarilo uložiť do účtu: ${accountErrorMessage(error)}`, 'error', 6500);
    return false;
  }
}

async function syncFtpWithAccount(user) {
  if (!user) return;

  const local = readLocalFtp();
  const remote = readAccountFtp(user);

  if (remote.ftp !== null) {
    const localIsNewer = local.ftp !== null && local.ftp !== remote.ftp &&
      local.updatedAt > remote.updatedAt;
    if (localIsNewer) {
      applyFtp(local.ftp);
      await saveFtpToAccount(local.ftp, local.updatedAt);
      return;
    }
    applyFtp(remote.ftp);
    storeFtpLocally(remote.ftp, remote.updatedAt || Date.now());
    return;
  }

  if (local.ftp !== null) {
    applyFtp(local.ftp);
    await saveFtpToAccount(local.ftp, local.updatedAt || Date.now());
  }
}

async function syncAccountProfile() {
  if (!accountUser) return;
  await syncRiderWeightWithAccount(accountUser);
  if (!accountUser) return;
  await syncFtpWithAccount(accountUser);
}

function setLockableValue(node, value, locked, lockedText, lockedLabel) {
  if (!node) return;
  node.classList.toggle('locked-value', locked);
  if (locked) {
    node.textContent = lockedText || '🔒';
    node.title = lockedLabel || 'Dostupné po prihlásení';
    node.setAttribute('aria-label', lockedLabel || 'Dostupné po prihlásení');
  } else {
    node.textContent = value;
    node.removeAttribute('title');
    node.removeAttribute('aria-label');
  }
}

function requireLogin(featureLabel) {
  if (accountUser) return true;
  showToast(`${featureLabel} je dostupné po prihlásení.`, 'info', 4500);
  openAccountModal();
  if (el.accountSignedOut && !el.accountSignedOut.hidden) {
    el.btnGoogleLogin.focus({ preventScroll: true });
  }
  return false;
}

function setAuthLockedButton(button, locked, normalTitle, lockedTitle) {
  if (!button) return;
  button.classList.toggle('is-locked', locked);
  if (locked) {
    button.setAttribute('aria-disabled', 'true');
    button.title = lockedTitle;
  } else {
    button.removeAttribute('aria-disabled');
    if (normalTitle) button.title = normalTitle;
    else button.removeAttribute('title');
  }
}

function updateAuthLocks() {
  const locked = !accountUser;

  if (locked && heartRateSensor) {
    const sensor = heartRateSensor;
    heartRateSensor = null;
    state.hr = null;
    state.lastHrAt = 0;
    setHrUI('disconnected');
    try { sensor.device.gatt.disconnect(); } catch (_) {}
  }

  setAuthLockedButton(el.btnHr, locked,
    'Pripojiť hrudný pás (Heart Rate Service)',
    'Tep – dostupné po prihlásení');
  setAuthLockedButton(el.btnGpx, locked,
    'Nahrať GPX súbor',
    'GPX – dostupné po prihlásení');
  setAuthLockedButton(el.btnLoadGpxEmpty, locked,
    '',
    'Nahratie GPX – dostupné po prihlásení');
  setAuthLockedButton(el.btnRoutes, locked,
    'Trasy – uložené GPX trasy',
    'Trasy – dostupné po prihlásení');
  setAuthLockedButton(el.btnActivities, locked,
    'Jazdy – história uložených jázd',
    'Jazdy – dostupné po prihlásení');
  setAuthLockedButton(el.btnWorkout, locked,
    'Workout – intervalový tréning',
    'Workout – dostupné po prihlásení');

  renderHUD();

  if (el.finishModal.classList.contains('open') && !viewingActivityId) {
    fillStatsView(currentRideSummary());
  }
}

const ACCOUNT_SETUP_NOTE = 'Doplň do súboru <code>app.js</code> adresu Supabase projektu a verejný anon kľúč. Potom spusti SQL a povoľ Google prihlásenie podľa návodu v súbore <code>SETUP_SUPABASE.md</code>.';
const ACCOUNT_EMPTY_TEXT = 'Zatiaľ nemáš uložené žiadne trasy. Načítaj GPX a klikni na <strong>Uložiť trasu</strong>.';

function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function accountRedirectUrl() {
  if (location.protocol === 'file:') return 'nedostupné pri otvorení z disku (file://)';
  return `${location.origin}${location.pathname}`;
}

function accountErrorMessage(error) {
  const message = String(error && error.message ? error.message : error || '');
  if (/does not exist|schema cache|Could not find the table/i.test(message)) {
    return 'Tabuľka v databáze neexistuje. Spusti SQL z návodu SETUP_SUPABASE.md (krok 2 pre trasy, 2b pre jazdy).';
  }
  if (/permission denied for table/i.test(message)) {
    return 'Databáza nepovoľuje prístup k tabuľke („routes“ alebo „activities“). Spusti GRANT príkazy podľa SETUP_SUPABASE.md.';
  }
  if (/row-level security/i.test(message)) {
    return 'Databáza odmietla zápis (RLS). Skontroluj pravidlá pre tabuľky „routes“ a „activities“ podľa SETUP_SUPABASE.md.';
  }
  if (/JWT|session|token/i.test(message)) {
    return 'Prihlásenie vypršalo. Prihlás sa znova.';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return 'Nepodarilo sa spojiť so serverom. Skontroluj internet a adresu Supabase.';
  }
  return message || 'Nastala neznáma chyba.';
}

if (supabaseConfigured()) {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    } catch (error) {
      console.error('Supabase init:', error);
    }
  } else {
    console.error('Supabase knižnica sa nenačítala (CDN).');
  }
}

function updateAccountButton() {
  const signedIn = Boolean(accountUser);
  el.btnAccount.classList.toggle('connected', signedIn);
  el.accountDot.classList.toggle('connected', signedIn);
  el.btnAccount.title = signedIn
    ? `Konto – ${accountUser.email || 'prihlásený používateľ'}`
    : 'Konto – prihlásenie a správa účtu';
}

function findMatchingSavedRoute() {
  if (!state.route) return null;
  if (state.routeSavedId) {
    const byId = savedRoutes.find((route) => route.id === state.routeSavedId);
    if (byId) return byId;
  }
  const name = String(state.route.name || 'GPX trasa').slice(0, 120);
  const dist = Math.round(state.route.totalM);
  const count = state.route.points.length;
  return savedRoutes.find((route) =>
    route.name === name &&
    Math.abs((route.distance_m || 0) - dist) <= 5 &&
    (route.point_count || 0) === count
  ) || null;
}

function refreshAccountCurrentRoute() {
  if (!el.accountCurrent || !el.btnSaveRoute) return;
  if (state.route && state.routeGpxText) {
    el.accountCurrent.textContent = `${state.route.name} · ${formatKm(state.route.totalM / 1000, 1)} km`;
    const alreadySaved = Boolean(state.routeSavedId);
    el.btnSaveRoute.disabled = alreadySaved;
    el.btnSaveRoute.textContent = alreadySaved ? 'Uložené ✓' : 'Uložiť trasu';
    el.btnSaveRoute.title = alreadySaved
      ? 'Táto trasa je už uložená v účte'
      : 'Uložiť aktuálnu trasu do účtu';
  } else if (state.route) {
    el.accountCurrent.textContent = `${state.route.name} (GPX nie je k dispozícii)`;
    el.btnSaveRoute.disabled = true;
    el.btnSaveRoute.textContent = 'Uložiť trasu';
    el.btnSaveRoute.removeAttribute('title');
  } else {
    el.accountCurrent.textContent = 'Žiadna načítaná trasa';
    el.btnSaveRoute.disabled = true;
    el.btnSaveRoute.textContent = 'Uložiť trasu';
    el.btnSaveRoute.removeAttribute('title');
  }
}

function createRenameButton(title, ariaLabel, onClick) {
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'account-item-edit';
  edit.title = title;
  edit.setAttribute('aria-label', ariaLabel);
  edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  edit.addEventListener('click', onClick);
  return edit;
}

function buildAccountRouteItem(item) {
  const row = document.createElement('div');
  row.className = 'account-item';

  const main = document.createElement('div');
  main.className = 'account-item-main';

  const name = document.createElement('div');
  name.className = 'account-item-name';
  name.textContent = item.name || 'GPX trasa';

  const meta = document.createElement('div');
  meta.className = 'account-item-meta';
  const date = item.created_at ? new Date(item.created_at) : null;
  const dateText = date && Number.isFinite(date.getTime())
    ? date.toLocaleDateString('sk-SK')
    : '';
  meta.textContent = [
    `${formatKm((item.distance_m || 0) / 1000, 1)} km`,
    `+${Math.round(item.ascent_m || 0)} m`,
    dateText
  ].filter(Boolean).join(' · ');

  main.append(name, meta);

  const load = document.createElement('button');
  load.type = 'button';
  load.className = 'account-item-btn';
  load.textContent = 'Načítať';
  load.addEventListener('click', () => loadSavedRoute(item.id));

  const rename = createRenameButton(
    'Premenovať trasu',
    `Premenovať trasu ${item.name || ''}`.trim(),
    () => renameSavedRoute(item.id)
  );

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'account-item-del';
  remove.title = 'Vymazať trasu z účtu';
  remove.setAttribute('aria-label', `Vymazať trasu ${item.name || ''}`.trim());
  remove.textContent = '×';
  remove.addEventListener('click', () => deleteSavedRoute(item.id));

  row.append(main, load, rename, remove);
  return row;
}

function renderSavedRoutes() {
  if (!el.accountList) return;
  el.accountList.textContent = '';
  el.accountCount.textContent = String(savedRoutes.length);

  el.accountError.hidden = !savedRoutesError;
  if (savedRoutesError) el.accountError.textContent = savedRoutesError;

  const showEmpty = savedRoutes.length === 0 && !savedRoutesError;
  el.accountEmpty.hidden = !showEmpty;
  if (showEmpty) {
    el.accountEmpty.innerHTML = savedRoutesLoading
      ? 'Načítavam uložené trasy…'
      : ACCOUNT_EMPTY_TEXT;
  }

  for (const item of savedRoutes) {
    el.accountList.appendChild(buildAccountRouteItem(item));
  }
  if (el.workoutModal && el.workoutModal.classList.contains('open')) {
    refreshWorkoutRouteNote();
  }
}

function formatActivityDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.toLocaleDateString('sk-SK')} ${date.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })}`;
}

function buildActivityItem(item) {
  const row = document.createElement('div');
  row.className = 'account-item activity-item';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-pressed', String(item.id === selectedActivityId));
  if (item.id === selectedActivityId) row.classList.add('is-selected');

  const weight = Number(item.weight_kg) > 0 ? Number(item.weight_kg) : (state.weight || 75);

  const main = document.createElement('div');
  main.className = 'account-item-main';

  const top = document.createElement('div');
  top.className = 'activity-row-top';

  const dateText = formatActivityDate(item.created_at);
  if (dateText) {
    const dateEl = document.createElement('span');
    dateEl.className = 'activity-row-date';
    dateEl.textContent = dateText;
    top.append(dateEl);
  }

  const name = document.createElement('div');
  name.className = 'account-item-name';
  name.textContent = item.name || 'Jazda';
  top.append(name);

  const metrics = document.createElement('div');
  metrics.className = 'activity-row-metrics';

  const avgPower = Math.round(Number(item.avg_power_w) || 0);
  const wSpan = document.createElement('span');
  wSpan.className = avgPower > 0 ? 'activity-metric-w' : 'activity-metric-muted';
  wSpan.textContent = `${avgPower} W · ${(avgPower / weight).toFixed(2)} W/kg`;

  const hasHr = item.avg_hr !== null && item.avg_hr !== undefined && Number(item.avg_hr) > 0;
  const hrSpan = document.createElement('span');
  hrSpan.className = hasHr ? 'activity-metric-hr' : 'activity-metric-muted';
  hrSpan.textContent = hasHr ? `${Math.round(Number(item.avg_hr))} bpm` : '-- bpm';

  metrics.append(wSpan, hrSpan);
  main.append(top, metrics);

  const rename = createRenameButton(
    'Premenovať jazdu',
    `Premenovať jazdu ${item.name || ''}`.trim(),
    () => renameSavedActivity(item.id)
  );

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'account-item-del';
  remove.title = 'Vymazať jazdu z účtu';
  remove.setAttribute('aria-label', `Vymazať jazdu ${item.name || ''}`.trim());
  remove.textContent = '×';
  remove.addEventListener('click', () => deleteSavedActivity(item.id));

  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    selectActivityDetail(item.id);
  });
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectActivityDetail(item.id);
    }
  });

  row.append(main, rename, remove);
  return row;
}

function renderActivityDetail() {
  if (!el.activityDetailEmpty || !el.activityDetailContent) return;

  const item = savedActivities.find((activity) => activity.id === selectedActivityId);
  if (!item) {
    el.activityDetailEmpty.hidden = false;
    el.activityDetailContent.hidden = true;
    return;
  }

  el.activityDetailEmpty.hidden = true;
  el.activityDetailContent.hidden = false;

  const avgPower = Math.round(Number(item.avg_power_w) || 0);
  const npPower = Math.round(Number(item.np_w) || 0);
  const weight = Number(item.weight_kg) > 0 ? Number(item.weight_kg) : (state.weight || 75);
  const hasHr = item.avg_hr !== null && item.avg_hr !== undefined && Number(item.avg_hr) > 0;

  el.adTime.textContent = formatTime(item.duration_s || 0);
  el.adDistance.innerHTML = `${formatKm((item.distance_m || 0) / 1000, 2)} <small>km</small>`;
  el.adAvgPower.innerHTML = `${avgPower} <small>W</small>`;
  el.adAvgWkg.textContent = `${(avgPower / weight).toFixed(2)} W/kg`;
  el.adNp.innerHTML = `${npPower} <small>W</small>`;
  el.adNpWkg.textContent = `${(npPower / weight).toFixed(2)} W/kg`;
  el.adAvgHr.innerHTML = hasHr ? `${Math.round(Number(item.avg_hr))} <small>bpm</small>` : '--';
  el.adAscent.innerHTML = `+${Math.round(item.ascent_m || 0)} <small>m</small>`;
  el.adCalories.innerHTML = `${Math.round(item.calories || 0)} <small>kcal</small>`;
  el.adWeight.innerHTML = Number(item.weight_kg) > 0
    ? `${Number(item.weight_kg).toFixed(1).replace(/\.0$/, '')} <small>kg</small>`
    : '--';
}

function selectActivityDetail(id) {
  selectedActivityId = id;
  renderSavedActivities();
}

function renderSavedActivities() {
  if (!el.activityList) return;
  el.activityList.textContent = '';
  el.activityCount.textContent = String(savedActivities.length);

  if (selectedActivityId && !savedActivities.some((item) => item.id === selectedActivityId)) {
    selectedActivityId = null;
  }

  el.activityError.hidden = !savedActivitiesError;
  if (savedActivitiesError) el.activityError.textContent = savedActivitiesError;

  const showEmpty = savedActivities.length === 0 && !savedActivitiesError;
  el.activityEmpty.hidden = !showEmpty;
  if (showEmpty) {
    el.activityEmpty.innerHTML = savedActivitiesLoading
      ? 'Načítavam uložené jazdy…'
      : 'Zatiaľ nemáš uložené jazdy. Ukonči jazdu tlačidlom <strong>Ukončiť</strong> a klikni na <strong>Uložiť aktivitu</strong>.';
  }

  for (const item of savedActivities) {
    el.activityList.appendChild(buildActivityItem(item));
  }

  renderActivityDetail();
}

function renderAccount() {
  if (!el.accountSetup) return;

  const hasConfig = supabaseConfigured();
  const libReady = Boolean(window.supabase && window.supabase.createClient);
  const configured = hasConfig && libReady && Boolean(supa);

  refreshAccountCurrentRoute();
  updateAccountButton();
  syncProfileInputs();

  el.accountSetup.hidden = configured;
  if (!configured) {
    el.accountSetupNote.innerHTML = hasConfig && !libReady
      ? 'Knižnicu Supabase sa nepodarilo načítať z CDN. Skontroluj internet a obnov stránku.'
      : hasConfig && libReady
        ? 'Klienta Supabase sa nepodarilo spustiť. Skontroluj adresu a anon kľúč projektu v súbore <code>app.js</code>.'
        : ACCOUNT_SETUP_NOTE;
    el.accountRedirect.textContent = accountRedirectUrl();
  }

  const signedIn = Boolean(accountUser);
  el.accountSignedOut.hidden = !configured || signedIn;
  el.accountSignedIn.hidden = !configured || !signedIn;

  if (!configured) {
    el.accountSubtitle.textContent = 'Účet zatiaľ nie je nastavený';
    return;
  }

  if (signedIn) {
    el.accountSubtitle.textContent = 'Prihlásenie a správa účtu';
    el.accountEmail.textContent = accountUser.email || 'Prihlásený používateľ';
    const initial = (accountUser.email || '?').trim().charAt(0);
    el.accountAvatar.textContent = initial || '?';
    renderSavedRoutes();
    renderSavedActivities();
  } else {
    el.accountSubtitle.textContent = 'Prihlás sa a ulož si svoje GPX trasy a jazdy';
  }
}

function setAccountUser(user) {
  const previousId = accountUser ? accountUser.id : null;
  const wasViewingActivity = Boolean(viewingActivityId);
  accountUser = user || null;
  if ((accountUser ? accountUser.id : null) !== previousId) {
    state.lastSavedRideSeconds = null;
    state.lastSavedRideM = null;
    state.routeSavedId = null;
  }
  if (!accountUser) {
    if (wasViewingActivity && el.finishModal.classList.contains('open')) {
      closeFinishModal();
    }
    if (el.routesModal && el.routesModal.classList.contains('open')) {
      el.routesModal.classList.remove('open');
    }
    if (el.activitiesModal && el.activitiesModal.classList.contains('open')) {
      el.activitiesModal.classList.remove('open');
    }
    savedRoutes = [];
    savedRoutesError = '';
    savedRoutesLoading = false;
    savedActivities = [];
    savedActivitiesError = '';
    savedActivitiesLoading = false;
    viewingActivityId = null;
    selectedActivityId = null;
    activityBusy = false;
    accountBusy = false;
  }
  updateAccountButton();
  renderAccount();
  updateAuthLocks();
  if (accountUser && accountUser.id !== previousId) {
    syncAccountProfile();
  }
}

function openAccountModal() {
  renderAccount();
  el.accountModal.classList.add('open');
  el.btnCloseAccount.focus({ preventScroll: true });
}

function closeAccountModal() {
  el.accountModal.classList.remove('open');
  el.btnAccount.focus({ preventScroll: true });
}

function openRoutesModal() {
  if (!requireLogin('Moje trasy')) return;
  refreshAccountCurrentRoute();
  renderSavedRoutes();
  el.routesModal.classList.add('open');
  el.btnCloseRoutes.focus({ preventScroll: true });
  if (supa && accountUser) {
    refreshSavedRoutes();
  }
}

function closeRoutesModal() {
  el.routesModal.classList.remove('open');
  el.btnRoutes.focus({ preventScroll: true });
}

function openActivitiesModal() {
  if (!requireLogin('Moje jazdy')) return;
  renderSavedActivities();
  el.activitiesModal.classList.add('open');
  el.btnCloseActivities.focus({ preventScroll: true });
  if (supa && accountUser) {
    refreshSavedActivities();
  }
}

function closeActivitiesModal() {
  el.activitiesModal.classList.remove('open');
  el.btnActivities.focus({ preventScroll: true });
}

function consumeLoginPending() {
  try {
    if (sessionStorage.getItem('vct.loginPending') === '1') {
      sessionStorage.removeItem('vct.loginPending');
      return true;
    }
  } catch (_) {}
  return false;
}

function showAuthRedirectError() {
  try {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const message = query.get('error_description') || hash.get('error_description') ||
      query.get('error') || hash.get('error');
    if (message) showToast(`Prihlásenie zlyhalo: ${message}`, 'error', 9000);
  } catch (_) {}
}

async function signInWithGoogle() {
  if (!supa) {
    showToast('Účet nie je nastavený. Doplň údaje Supabase podľa návodu SETUP_SUPABASE.md.', 'warning', 7000);
    return;
  }
  if (!/^https?:$/.test(location.protocol)) {
    console.warn('Google login: stránka nie je otvorená cez http(s).');
    showToast(
      'Prihlásenie cez Google tu nie je dostupné. Otvor stránku z webovej adresy a skús to znova.',
      'warning',
      8500
    );
    return;
  }

  el.btnGoogleLogin.disabled = true;
  try {
    try { sessionStorage.setItem('vct.loginPending', '1'); } catch (_) {}
    const { error } = await supa.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: accountRedirectUrl() }
    });
    if (error) throw error;
  } catch (error) {
    try { sessionStorage.removeItem('vct.loginPending'); } catch (_) {}
    console.error('Google login:', error);
    showToast(`Prihlásenie zlyhalo: ${accountErrorMessage(error)}`, 'error', 7500);
    el.btnGoogleLogin.disabled = false;
  }
}

async function signOutAccount() {
  if (!supa) return;
  el.btnSignOut.disabled = true;
  try {
    const { error } = await supa.auth.signOut();
    if (error) throw error;
    try {
      localStorage.removeItem(RIDER_WEIGHT_KEY);
      localStorage.removeItem(RIDER_WEIGHT_UPDATED_KEY);
      localStorage.removeItem(FTP_KEY);
      localStorage.removeItem(FTP_UPDATED_KEY);
    } catch (_) {}
    state.weight = 75;
    applyFtp(200);
    setAccountUser(null);
    showToast('Odhlásené z účtu.', 'info', 3000);
  } catch (error) {
    console.error('Odhlásenie:', error);
    showToast(`Odhlásenie zlyhalo: ${accountErrorMessage(error)}`, 'error', 6000);
  } finally {
    el.btnSignOut.disabled = false;
  }
}

async function refreshSavedRoutes() {
  if (!supa || !accountUser || savedRoutesLoading) return;
  savedRoutesLoading = true;
  savedRoutesError = '';
  renderSavedRoutes();

  try {
    const { data, error } = await supa
      .from(ROUTES_TABLE)
      .select('id, name, distance_m, ascent_m, point_count, created_at')
      .eq('user_id', accountUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    savedRoutes = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Načítanie trás:', error);
    savedRoutes = [];
    savedRoutesError = `Trasy sa nepodarilo načítať. ${accountErrorMessage(error)}`;
  } finally {
    savedRoutesLoading = false;
    renderSavedRoutes();
  }
}

async function refreshSavedActivities() {
  if (!supa || !accountUser || savedActivitiesLoading) return;
  savedActivitiesLoading = true;
  savedActivitiesError = '';
  renderSavedActivities();

  try {
    const { data, error } = await supa
      .from(ACTIVITIES_TABLE)
      .select('id, name, duration_s, distance_m, ascent_m, calories, avg_power_w, np_w, avg_hr, weight_kg, created_at')
      .eq('user_id', accountUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    savedActivities = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Načítanie jázd:', error);
    savedActivities = [];
    savedActivitiesError = `Jazdy sa nepodarilo načítať. ${accountErrorMessage(error)}`;
  } finally {
    savedActivitiesLoading = false;
    renderSavedActivities();
  }
}

async function saveCurrentActivity() {
  if (!supa || !accountUser) {
    showToast('Najprv sa prihlás v okne Konto, aby sa jazda uložila.', 'warning', 4500);
    return;
  }
  if (activityBusy) return;

  const summary = currentRideSummary();
  if (summary.durationS < 1) {
    showToast('Jazda je príliš krátka na uloženie. Najprv chvíľu jazdi.', 'warning', 4200);
    return;
  }

  activityBusy = true;
  el.btnSaveActivity.disabled = true;
  el.btnSaveActivity.textContent = 'Ukladám…';

  try {
    const payload = {
      user_id: accountUser.id,
      name: (summary.name || 'Jazda').slice(0, 160),
      duration_s: Math.max(0, Math.round(summary.durationS)),
      distance_m: Math.max(0, Math.round(summary.distanceM)),
      ascent_m: Math.max(0, Math.round(summary.ascentM)),
      calories: Math.max(0, Math.round(summary.calories)),
      avg_power_w: Math.max(0, Math.round(summary.avgPowerW)),
      np_w: Math.max(0, Math.round(summary.npW)),
      avg_hr: summary.avgHr === null || summary.avgHr === undefined ? null : Math.round(summary.avgHr),
      weight_kg: summary.weightKg || null
    };

    const { error } = await supa.from(ACTIVITIES_TABLE).insert(payload);
    if (error) throw error;

    state.lastSavedRideSeconds = summary.durationS;
    state.lastSavedRideM = summary.distanceM;
    el.btnSaveActivity.textContent = 'Uložené ✓';
    el.btnSaveActivity.title = 'Táto jazda je už uložená (pokračuj v jazde pre nové uloženie)';
    showToast(`Jazda „${payload.name}“ je uložená v účte.`, 'success', 4400);
    await refreshSavedActivities();
  } catch (error) {
    console.error('Uloženie jazdy:', error);
    el.btnSaveActivity.textContent = 'Uložiť aktivitu';
    el.btnSaveActivity.disabled = false;
    showToast(`Jazdu sa nepodarilo uložiť: ${accountErrorMessage(error)}`, 'error', 8500);
  } finally {
    activityBusy = false;
  }
}

async function renameSavedActivity(id) {
  if (!supa || !accountUser || activityBusy) return;
  const item = savedActivities.find((activity) => activity.id === id);
  if (!item) return;

  const current = String(item.name || 'Jazda');
  const answer = window.prompt('Nový názov jazdy:', current);
  if (answer === null) return;

  const nextName = answer.trim().slice(0, 160);
  if (!nextName) {
    showToast('Názov jazdy nesmie byť prázdny.', 'warning', 3800);
    return;
  }
  if (nextName === current) return;

  activityBusy = true;
  try {
    const { data, error } = await supa
      .from(ACTIVITIES_TABLE)
      .update({ name: nextName })
      .eq('id', id)
      .eq('user_id', accountUser.id)
      .select('id, name');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Databáza nepovolila premenovanie (chýba RLS pravidlo UPDATE pre tabuľku „activities“ – pozri SETUP_SUPABASE.md).');
    }
    item.name = nextName;
    renderSavedActivities();
    if (viewingActivityId === id && el.statRouteName) {
      el.statRouteName.textContent = nextName;
    }
    showToast(`Jazda premenovaná na „${nextName}“.`, 'success', 3600);
  } catch (error) {
    console.error('Premenovanie jazdy:', error);
    showToast(`Jazdu sa nepodarilo premenovať: ${accountErrorMessage(error)}`, 'error', 8500);
  } finally {
    activityBusy = false;
  }
}

async function deleteSavedActivity(id) {
  if (!supa || !accountUser || activityBusy) return;
  const item = savedActivities.find((activity) => activity.id === id);
  if (!item) return;

  const answer = window.confirm(`Vymazať jazdu „${item.name || 'Jazda'}“ z účtu?\n\nTáto akcia sa nedá vrátiť.`);
  if (!answer) return;

  activityBusy = true;
  try {
    const { error } = await supa
      .from(ACTIVITIES_TABLE)
      .delete()
      .eq('id', id)
      .eq('user_id', accountUser.id);
    if (error) throw error;
    savedActivities = savedActivities.filter((activity) => activity.id !== id);
    renderSavedActivities();
    if (viewingActivityId === id) closeFinishModal();
    showToast('Jazda bola vymazaná z účtu.', 'info', 3200);
  } catch (error) {
    console.error('Vymazanie jazdy:', error);
    showToast(`Jazdu sa nepodarilo vymazať: ${accountErrorMessage(error)}`, 'error', 7500);
  } finally {
    activityBusy = false;
  }
}

async function saveCurrentRoute() {
  if (!supa || !accountUser) {
    showToast('Najprv sa prihlás cez Google.', 'warning', 4000);
    return;
  }
  if (!state.route || !state.routeGpxText) {
    showToast('Najprv načítaj GPX trasu, potom ju môžeš uložiť do účtu.', 'warning', 4500);
    return;
  }
  if (accountBusy) return;

  const duplicate = findMatchingSavedRoute();
  if (duplicate) {
    const saveCopy = window.confirm(
      `Trasa „${duplicate.name || state.route.name}“ s rovnakou dĺžkou už v účte existuje.\n\nChceš ju napriek tomu uložiť ako novú kópiu?`
    );
    if (!saveCopy) return;
  }

  accountBusy = true;
  el.btnSaveRoute.disabled = true;
  el.btnSaveRoute.textContent = 'Ukladám…';

  try {
    const gpxText = state.routeGpxText;
    const bytes = new Blob([gpxText]).size;
    if (bytes > MAX_GPX_BYTES) {
      throw new Error(`GPX má ${(bytes / 1024 / 1024).toFixed(1)} MB, limit je 2 MB.`);
    }

    const payload = {
      user_id: accountUser.id,
      name: String(state.route.name || 'GPX trasa').slice(0, 120),
      distance_m: Math.round(state.route.totalM),
      ascent_m: Math.round(state.route.ascentM),
      point_count: state.route.points.length,
      gpx_text: gpxText
    };

    const { error } = await supa.from(ROUTES_TABLE).insert(payload);
    if (error) throw error;

    showToast(`Trasa „${payload.name}“ je uložená v účte.`, 'success', 4200);
    await refreshSavedRoutes();
    const saved = findMatchingSavedRoute();
    state.routeSavedId = saved ? saved.id : 'saved';
  } catch (error) {
    console.error('Uloženie trasy:', error);
    showToast(`Trasu sa nepodarilo uložiť: ${accountErrorMessage(error)}`, 'error', 8000);
  } finally {
    accountBusy = false;
    refreshAccountCurrentRoute();
  }
}

async function loadSavedRoute(id) {
  if (!supa || !accountUser || accountBusy) return;
  const item = savedRoutes.find((route) => route.id === id);
  if (!item) return;

  if (state.rideM > 20) {
    const answer = window.confirm(
      `Načítať trasu „${item.name}“?\n\nAktuálna jazda (${formatKm(state.rideM / 1000, 2)} km) sa vynuluje a štatistiky sa začnú od začiatku.`
    );
    if (!answer) return;
  }

  accountBusy = true;
  try {
    const { data, error } = await supa
      .from(ROUTES_TABLE)
      .select('gpx_text')
      .eq('id', id)
      .eq('user_id', accountUser.id)
      .single();

    if (error) throw error;
    if (!data || !data.gpx_text) throw new Error('Trasa neobsahuje GPX dáta.');

    const parsed = parseGPX(data.gpx_text, `${item.name || 'trasa'}.gpx`);
    parsed.name = item.name || parsed.name;
    parsed.isDemo = false;
    applyRoute(parsed, data.gpx_text, `${parsed.name}.gpx`, id);
    if (el.routesModal && el.routesModal.classList.contains('open')) {
      closeRoutesModal();
    }

    showToast(
      `Trasa „${parsed.name}“ načítaná z účtu · ${formatKm(parsed.totalM / 1000, 1)} km · +${Math.round(parsed.ascentM)} m.`,
      'success',
      5200
    );
  } catch (error) {
    console.error('Načítanie trasy:', error);
    showToast(`Trasu sa nepodarilo načítať: ${accountErrorMessage(error)}`, 'error', 7500);
  } finally {
    accountBusy = false;
  }
}

async function renameSavedRoute(id) {
  if (!supa || !accountUser || accountBusy) return;
  const item = savedRoutes.find((route) => route.id === id);
  if (!item) return;

  const current = String(item.name || 'GPX trasa');
  const answer = window.prompt('Nový názov trasy:', current);
  if (answer === null) return;

  const nextName = answer.trim().slice(0, 120);
  if (!nextName) {
    showToast('Názov trasy nesmie byť prázdny.', 'warning', 3800);
    return;
  }
  if (nextName === current) return;

  accountBusy = true;
  try {
    const { data, error } = await supa
      .from(ROUTES_TABLE)
      .update({ name: nextName })
      .eq('id', id)
      .eq('user_id', accountUser.id)
      .select('id, name');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Databáza nepovolila premenovanie (chýba RLS pravidlo UPDATE pre tabuľku „routes“ – pozri SETUP_SUPABASE.md).');
    }
    item.name = nextName;
    renderSavedRoutes();
    if (state.route && state.routeSavedId === id) {
      state.route.name = nextName;
      el.routeName.textContent = nextName;
      refreshAccountCurrentRoute();
    }
    showToast(`Trasa premenovaná na „${nextName}“.`, 'success', 3600);
  } catch (error) {
    console.error('Premenovanie trasy:', error);
    showToast(`Trasu sa nepodarilo premenovať: ${accountErrorMessage(error)}`, 'error', 8500);
  } finally {
    accountBusy = false;
  }
}

async function deleteSavedRoute(id) {
  if (!supa || !accountUser || accountBusy) return;
  const item = savedRoutes.find((route) => route.id === id);
  if (!item) return;

  const answer = window.confirm(`Vymazať trasu „${item.name}“ z účtu?\n\nTáto akcia sa nedá vrátiť.`);
  if (!answer) return;

  accountBusy = true;
  try {
    const { error } = await supa
      .from(ROUTES_TABLE)
      .delete()
      .eq('id', id)
      .eq('user_id', accountUser.id);
    if (error) throw error;
    savedRoutes = savedRoutes.filter((route) => route.id !== id);
    if (state.routeSavedId === id) {
      state.routeSavedId = null;
      refreshAccountCurrentRoute();
    }
    renderSavedRoutes();
    showToast('Trasa bola vymazaná z účtu.', 'info', 3200);
  } catch (error) {
    console.error('Mazanie trasy:', error);
    showToast(`Trasu sa nepodarilo vymazať: ${accountErrorMessage(error)}`, 'error', 7000);
  } finally {
    accountBusy = false;
  }
}

async function initAccount() {
  showAuthRedirectError();
  updateAccountButton();
  renderAccount();
  if (!supa) return;

  try {
    const { data, error } = await supa.auth.getSession();
    if (error) throw error;
    const user = data.session && data.session.user ? data.session.user : null;
    setAccountUser(user);
    if (user && consumeLoginPending()) {
      openAccountModal();
      showToast(`Prihlásený ako ${user.email || 'používateľ'}.`, 'success', 4200);
    }
  } catch (error) {
    console.error('Supabase session:', error);
    showToast(`Účet sa nepodarilo načítať: ${accountErrorMessage(error)}`, 'error', 7000);
  }

  supa.auth.onAuthStateChange((event, session) => {
    // Supabase odporúča nespúšťať ďalšie volania priamo v callbacku.
    setTimeout(() => {
      const user = session && session.user ? session.user : null;
      const previousId = accountUser ? accountUser.id : null;
      setAccountUser(user);

      if (user && event === 'SIGNED_IN' && previousId !== user.id) {
        showToast(`Prihlásený ako ${user.email || 'používateľ'}.`, 'success', 4200);
      }

      if (user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        if (consumeLoginPending()) openAccountModal();
        else if (event === 'SIGNED_IN') {
          if (el.routesModal.classList.contains('open')) refreshSavedRoutes();
          if (el.activitiesModal.classList.contains('open')) refreshSavedActivities();
        }
      }
    }, 0);
  });
}

/* =========================================================================
   BLUETOOTH – FTMS Trenažér + Hrudný pás
   ========================================================================= */
let trainer = null;
let heartRateSensor = null;

let controlGranted = false;
let controlCooldownUntil = 0;
let cpPending = null;
let cpSequence = 0;
let cpChain = Promise.resolve();

let lastSimGrade = null;
let lastSimSentAt = 0;
let simBusy = false;
let simNoAck = false;
let lastCpResult = null;
let lastCpAt = 0;

let ergBusy = false;
let lastErgPower = null;
let lastErgSentAt = 0;
let ergNoAck = false;

function setTrainerUI(mode) {
  const connected = mode === 'connected';
  const connecting = mode === 'connecting';

  el.btnTrainer.classList.toggle('connected', connected);
  el.btnTrainer.classList.toggle('connecting', connecting);
  el.btnTrainer.disabled = connecting;
  el.trainerDot.className = 'device-dot' + (connected ? ' connected' : connecting ? ' connecting' : '');
  el.liveDot.classList.toggle('on', connected);

  if (connected) {
    el.btnTrainer.title = `${trainer ? trainer.name : 'Trenažér'} · klikni pre odpojenie`;
  } else if (connecting) {
    el.btnTrainer.title = 'Pripájam trenažér…';
  } else {
    el.btnTrainer.title = 'Pripojiť trenažér (FTMS)';
  }

  if (el.workoutModal && el.workoutModal.classList.contains('open')) {
    updateWorkoutModalState();
  }
  syncWakeLock();
}

function setHrUI(mode) {
  const connected = mode === 'connected';
  const connecting = mode === 'connecting';

  el.btnHr.classList.toggle('connected', connected);
  el.btnHr.classList.toggle('connecting', connecting);
  el.btnHr.disabled = connecting;
  el.hrDot.className = 'device-dot' + (connected ? ' connected' : connecting ? ' connecting' : '');

  if (connected) {
    el.btnHr.title = `${heartRateSensor ? heartRateSensor.name : 'Hrudný pás'} · klikni pre odpojenie`;
  } else if (connecting) {
    el.btnHr.title = 'Pripájam hrudný pás…';
  } else {
    el.btnHr.title = 'Pripojiť hrudný pás (Heart Rate Service)';
  }
}

function bluetoothErrorText(error) {
  if (!error) return 'neznáma chyba';
  if (error.name === 'SecurityError') {
    return 'Web Bluetooth nie je dostupné. Použi Windows a prehliadač Chrome alebo Edge.';
  }
  if (error.name === 'NotFoundError') {
    return 'výber zariadenia bol zrušený alebo sa nenašlo žiadne zariadenie.';
  }
  if (error.name === 'NetworkError') {
    return 'so zariadením sa nepodarilo spojiť.';
  }
  if (error.name === 'NotSupportedError') {
    return 'toto zariadenie nepodporuje požadovanú Bluetooth službu.';
  }
  return error.message || String(error);
}

function cpResultText(result) {
  if (result === -1) return 'trenažér neodpovedal v časovom limite';
  if (result === -2) return 'zápis do Control Point zlyhal';
  if (result === -3) return 'trenažér nie je pripojený';
  return CP_RESULT_TEXT[result] || `kód ${result}`;
}

/* ---------------------------- Trenažér ---------------------------- */
async function connectTrainer() {
  if (trainer) {
    try { trainer.device.gatt.disconnect(); } catch (_) {}
    return;
  }
  if (state.connectingTrainer) return;

  if (!navigator.bluetooth) {
    showToast('Web Bluetooth nie je dostupné. Použi Windows a prehliadač Chrome alebo Edge.', 'error', 9000);
    return;
  }

  state.connectingTrainer = true;
  setTrainerUI('connecting');
  let device = null;

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [UUID_FTMS] },
        { namePrefix: 'Van Rysel' },
        { namePrefix: 'VAN RYSEL' },
        { namePrefix: 'D100' }
      ],
      optionalServices: [UUID_FTMS, UUID_FMS]
    });

    device.addEventListener('gattserverdisconnected', onTrainerDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUID_FTMS);
    const dataCharacteristic = await service.getCharacteristic(UUID_IBD);

    let controlCharacteristic;
    try {
      controlCharacteristic = await service.getCharacteristic(UUID_CP);
    } catch (_) {
      throw new Error('trenažér neposkytuje FTMS Control Point (0x2AD9)');
    }

    const name = device.name || 'FTMS trenažér';
    trainer = {
      device,
      server,
      service,
      dataCharacteristic,
      controlCharacteristic,
      name
    };

    controlGranted = false;
    controlCooldownUntil = 0;
    cpPending = null;
    cpChain = Promise.resolve();
    lastSimGrade = null;
    lastSimSentAt = 0;
    simNoAck = false;
    lastCpResult = null;
    lastCpAt = 0;
    state.simErrorShown = false;
    state.trainerBaseM = null;
    state.trainerDistOffset = state.rideM;
    state.hasTotalDistance = false;
    state.lastTotalM = null;
    state.lastTotalAt = 0;
    state.lastDistChangeAt = 0;
    state.distanceFallback = false;
    state.speed = 0;
    state.power = 0;
    state.cadence = 0;

    await dataCharacteristic.startNotifications();
    dataCharacteristic.addEventListener('characteristicvaluechanged', onIndoorBikeData);

    try {
      await controlCharacteristic.startNotifications();
      controlCharacteristic.addEventListener('characteristicvaluechanged', onControlPointResponse);
    } catch (error) {
      console.warn('Control Point indikácie nie sú dostupné:', error);
    }

    try {
      const statusCharacteristic = await service.getCharacteristic(UUID_FMS);
      await statusCharacteristic.startNotifications();
      statusCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
        const dv = event.target.value;
        if (dv.byteLength >= 1 && dv.getUint8(0) === 0xFF) {
          controlGranted = false;
          showToast('Trenažér odobral kontrolu inej aplikácii. Zatvor Zwift / Decathlon app a pripoj sa znova.', 'warning', 8000);
        }
      });
    } catch (_) {}

    setTrainerUI('connected');
    showToast(`Trenažér pripojený: ${name}`, 'success', 4200);

    if (state.workoutActive) {
      if (!state.workoutErg && state.workoutErgPreferred) state.workoutErg = true;
      if (state.workoutErg) {
        lastErgPower = null;
        lastErgSentAt = 0;
        ergNoAck = false;
        applyWorkoutTarget(true);
      }
      renderWorkoutPanel();
    } else {
      queueSimulation();
    }
  } catch (error) {
    console.error('Trenažér:', error);
    if (device && device.gatt && device.gatt.connected) {
      try { device.gatt.disconnect(); } catch (_) {}
    }
    trainer = null;
    setTrainerUI('disconnected');
    showToast(`Trenažér sa nepodarilo pripojiť: ${bluetoothErrorText(error)}`, 'error', 8000);
  } finally {
    state.connectingTrainer = false;
    if (!trainer) setTrainerUI('disconnected');
  }
}

function onTrainerDisconnected() {
  const wasConnected = Boolean(trainer);
  const name = trainer ? trainer.name : 'Trenažér';

  trainer = null;
  controlGranted = false;
  cpPending = null;
  lastSimGrade = null;
  lastSimSentAt = 0;
  simBusy = false;
  simNoAck = false;
  lastErgPower = null;
  lastErgSentAt = 0;
  ergBusy = false;
  ergNoAck = false;

  state.power = 0;
  state.cadence = 0;
  state.speed = 0;
  state.lastBikeAt = 0;

  setTrainerUI('disconnected');
  renderHUD();
  renderWorkoutPanel();

  if (state.workoutActive) {
    showToast('Trenažér sa odpojil – tréning čaká na pripojenie.', 'warning', 6000);
  } else if (wasConnected) {
    showToast(`${name} bol odpojený.`, 'info', 4500);
  }
}

/* -------------------- Indoor Bike Data 0x2AD2 -------------------- */
function onIndoorBikeData(event) {
  const dv = event.target.value;
  if (dv.byteLength < 2) return;

  try {
    const flags = dv.getUint16(0, true);
    let offset = 2;
    const canRead = (bytes) => offset + bytes <= dv.byteLength;

    let speed = null;
    let avgSpeed = null;
    let cadence = null;
    let avgCadence = null;
    let totalDistanceM = null;
    let power = null;

    if ((flags & 0x0001) === 0) {
      if (!canRead(2)) return;
      speed = dv.getUint16(offset, true) / 100;
      offset += 2;
    }

    if (flags & 0x0002) {
      if (!canRead(2)) return;
      avgSpeed = dv.getUint16(offset, true) / 100;
      offset += 2;
    }

    if (flags & 0x0004) {
      if (!canRead(2)) return;
      cadence = dv.getUint16(offset, true) / 2;
      offset += 2;
    }

    if (flags & 0x0008) {
      if (!canRead(2)) return;
      avgCadence = dv.getUint16(offset, true) / 2;
      offset += 2;
    }

    if (flags & 0x0010) {
      if (!canRead(3)) return;
      totalDistanceM = dv.getUint8(offset) |
        (dv.getUint8(offset + 1) << 8) |
        (dv.getUint8(offset + 2) << 16);
      offset += 3;
    }

    if (flags & 0x0020) {
      if (!canRead(2)) return;
      offset += 2;
    }

    if (flags & 0x0040) {
      if (!canRead(2)) return;
      power = dv.getInt16(offset, true);
      offset += 2;
    }

    if (flags & 0x0080) {
      if (!canRead(2)) return;
      offset += 2;
    }

    if (flags & 0x0100) {
      if (!canRead(5)) return;
      offset += 5;
    }

    if (flags & 0x0200) {
      if (!canRead(1)) return;
      offset += 1;
    }

    if (flags & 0x0400) {
      if (!canRead(1)) return;
      offset += 1;
    }

    if (flags & 0x0800) {
      if (!canRead(2)) return;
      offset += 2;
    }

    if (flags & 0x1000) {
      if (!canRead(2)) return;
      offset += 2;
    }

    if (speed === null && avgSpeed !== null) speed = avgSpeed;
    if (cadence === null && avgCadence !== null) cadence = avgCadence;

    state.lastBikeAt = performance.now();

    if (speed !== null && Number.isFinite(speed)) {
      state.speed = Math.max(0, Math.min(120, speed));
    }
    if (cadence !== null && Number.isFinite(cadence)) {
      state.cadence = Math.max(0, Math.min(250, cadence));
    }
    if (power !== null && Number.isFinite(power)) {
      state.power = clamp(power, -500, 3000);
    }

    if (totalDistanceM !== null && Number.isFinite(totalDistanceM) && !state.ridePaused) {
      state.hasTotalDistance = true;
      const nowMs = performance.now();
      const prevTotal = state.lastTotalM;

      // Počas workoutu (ERG/Manuál) sa vzdialenosť počíta fyzikálne z výkonu a sklonu
      // GPX trasy, nie z rýchlosti zotrvačníka – offset trenažéra iba priebežne držíme
      // zosynchronizovaný pre prípadné plynulé pokračovanie vo voľnej jazde.
      if (state.workoutActive) {
        state.trainerBaseM = totalDistanceM;
        state.trainerDistOffset = state.rideM;
        state.lastTotalM = totalDistanceM;
        state.lastTotalAt = nowMs;
        state.lastTotalDistance = totalDistanceM;
        state.lastTotalDelta = prevTotal !== null ? totalDistanceM - prevTotal : 0;
        if (prevTotal === null || totalDistanceM !== prevTotal) {
          state.lastDistChangeAt = nowMs;
        }
      } else {
        if (state.trainerBaseM === null) {
          state.trainerBaseM = totalDistanceM;
          state.lastTotalM = totalDistanceM;
          state.lastTotalAt = nowMs;
        }

        let delta = totalDistanceM - state.trainerBaseM;
        if (delta < 0) {
          state.trainerBaseM = totalDistanceM;
          delta = 0;
        } else if (state.lastTotalM !== null && totalDistanceM > state.lastTotalM) {
          const dtSec = Math.max(0.05, (nowMs - state.lastTotalAt) / 1000);
          const jump = totalDistanceM - state.lastTotalM;
          const speedMps = Math.max(0, state.speed) / 3.6;
          const maxJump = Math.max(20, speedMps * dtSec * 4 + 12);
          if (jump > maxJump) {
            state.trainerBaseM = totalDistanceM - (state.rideM - state.trainerDistOffset);
            delta = state.rideM - state.trainerDistOffset;
          }
        }
        state.lastTotalM = totalDistanceM;
        state.lastTotalAt = nowMs;
        state.lastTotalDistance = totalDistanceM;
        state.lastTotalDelta = prevTotal !== null ? totalDistanceM - prevTotal : 0;
        if (prevTotal === null || totalDistanceM !== prevTotal) {
          state.lastDistChangeAt = nowMs;
        }

        if (state.distanceFallback) {
          state.distanceFallback = false;
          state.trainerBaseM = totalDistanceM;
          state.trainerDistOffset = state.rideM;
          delta = 0;
        }

        const totalRideM = state.trainerDistOffset + delta;
        if (totalRideM > state.rideM) state.rideM = totalRideM;
      }
    }

    const tickNow = performance.now();
    if (tickNow - lastTickAt >= 250) {
      tick(tickNow);
    }
  } catch (error) {
    console.warn('Neplatný FTMS packet 0x2AD2:', error);
  }
}

/* -------------------- Fitness Machine Control Point -------------------- */
function cpCommand(opcode, payload, timeout = CP_TIMEOUT_MS) {
  const bytes = new Uint8Array(1 + payload.length);
  bytes[0] = opcode;
  bytes.set(payload, 1);

  const run = () => new Promise((resolve) => {
    if (!trainer || !trainer.controlCharacteristic) {
      resolve(-3);
      return;
    }

    const token = ++cpSequence;
    const timer = setTimeout(() => {
      if (cpPending && cpPending.token === token) cpPending = null;
      resolve(-1);
    }, timeout);

    cpPending = {
      token,
      opcode,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      }
    };

    let writePromise;
    try {
      writePromise = trainer.controlCharacteristic.writeValueWithResponse
        ? trainer.controlCharacteristic.writeValueWithResponse(bytes)
        : trainer.controlCharacteristic.writeValue(bytes);
    } catch (error) {
      writePromise = Promise.reject(error);
    }

    Promise.resolve(writePromise).catch((error) => {
      console.warn('FTMS Control Point write:', error);
      if (cpPending && cpPending.token === token) cpPending = null;
      clearTimeout(timer);
      resolve(-2);
    });
  });

  const next = cpChain.then(run, run);
  cpChain = next.catch(() => {});
  return next;
}

function onControlPointResponse(event) {
  const dv = event.target.value;
  if (dv.byteLength < 3) return;
  if (dv.getUint8(0) !== 0x80) return;

  const requestOpcode = dv.getUint8(1);
  const resultCode = dv.getUint8(2);

  if (cpPending && cpPending.opcode === requestOpcode) {
    const pending = cpPending;
    cpPending = null;
    pending.resolve(resultCode);
  }
}

async function ensureControl() {
  if (!trainer) return false;
  if (controlGranted) return true;
  if (Date.now() < controlCooldownUntil) return false;

  const result = await cpCommand(0x00, new Uint8Array(0));
  if (result === 0x01) {
    controlGranted = true;
    controlCooldownUntil = 0;
    await cpCommand(0x07, new Uint8Array(0), 2000);
    return true;
  }

  controlCooldownUntil = Date.now() + 15000;

  if (!state.simErrorShown) {
    state.simErrorShown = true;
    showToast(`Trenažér neudelil FTMS kontrolu: ${cpResultText(result)}. Zatvor iné aplikácie (Zwift, Decathlon) a pripoj sa znova.`, 'error', 9000);
  }
  return false;
}

function simulationParameters(grade) {
  const payload = new Uint8Array(6);
  const dv = new DataView(payload.buffer);
  dv.setInt16(0, 0, true);
  dv.setInt16(2, Math.round(clamp(grade, GRADE_MIN, GRADE_MAX) * 100), true);
  dv.setUint8(4, 40);
  dv.setUint8(5, 25);
  return payload;
}

function queueSimulation() {
  if (!trainer || simBusy || state.workoutActive) return;

  simBusy = true;
  (async () => {
    try {
      while (trainer && !state.workoutActive) {
        const target = clamp(state.currentGrade || 0, GRADE_MIN, GRADE_MAX);

        if (lastSimGrade !== null && Math.abs(target - lastSimGrade) < 0.25) break;

        const waitFor = SIM_INTERVAL_MS - (performance.now() - lastSimSentAt);
        if (waitFor > 0) await delay(waitFor);
        if (!trainer || state.workoutActive) break;

        const latest = clamp(state.currentGrade || 0, GRADE_MIN, GRADE_MAX);
        if (lastSimGrade !== null && Math.abs(latest - lastSimGrade) < 0.25) break;

        if (!await ensureControl()) break;
        if (!trainer || state.workoutActive) break;

        const result = await cpCommand(0x11, simulationParameters(latest), simNoAck ? 250 : 1500);
        lastCpResult = result;
        lastCpAt = performance.now();

        if (result === -1) {
          simNoAck = true;
          lastSimGrade = latest;
          lastSimSentAt = performance.now();
          state.simErrorShown = false;
        } else if (result !== 0x01) {
          if (!state.simErrorShown) {
            state.simErrorShown = true;
            showToast(`Sklon sa nepodarilo nastaviť: ${cpResultText(result)}.`, 'error', 8000);
          }
          break;
        } else {
          lastSimGrade = latest;
          lastSimSentAt = performance.now();
          state.simErrorShown = false;
        }

        if (Math.abs((state.currentGrade || 0) - latest) < 0.25) break;
      }
    } catch (error) {
      console.error('Simulácia sklonu:', error);
    } finally {
      simBusy = false;
    }
  })();
}

/* -------------------- ERG – cieľový výkon (FTMS 0x05) -------------------- */
function targetPowerParameters(watts) {
  const payload = new Uint8Array(2);
  const view = new DataView(payload.buffer);
  view.setUint16(0, Math.round(clamp(watts, ERG_MIN_W, ERG_MAX_W)), true);
  return payload;
}

function queueTargetPower(force = false) {
  if (!trainer || ergBusy) return;
  if (!state.workoutActive || !state.workoutErg || state.workoutPaused) return;

  ergBusy = true;
  (async () => {
    try {
      while (trainer && state.workoutActive && state.workoutErg && !state.workoutPaused) {
        const target = Math.round(clamp(state.workoutTargetPower || 0, ERG_MIN_W, ERG_MAX_W));

        if (!force && lastErgPower !== null && Math.abs(target - lastErgPower) < ERG_MIN_DIFF_W) break;

        const waitFor = ERG_INTERVAL_MS - (performance.now() - lastErgSentAt);
        if (waitFor > 0) await delay(waitFor);
        if (!trainer || !state.workoutActive || !state.workoutErg || state.workoutPaused) break;

        const latest = Math.round(clamp(state.workoutTargetPower || 0, ERG_MIN_W, ERG_MAX_W));
        if (!force && lastErgPower !== null && Math.abs(latest - lastErgPower) < ERG_MIN_DIFF_W) break;

        if (!await ensureControl()) break;
        if (!trainer || !state.workoutActive || !state.workoutErg || state.workoutPaused) break;

        const result = await cpCommand(0x05, targetPowerParameters(latest), ergNoAck ? 250 : 1500);
        lastCpResult = result;
        lastCpAt = performance.now();

        if (result === -1) {
          ergNoAck = true;
          lastErgPower = latest;
          lastErgSentAt = performance.now();
          state.simErrorShown = false;
        } else if (result === 0x02) {
          state.workoutErg = false;
          showToast('Trenažér nepodporuje ERG. Tréning pokračuje v manuálnom režime.', 'warning', 8000);
          break;
        } else if (result !== 0x01) {
          if (!state.simErrorShown) {
            state.simErrorShown = true;
            showToast(`Cieľový výkon sa nepodarilo nastaviť: ${cpResultText(result)}.`, 'error', 8000);
          }
          break;
        } else {
          lastErgPower = latest;
          lastErgSentAt = performance.now();
          state.simErrorShown = false;
        }

        force = false;
        if (Math.abs((state.workoutTargetPower || 0) - latest) < ERG_MIN_DIFF_W) break;
      }
    } catch (error) {
      console.error('ERG cieľový výkon:', error);
    } finally {
      ergBusy = false;
    }
  })();
}

async function sendErgTargetOnce(watts) {
  if (!trainer) return;
  try {
    if (!await ensureControl()) return;
    await cpCommand(0x05, targetPowerParameters(watts), 1500);
  } catch (error) {
    console.warn('ERG jednorazový príkaz:', error);
  }
}

async function sendSimulationOnce(grade) {
  if (!trainer) return;
  try {
    if (!await ensureControl()) return;
    await cpCommand(0x11, simulationParameters(grade), 1500);
  } catch (error) {
    console.warn('Simulácia jednorazový príkaz:', error);
  }
}

/* =========================================================================
   WORKOUT – RIADENIE TRÉNINGU
   ========================================================================= */
let audioContext = null;

function beep(freq = 880, ms = 90, gain = 0.035) {
  if (state.workoutBeepMuted) return;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume();

    const osc = audioContext.createOscillator();
    const volume = audioContext.createGain();
    const now = audioContext.currentTime;

    osc.type = 'sine';
    osc.frequency.value = freq;
    volume.gain.setValueAtTime(0.0001, now);
    volume.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);

    osc.connect(volume);
    volume.connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + ms / 1000 + 0.03);
  } catch (_) {}
}

function readWorkoutFtpInput() {
  const value = el.workoutFtp ? el.workoutFtp.value : state.ftp;
  const normalized = normalizeFtp(value);
  return normalized === null ? state.ftp : normalized;
}

function stepWorkoutFtp(delta) {
  const current = readWorkoutFtpInput();
  const next = clamp(Math.round(current + delta), FTP_MIN, FTP_MAX);
  setFtp(next);
  if (el.workoutFtp) el.workoutFtp.value = String(state.ftp);
  renderWorkoutPreview();
}

function updateWorkoutModalState() {
  if (!el.btnWorkoutErg || !el.btnWorkoutManual) return;
  const hasTrainer = Boolean(trainer);
  const ergOn = hasTrainer && Boolean(state.workoutErgPreferred);

  el.btnWorkoutErg.disabled = !hasTrainer;
  el.btnWorkoutErg.classList.toggle('active', ergOn);
  el.btnWorkoutManual.classList.toggle('active', !ergOn);
  el.btnWorkoutErg.setAttribute('aria-pressed', String(ergOn));
  el.btnWorkoutManual.setAttribute('aria-pressed', String(!ergOn));

  if (el.workoutErgHint) {
    if (!hasTrainer) {
      el.workoutErgHint.textContent = 'Trenažér nie je pripojený – manuálny režim';
    } else {
      el.workoutErgHint.textContent = ergOn
        ? 'Trenažér automaticky drží cieľový výkon'
        : 'Odpor neovládam, zobrazujem len cieľ';
    }
  }
}

function refreshWorkoutRouteNote() {
  const hasRoute = Boolean(state.route);

  if (el.workoutRouteSelect) {
    const select = el.workoutRouteSelect;
    select.textContent = '';

    const isCustomUnsaved = hasRoute && !state.route.isDemo && !state.routeSavedId;
    if (isCustomUnsaved) {
      const opt = document.createElement('option');
      opt.value = '__current__';
      opt.textContent = `${state.route.name} (${formatKm(state.route.totalM / 1000, 1)} km)`;
      select.appendChild(opt);
    }

    const demoOpt = document.createElement('option');
    demoOpt.value = '__demo__';
    demoOpt.textContent = 'Liptovská Osada - Srekovica (ukážková)';
    select.appendChild(demoOpt);

    for (const item of savedRoutes) {
      const opt = document.createElement('option');
      opt.value = `saved:${item.id}`;
      const km = formatKm((Number(item.distance_m) || 0) / 1000, 1);
      opt.textContent = `${item.name || 'Trasa'} (${km} km)`;
      select.appendChild(opt);
    }

    if (hasRoute && state.routeSavedId && savedRoutes.some((r) => r.id === state.routeSavedId)) {
      select.value = `saved:${state.routeSavedId}`;
    } else if (hasRoute && state.route.isDemo) {
      select.value = '__demo__';
    } else if (isCustomUnsaved) {
      select.value = '__current__';
    }
  }

  if (el.workoutRouteText) {
    el.workoutRouteText.classList.toggle('warn', !hasRoute);
    if (hasRoute) {
      const totalM = state.route.totalM;
      el.workoutRouteText.textContent =
        `${formatKm(totalM / 1000, 1)} km · +${Math.round(state.route.ascentM)} m · Mapa sleduje polohu, odpor riadi tréning`;
    } else {
      el.workoutRouteText.textContent =
        'Vyber trasu zo zoznamu alebo nahraj vlastný GPX súbor.';
    }
  }

  if (el.btnStartWorkout) {
    el.btnStartWorkout.disabled = !hasRoute;
    el.btnStartWorkout.title = hasRoute
      ? ''
      : 'Najprv vyber trasu alebo nahraj GPX súbor.';
  }
}

function renderWorkoutList() {
  if (!el.workoutList) return;
  el.workoutList.innerHTML = '';

  for (const workout of WORKOUTS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'workout-item' + (workout.id === selectedWorkoutId ? ' active' : '');
    item.setAttribute('aria-pressed', String(workout.id === selectedWorkoutId));

    const tss = Math.round((workout.totalDuration / 3600) * workout.intensity * workout.intensity * 100);
    item.innerHTML = `
      <div class="workout-item-top">
        <span class="workout-item-name">${workout.name}</span>
        <span class="workout-item-time">${formatTime(workout.totalDuration)}</span>
      </div>
      <div class="workout-item-sub">${workout.subtitle}</div>
      <div class="workout-item-meta">${workout.intervalCount} intervalov · IF ${workout.intensity.toFixed(2)} · TSS ${tss}</div>
    `;

    item.addEventListener('click', () => {
      selectedWorkoutId = workout.id;
      renderWorkoutList();
      renderWorkoutPreview();
    });

    el.workoutList.appendChild(item);
  }
}

const WORKOUT_ZONE_BREAKS = [55, 75, 90, 105, 120];
let renderedWorkoutGraphId = null;

function workoutGraphMaxPct(workout) {
  const peak = Math.max(100, ...workout.phases.flatMap((phase) => [phase.from, phase.to]));
  return Math.max(122, peak * 1.08);
}

function workoutGraphYRatio(pct, maxPct) {
  const topPad = 0.09;
  const botPad = 0.03;
  const usable = 1 - topPad - botPad;
  return clamp(1 - botPad - (pct / maxPct) * usable, topPad, 1 - botPad);
}

function buildWorkoutZonesSvg(workout) {
  const W = 320;
  const H = 72;
  const total = Math.max(1, workout.totalDuration);
  const maxPct = workoutGraphMaxPct(workout);
  const yFor = (pct) => workoutGraphYRatio(pct, maxPct) * H;
  const gap = 0.6;

  const shapes = [];
  let cursor = 0;

  for (const phase of workout.phases) {
    const startX = (cursor / total) * W;
    const endX = ((cursor + phase.duration) / total) * W;
    const spanX = endX - startX;
    cursor += phase.duration;

    if (spanX <= 0) continue;

    if (Math.abs(phase.to - phase.from) < 0.01) {
      const zone = powerZoneForPct(phase.from);
      const x1 = startX + (spanX > 2.2 ? gap * 0.5 : 0);
      const x2 = Math.max(x1 + 0.5, endX - (spanX > 2.2 ? gap * 0.5 : 0));
      const y = yFor(phase.from);
      shapes.push(
        `<polygon points="${x1.toFixed(2)},${H} ${x1.toFixed(2)},${y.toFixed(2)} ${x2.toFixed(2)},${y.toFixed(2)} ${x2.toFixed(2)},${H}" fill="${zone.color}" fill-opacity="0.72"/>`,
        `<line x1="${x1.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${zone.color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`
      );
      continue;
    }

    // Rampa: rozdelíme presne na hraniciach FTP zón, aby farby presne sedeli.
    const low = Math.min(phase.from, phase.to);
    const high = Math.max(phase.from, phase.to);
    const splits = [0, 1];
    for (const brk of WORKOUT_ZONE_BREAKS) {
      if (brk > low && brk < high) {
        splits.push((brk - phase.from) / (phase.to - phase.from));
      }
    }
    splits.sort((a, b) => a - b);

    for (let i = 0; i < splits.length - 1; i++) {
      const t0 = splits[i];
      const t1 = splits[i + 1];
      if (t1 - t0 < 0.001) continue;
      const p0 = phase.from + (phase.to - phase.from) * t0;
      const p1 = phase.from + (phase.to - phase.from) * t1;
      const midPct = (p0 + p1) * 0.5;
      const zone = powerZoneForPct(midPct);
      const x1 = startX + spanX * t0;
      const x2 = startX + spanX * t1;
      const y1 = yFor(p0);
      const y2 = yFor(p1);
      shapes.push(
        `<polygon points="${x1.toFixed(2)},${H} ${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)} ${x2.toFixed(2)},${H}" fill="${zone.color}" fill-opacity="0.72"/>`,
        `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${zone.color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`
      );
    }
  }

  const ftpY = yFor(100).toFixed(2);
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="${ftpY}" x2="${W}" y2="${ftpY}" stroke="rgba(255,255,255,.22)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
      ${shapes.join('')}
    </svg>
  `;
}

function renderWorkoutPreview() {
  if (!el.workoutPreview) return;

  const workout = workoutById(selectedWorkoutId);
  const ftp = readWorkoutFtpInput();
  const total = workout.totalDuration;
  const maxPct = Math.max(100, ...workout.phases.flatMap((phase) => [phase.from, phase.to]));
  const tss = Math.round((total / 3600) * workout.intensity * workout.intensity * 100);

  el.workoutPreview.innerHTML = `
    ${buildWorkoutZonesSvg(workout)}
    <div class="workout-preview-meta">
      <span>FTP ${ftp} W · max ${maxPct} % = ${Math.round(ftp * maxPct / 100)} W</span>
      <span>IF ${workout.intensity.toFixed(2)} · TSS ${tss}</span>
    </div>
  `;
}

function openWorkoutModal() {
  if (!requireLogin('Workout')) return;
  if (state.workoutActive) {
    showToast('Tréning už beží.', 'info', 3000);
    return;
  }

  selectedWorkoutId = workoutById(selectedWorkoutId).id;
  if (el.workoutFtp) el.workoutFtp.value = String(state.ftp);
  updateWorkoutModalState();
  refreshWorkoutRouteNote();
  renderWorkoutList();
  renderWorkoutPreview();
  el.workoutModal.classList.add('open');
  el.btnCloseWorkout.focus({ preventScroll: true });
  if (supa && accountUser && savedRoutes.length === 0 && !savedRoutesLoading) {
    refreshSavedRoutes();
  }
}

function closeWorkoutModal() {
  el.workoutModal.classList.remove('open');
  el.btnWorkout.focus({ preventScroll: true });
}

function applyWorkoutTarget(force = false) {
  if (!state.workoutActive || !state.workout) return;
  const phase = state.workout.phases[state.workoutPhaseIndex];
  if (!phase) return;

  const ratio = phase.duration > 0
    ? clamp(state.workoutPhaseElapsed / phase.duration, 0, 1)
    : 1;
  const pct = phase.from + (phase.to - phase.from) * ratio;
  state.workoutTargetPower = Math.max(0, Math.round(state.ftp * pct / 100));

  if (state.workoutErg && trainer && !state.workoutPaused) {
    queueTargetPower(force);
  }
}

function advanceWorkout(dt) {
  if (!state.workoutActive || !state.workout) return false;

  state.workoutElapsed += dt;
  state.workoutPhaseElapsed += dt;

  let phase = state.workout.phases[state.workoutPhaseIndex];
  while (phase && state.workoutPhaseElapsed >= phase.duration) {
    state.workoutPhaseElapsed -= phase.duration;
    state.workoutPhaseIndex++;
    state.workoutLastBeepSecond = null;
    phase = state.workout.phases[state.workoutPhaseIndex];

    if (!phase) {
      completeWorkout();
      return false;
    }

    if (!state.workoutBeepMuted && phase.kind === 'interval') {
      beep(1046, 90, 0.03);
    }
  }

  if (!phase) {
    completeWorkout();
    return false;
  }

  applyWorkoutTarget();

  if (!state.workoutBeepMuted) {
    const remaining = phase.duration - state.workoutPhaseElapsed;
    const seconds = Math.ceil(remaining);
    if (seconds > 0 && seconds <= 3 && state.workoutLastBeepSecond !== seconds) {
      state.workoutLastBeepSecond = seconds;
      beep(seconds === 1 ? 1175 : 880, 80, 0.03);
    }
  }

  return true;
}

function renderWorkoutPanel(now = performance.now()) {
  const active = Boolean(state.workoutActive && state.workout);
  const wasActive = document.body.classList.contains('workout-active');

  if (wasActive !== active) {
    document.body.classList.toggle('workout-active', active);
  }

  if (!el.workoutPanel) return;
  el.workoutPanel.hidden = !active;
  if (!active) {
    renderedWorkoutGraphId = null;
    return;
  }

  const phase = state.workout.phases[state.workoutPhaseIndex];
  if (!phase) return;

  if (el.wpGraph && renderedWorkoutGraphId !== state.workout.id) {
    el.wpGraph.innerHTML = buildWorkoutZonesSvg(state.workout);
    renderedWorkoutGraphId = state.workout.id;
  }

  const phaseRemaining = Math.max(0, phase.duration - state.workoutPhaseElapsed);
  const totalDuration = Math.max(1, state.workout.totalDuration);
  const totalRemaining = Math.max(0, totalDuration - state.workoutElapsed);
  const ratio = phase.duration > 0 ? clamp(state.workoutPhaseElapsed / phase.duration, 0, 1) : 1;
  const pct = phase.from + (phase.to - phase.from) * ratio;
  const zone = powerZoneForPct(pct);

  const bikeAlive = Boolean(trainer) && (now - state.lastBikeAt < 6000);
  const speed = bikeAlive ? Math.max(0, state.speed) : 0;
  const power = bikeAlive ? Math.max(0, state.power) : 0;
  const moving = bikeAlive && (speed > 0.8 || power > 10);
  const waitNote = !trainer
    ? ' · Pripoj trenažér'
    : (!moving ? ' · Čaká na šliapanie' : '');

  el.workoutPanel.style.setProperty('--wp-zone-color', zone.textColor);
  el.workoutPanel.classList.toggle('is-paused', !moving);

  el.wpTarget.textContent = `${state.workoutTargetPower} W`;
  el.wpRemaining.textContent = formatTime(totalRemaining);
  el.wpPhaseLabel.textContent = `${phase.label}${waitNote}`;
  if (el.wpPhaseTime) el.wpPhaseTime.textContent = formatTime(phaseRemaining);

  const workoutProgressPct = clamp((state.workoutElapsed / totalDuration) * 100, 0, 100);
  const maxPct = workoutGraphMaxPct(state.workout);
  const dotTopPct = workoutGraphYRatio(pct, maxPct) * 100;

  if (el.wpDoneShade) el.wpDoneShade.style.width = `${workoutProgressPct.toFixed(2)}%`;
  if (el.wpPlayhead) el.wpPlayhead.style.left = `${workoutProgressPct.toFixed(2)}%`;
  if (el.wpPlayDot) el.wpPlayDot.style.top = `${dotTopPct.toFixed(2)}%`;

  el.wpBarFill.style.width = `${(ratio * 100).toFixed(1)}%`;
}

function startWorkout() {
  if (state.workoutActive) {
    showToast('Tréning už beží.', 'info', 3000);
    return;
  }

  if (!state.route) {
    showToast('Najprv načítaj GPX trasu alebo ukážkové GPX.', 'warning', 5000);
    refreshWorkoutRouteNote();
    return;
  }

  if (!setFtp(el.workoutFtp.value)) {
    showToast('FTP musí byť v rozsahu 50 – 600 W.', 'warning', 4500);
    el.workoutFtp.focus();
    return;
  }

  if (state.rideSeconds > 20 || state.rideM > 20) {
    const answer = window.confirm('Spustiť tréning? Aktuálna jazda sa vynuluje.');
    if (!answer) return;
  }

  const workout = workoutById(selectedWorkoutId);

  state.workout = workout;
  state.workoutActive = true;
  state.workoutPaused = false;
  state.workoutPhaseIndex = 0;
  state.workoutPhaseElapsed = 0;
  state.workoutElapsed = 0;
  state.workoutTargetPower = 0;
  state.workoutLoopIndex = 0;
  state.workoutLastBeepSecond = null;
  state.workoutSummaryName = workout.name;
  state.workoutErg = Boolean(trainer) && Boolean(state.workoutErgPreferred);

  resetRideStats(false);
  state.workoutSummaryName = workout.name;

  // Panel sa rozšíri ešte pred letom na štart, aby mapa rátala s jeho výškou.
  renderWorkoutPanel();

  const startSample = sampleRoute(state.startM);
  if (startSample) {
    // Kamera je už na štarte – nech ju tick po 20 m nepresúva znova.
    state.mapRideStarted = true;
    flyToRider([startSample.lat, startSample.lon], Math.max(map.getZoom(), 13));
  }

  lastErgPower = null;
  lastErgSentAt = 0;
  ergNoAck = false;
  lastSimGrade = null;
  lastSimSentAt = 0;

  applyWorkoutTarget(true);
  if (state.workoutErg) {
    queueTargetPower(true);
  } else if (trainer) {
    sendSimulationOnce(0);
  }

  closeWorkoutModal();
  renderWorkoutPanel();
  updateChartMarker(true);
  beep(660, 120, 0.04);
  syncWakeLock();

  showToast(
    `Tréning „${workout.name}“ spustený ${state.workoutErg ? 'v ERG režime' : 'v manuálnom režime'}.`,
    'success',
    5000
  );
}

function skipWorkoutPhase() {
  if (!state.workoutActive || !state.workout) return;

  const phase = state.workout.phases[state.workoutPhaseIndex];
  if (!phase) return;

  state.workoutElapsed += Math.max(0, phase.duration - state.workoutPhaseElapsed);
  state.workoutPhaseElapsed = 0;
  state.workoutPhaseIndex++;
  state.workoutLastBeepSecond = null;

  if (state.workoutPhaseIndex >= state.workout.phases.length) {
    completeWorkout();
    return;
  }

  applyWorkoutTarget(true);
  renderWorkoutPanel();
  showToast(
    `Preskočené na: ${state.workout.phases[state.workoutPhaseIndex].label}`,
    'info',
    2500
  );
}

function completeWorkout() {
  if (!state.workoutActive) return;
  finishWorkout('complete');
}

function finishWorkout(reason = 'manual') {
  if (!state.workoutActive) return;

  const workout = state.workout;
  const name = workout ? workout.name : 'Tréning';
  const wasErg = state.workoutErg;

  if (state.route) {
    // Voľná jazda po tréningu nadviaže na miesto, kde sa tréning práve nachádzal.
    const loopLength = Math.max(50, state.route.totalM - state.startM);
    state.routeTravelBaseM = state.rideM - (state.rideM % loopLength);
    state.routeFinished = false;
    state.lastEle = null;
  }

  state.workoutActive = false;
  state.workoutPaused = false;
  state.workoutSummaryName = name;
  state.workoutTargetPower = 0;
  state.workout = null;
  state.workoutPhaseIndex = 0;
  state.workoutPhaseElapsed = 0;
  state.workoutElapsed = 0;
  state.workoutLastBeepSecond = null;
  state.virtualSpeedMps = 0;
  state.trainerDistOffset = state.rideM;
  if (state.lastTotalM !== null) state.trainerBaseM = state.lastTotalM;

  if (trainer) {
    if (wasErg) sendErgTargetOnce(0);
    else sendSimulationOnce(0);
  }

  state.workoutErg = false;
  lastErgPower = null;
  lastErgSentAt = 0;

  renderWorkoutPanel();
  updateChartMarker(true);

  if (reason === 'complete') {
    showToast(`Tréning „${name}“ dokončený.`, 'success', 6000);
  } else {
    showToast(`Tréning „${name}“ ukončený.`, 'info', 4000);
  }

  openFinishModal();
}

/* ---------------------------- Hrudný pás ---------------------------- */
async function connectHeartRate() {
  if (heartRateSensor) {
    try { heartRateSensor.device.gatt.disconnect(); } catch (_) {}
    return;
  }
  if (!requireLogin('Tep')) return;
  if (state.connectingHr) return;

  if (!navigator.bluetooth) {
    showToast('Web Bluetooth nie je dostupné. Použi Windows a prehliadač Chrome alebo Edge.', 'error', 9000);
    return;
  }

  state.connectingHr = true;
  setHrUI('connecting');
  let device = null;

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID_HRS] }]
    });

    device.addEventListener('gattserverdisconnected', onHeartRateDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUID_HRS);
    const characteristic = await service.getCharacteristic(UUID_HRM);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', onHeartRateMeasurement);

    heartRateSensor = {
      device,
      server,
      characteristic,
      name: device.name || 'Hrudný pás'
    };

    setHrUI('connected');
    showToast(`Hrudný pás pripojený: ${heartRateSensor.name}`, 'success', 4200);
  } catch (error) {
    console.error('Hrudný pás:', error);
    if (device && device.gatt && device.gatt.connected) {
      try { device.gatt.disconnect(); } catch (_) {}
    }
    heartRateSensor = null;
    setHrUI('disconnected');
    showToast(`Hrudný pás sa nepodarilo pripojiť: ${bluetoothErrorText(error)}`, 'error', 8000);
  } finally {
    state.connectingHr = false;
    if (!heartRateSensor) setHrUI('disconnected');
  }
}

function onHeartRateDisconnected() {
  const wasConnected = Boolean(heartRateSensor);
  const name = heartRateSensor ? heartRateSensor.name : 'Hrudný pás';
  heartRateSensor = null;
  state.hr = null;
  state.lastHrAt = 0;
  setHrUI('disconnected');
  renderHUD();
  if (wasConnected) showToast(`${name} bol odpojený.`, 'info', 4200);
}

function onHeartRateMeasurement(event) {
  const dv = event.target.value;
  if (dv.byteLength < 2) return;

  try {
    const flags = dv.getUint8(0);
    const hr = (flags & 0x01) ? dv.getUint16(1, true) : dv.getUint8(1);
    if (Number.isFinite(hr) && hr > 0 && hr < 260) {
      state.hr = hr;
      state.lastHrAt = performance.now();
    } else {
      state.hr = null;
    }
  } catch (error) {
    console.warn('Neplatný HR packet:', error);
  }
}

/* =========================================================================
   FINISH / ŠTATISTIKA JAZDY
   ========================================================================= */
function recordNormalizedPower(power, dt) {
  if (!(dt > 0) || !Number.isFinite(power)) return;
  let remaining = dt;
  while (remaining > 1e-9) {
    const need = 1 - state.npBucketTime;
    const slice = Math.min(remaining, need);
    state.npBucketSum += power * slice;
    state.npBucketTime += slice;
    remaining -= slice;

    if (state.npBucketTime >= 1 - 1e-9) {
      const secPower = state.npBucketSum / state.npBucketTime;
      state.npBucketSum = 0;
      state.npBucketTime = 0;

      state.npWindow.push(secPower);
      if (state.npWindow.length > 30) state.npWindow.shift();
      if (state.npWindow.length === 30) {
        let sum30 = 0;
        for (let i = 0; i < 30; i++) sum30 += state.npWindow[i];
        const avg30 = sum30 / 30;
        state.npFourthSum += avg30 ** 4;
        state.npFourthCount++;
      }
    }
  }
}

function computeNormalizedPower(fallback) {
  if (state.npFourthCount > 0) {
    return Math.round((state.npFourthSum / state.npFourthCount) ** 0.25);
  }
  return Math.max(0, Math.round(fallback || 0));
}

function currentRideSummary() {
  const avgPowerW = state.powerTime > 0
    ? Math.round(state.powerSum / state.powerTime)
    : Math.max(0, Math.round(state.power || 0));

  let avgHr = null;
  if (state.hrMovingTime > 0) {
    avgHr = Math.round(state.hrMovingSum / state.hrMovingTime);
  } else if (state.hrAllTime > 0) {
    avgHr = Math.round(state.hrAllSum / state.hrAllTime);
  } else if (state.hr !== null && Number.isFinite(state.hr)) {
    avgHr = Math.round(state.hr);
  }

  const workoutName = state.workoutActive && state.workout
    ? state.workout.name
    : state.workoutSummaryName;
  const routeLabel = workoutName
    ? `${workoutName}${state.route ? ` · ${state.route.name}` : ''}`
    : (state.route
      ? (state.startM > 0.5
        ? `${state.route.name} · štart ${formatKm(state.startM / 1000, 2)} km`
        : state.route.name)
      : 'Voľná jazda bez GPX trasy');

  return {
    name: workoutName || (state.route ? state.route.name : 'Voľná jazda'),
    routeLabel,
    durationS: Math.round(state.rideSeconds),
    distanceM: Math.round(state.rideM),
    ascentM: Math.round(state.ascentM),
    calories: Math.round(state.energyKcal),
    avgPowerW,
    npW: computeNormalizedPower(avgPowerW),
    avgHr,
    weightKg: state.weight || 75
  };
}

function fillStatsView(summary) {
  const weight = Math.max(1, summary.weightKg || 75);
  const locked = !accountUser;
  el.statRouteName.textContent = summary.routeLabel;
  el.statTime.textContent = formatTime(summary.durationS || 0);
  el.statDist.textContent = formatKm((summary.distanceM || 0) / 1000, 2);
  el.statAscent.textContent = String(Math.round(summary.ascentM || 0));
  el.statAvgPower.textContent = String(Math.round(summary.avgPowerW || 0));
  setLockableValue(
    el.statAvgWkg,
    `${((summary.avgPowerW || 0) / weight).toFixed(2)} W/kg`,
    locked,
    '🔒 Po prihlásení',
    'W/kg je dostupné po prihlásení'
  );
  el.statNp.textContent = String(Math.round(summary.npW || 0));
  el.statCalories.textContent = String(Math.round(summary.calories || 0));
  const avgHrText = summary.avgHr === null || summary.avgHr === undefined ||
    !Number.isFinite(summary.avgHr)
    ? '--'
    : String(Math.round(summary.avgHr));
  setLockableValue(
    el.statAvgHr,
    avgHrText,
    locked,
    '🔒',
    'Priemerný tep je dostupný po prihlásení'
  );
}

/* =========================================================================
   EXPORT DO STRAVY (TCX)
   ========================================================================= */
const MAX_TCX_SAMPLES = 30000; // približne 8 hodín jazdy

function pushRideSample(sample) {
  const list = state.tcxSamples;
  if (list.length >= MAX_TCX_SAMPLES) return;

  const last = list.length > 0 ? list[list.length - 1] : null;
  const t = state.rideSeconds;
  if (last && t - last.t < 1) return;

  list.push({
    t,
    d: state.rideM,
    lat: sample && Number.isFinite(sample.lat) ? sample.lat : null,
    lon: sample && Number.isFinite(sample.lon) ? sample.lon : null,
    ele: sample && Number.isFinite(sample.ele) ? sample.ele : null,
    hr: state.hr !== null && Number.isFinite(state.hr) ? state.hr : null,
    p: Math.max(0, state.power || 0)
  });
}

function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[<>&'"]/g, (ch) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]
  ));
}

function buildTcx(summary) {
  const durationS = Math.max(1, Math.round(summary.durationS || 0));
  const startMs = Date.now() - durationS * 1000;
  const iso = (ms) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const samples = state.tcxSamples.slice();

  if (samples.length === 0) {
    const startSample = state.route ? sampleRoute(state.startM) : null;
    const endSample = state.route
      ? sampleRoute(routeProgressM())
      : null;
    samples.push({
      t: 0, d: 0,
      lat: startSample ? startSample.lat : null,
      lon: startSample ? startSample.lon : null,
      ele: startSample ? startSample.ele : null,
      hr: null, p: 0
    });
    samples.push({
      t: durationS, d: Math.max(0, summary.distanceM || 0),
      lat: endSample ? endSample.lat : null,
      lon: endSample ? endSample.lon : null,
      ele: endSample ? endSample.ele : null,
      hr: null, p: summary.avgPowerW || 0
    });
  } else {
    const last = samples[samples.length - 1];
    if (last.t < durationS - 1 || (summary.distanceM || 0) > last.d + 1) {
      const endSample = state.route
        ? sampleRoute(routeProgressM())
        : null;
      samples.push({
        t: Math.max(durationS, last.t + 1),
        d: Math.max(last.d, summary.distanceM || 0),
        lat: endSample ? endSample.lat : null,
        lon: endSample ? endSample.lon : null,
        ele: endSample ? endSample.ele : null,
        hr: last.hr, p: last.p
      });
    }
  }

  let maxDistance = 0;
  let maxHr = 0;
  let maxWatts = 0;
  let maxSpeed = 0;

  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    const dd = (samples[i].d || 0) - (samples[i - 1].d || 0);
    if (dt > 0 && dd > 0) maxSpeed = Math.max(maxSpeed, dd / dt);
  }

  const trackpoints = samples.map((s) => {
    maxDistance = Math.max(maxDistance, s.d || 0);
    if (Number.isFinite(s.hr)) maxHr = Math.max(maxHr, s.hr);
    if (Number.isFinite(s.p)) maxWatts = Math.max(maxWatts, s.p);

    let xml = `<Trackpoint><Time>${iso(startMs + s.t * 1000)}</Time>`;
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
      xml += `<Position><LatitudeDegrees>${s.lat.toFixed(6)}</LatitudeDegrees>`;
      xml += `<LongitudeDegrees>${s.lon.toFixed(6)}</LongitudeDegrees></Position>`;
    }
    if (Number.isFinite(s.ele)) xml += `<AltitudeMeters>${s.ele.toFixed(1)}</AltitudeMeters>`;
    xml += `<DistanceMeters>${Math.max(0, s.d || 0).toFixed(1)}</DistanceMeters>`;
    if (Number.isFinite(s.hr)) {
      xml += `<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>`;
    }
    xml += `<Extensions><ns3:TPX><ns3:Watts>${Math.round(s.p || 0)}</ns3:Watts></ns3:TPX></Extensions>`;
    xml += '</Trackpoint>';
    return xml;
  }).join('');

  const distanceM = Math.max(maxDistance, summary.distanceM || 0);
  const avgHr = Number.isFinite(summary.avgHr) ? Math.round(summary.avgHr) : null;
  const avgWatts = Math.round(summary.avgPowerW || 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd http://www.garmin.com/xmlschemas/ActivityExtension/v2 http://www.garmin.com/xmlschemas/ActivityExtensionv2.xsd">
  <Activities>
    <Activity Sport="Biking">
      <Id>${iso(startMs)}</Id>
      <Notes>${escapeXml(summary.routeLabel || 'Jazda')}</Notes>
      <Lap StartTime="${iso(startMs)}">
        <TotalTimeSeconds>${durationS}</TotalTimeSeconds>
        <DistanceMeters>${distanceM.toFixed(1)}</DistanceMeters>
        <MaximumSpeed>${maxSpeed.toFixed(2)}</MaximumSpeed>
        <Calories>${Math.max(0, Math.round(summary.calories || 0))}</Calories>
        ${avgHr === null ? '' : `<AverageHeartRateBpm><Value>${avgHr}</Value></AverageHeartRateBpm>`}
        ${maxHr > 0 ? `<MaximumHeartRateBpm><Value>${Math.round(maxHr)}</Value></MaximumHeartRateBpm>` : ''}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${trackpoints}</Track>
        <Extensions><ns3:LX><ns3:AvgWatts>${avgWatts}</ns3:AvgWatts><ns3:MaxWatts>${Math.round(maxWatts)}</ns3:MaxWatts></ns3:LX></Extensions>
      </Lap>
      <Creator xsi:type="Device_t">
        <Name>Virtualny cyklotrenazer</Name>
        <UnitId>0</UnitId>
        <ProductID>0</ProductID>
        <Version><VersionMajor>1</VersionMajor><VersionMinor>0</VersionMinor></Version>
      </Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

function stravaFileName(summary) {
  const base = String(summary.name || 'jazda')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'jazda';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${base}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.tcx`;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportToStrava() {
  const summary = currentRideSummary();
  if (summary.durationS < 1 && summary.distanceM < 1) {
    showToast('Najprv chvíľu jazdi, potom môžeš aktivitu exportovať.', 'warning', 4500);
    return;
  }

  try {
    const tcx = buildTcx(summary);
    downloadTextFile(stravaFileName(summary), tcx, 'application/vnd.garmin.tcx+xml');
    showToast(
      'TCX súbor je stiahnutý. V otvorenej Streve ho pridaj cez „Upload activity“.',
      'success',
      8000
    );
    window.open('https://www.strava.com/upload/select', '_blank', 'noopener');
  } catch (error) {
    console.error('Export do Stravy:', error);
    showToast('Export do Stravy zlyhal. Skús to znova.', 'error', 6000);
  }
}

function setFinishMode(mode) {
  const saved = mode === 'saved';
  el.finishBadgeText.textContent = saved ? 'Uložená jazda' : 'Jazda ukončená';
  el.btnResetRide.hidden = saved;
  el.btnResumeRide.hidden = saved;
  el.btnSaveActivity.hidden = saved;
  el.btnExportStrava.hidden = saved;
  el.btnActivityClose.hidden = !saved;
  el.btnActivityDelete.hidden = !saved;
  el.finishModal.classList.toggle('stack', saved);
}

function openFinishModal() {
  state.ridePaused = true;
  viewingActivityId = null;

  const summary = currentRideSummary();
  fillStatsView(summary);
  setFinishMode('live');

  const canSave = Boolean(supa && accountUser);
  const alreadySaved = state.lastSavedRideSeconds !== null &&
    summary.durationS <= state.lastSavedRideSeconds &&
    summary.distanceM <= state.lastSavedRideM;

  el.btnSaveActivity.disabled = !canSave || alreadySaved;
  el.btnSaveActivity.textContent = alreadySaved ? 'Uložené ✓' : 'Uložiť aktivitu';
  el.btnSaveActivity.title = !canSave
    ? 'Najprv sa prihlás v okne Konto'
    : (alreadySaved
      ? 'Táto jazda je už uložená (pokračuj v jazde pre nové uloženie)'
      : 'Uložiť túto jazdu do účtu');

  el.finishModal.classList.add('open');
  syncWakeLock();
}

function openActivityStats(id) {
  const item = savedActivities.find((activity) => activity.id === id);
  if (!item) return;

  viewingActivityId = id;
  fillStatsView({
    routeLabel: item.name || 'Jazda',
    durationS: item.duration_s || 0,
    distanceM: item.distance_m || 0,
    ascentM: item.ascent_m || 0,
    calories: item.calories || 0,
    avgPowerW: item.avg_power_w || 0,
    npW: item.np_w || 0,
    avgHr: item.avg_hr === null || item.avg_hr === undefined ? null : Number(item.avg_hr),
    weightKg: item.weight_kg || state.weight || 75
  });
  setFinishMode('saved');
  el.finishModal.classList.add('open');
  syncWakeLock();
}

function closeFinishModal() {
  el.finishModal.classList.remove('open');
  el.finishModal.classList.remove('stack');
  if (viewingActivityId) {
    viewingActivityId = null;
    return;
  }
  state.ridePaused = false;
  if (state.lastTotalM !== null) {
    state.trainerBaseM = state.lastTotalM;
    state.trainerDistOffset = state.rideM;
  }
  syncWakeLock();
}

function openHelpModal() {
  el.helpModal.classList.add('open');
  el.btnCloseHelp.focus({ preventScroll: true });
}

function closeHelpModal() {
  el.helpModal.classList.remove('open');
  el.btnHelp.focus({ preventScroll: true });
}

/* =========================================================================
   HUD, SLEDOVANIE TRASY A ŽIVÝ CYKLUS
   ========================================================================= */
let lastChartUpdateAt = 0;
let lastTickAt = performance.now();

/* Poloha na trase v metroch. Počas tréningu sa trasa opakuje dookola,
   po tréningu nadviaže voľná jazda od miesta, kde tréning skončil. */
function routeProgressM() {
  if (!state.route) return 0;
  const totalM = state.route.totalM;

  if (state.workoutActive) {
    const loopLength = Math.max(50, totalM - state.startM);
    return clamp(state.startM + (state.rideM % loopLength), 0, totalM);
  }

  return clamp(state.startM + state.rideM - state.routeTravelBaseM, 0, totalM);
}

function sampleRoute(distanceM) {
  if (!state.route) return null;
  const points = state.route.points;
  if (!points.length) return null;

  const d = clamp(distanceM, 0, state.route.totalM);

  if (d <= 0) {
    const p = points[0];
    return { lat: p.lat, lon: p.lon, ele: p.ele, grade: p.grade };
  }

  const last = points[points.length - 1];
  if (d >= state.route.totalM) {
    return { lat: last.lat, lon: last.lon, ele: last.ele, grade: last.grade };
  }

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist <= d) lo = mid;
    else hi = mid;
  }

  const a = points[lo];
  const b = points[hi];
  const span = b.dist - a.dist;
  const t = span > 0 ? clamp((d - a.dist) / span, 0, 1) : 0;

  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele: a.ele + (b.ele - a.ele) * t,
    grade: a.grade + (b.grade - a.grade) * t
  };
}

function updateGradeChip(grade) {
  if (el.gradeCell) {
    el.gradeCell.classList.toggle('is-mode', Boolean(state.workoutActive));
  }
  if (state.workoutActive) {
    const color = '#c6f432';
    el.gradeChip.textContent = (state.workoutErg && trainer) ? 'ERG' : 'Manuál';
    el.gradeChip.style.color = color;
    el.gradeChip.style.background = hexToRgba(color, 0.14);
    el.gradeChip.style.borderColor = hexToRgba(color, 0.36);
    el.gradeFill.style.left = '50%';
    el.gradeFill.style.width = '0%';
    el.gradeFill.style.background = color;
    return;
  }

  const value = Number.isFinite(grade) ? grade : 0;
  const color = gradeColor(value);

  el.gradeChip.textContent = formatGrade(value);
  el.gradeChip.style.color = color;
  el.gradeChip.style.background = hexToRgba(color, 0.14);
  el.gradeChip.style.borderColor = hexToRgba(color, 0.36);

  const ratio = clamp(value / GRADE_MAX, -1, 1);
  if (ratio >= 0) {
    el.gradeFill.style.left = '50%';
    el.gradeFill.style.width = `${ratio * 50}%`;
  } else {
    el.gradeFill.style.left = `${50 + ratio * 50}%`;
    el.gradeFill.style.width = `${-ratio * 50}%`;
  }
  el.gradeFill.style.background = color;
}

function renderHUD(now = performance.now()) {
  const bikeAlive = Boolean(trainer) && (now - state.lastBikeAt < 6000);
  const power = bikeAlive ? Math.max(0, Math.round(state.power)) : 0;
  const locked = !accountUser;

  const workoutPhase = state.workoutActive && state.workout
    ? state.workout.phases[state.workoutPhaseIndex]
    : null;
  if (workoutPhase) {
    const phaseLeft = Math.max(0, workoutPhase.duration - state.workoutPhaseElapsed);
    el.rideTime.textContent = formatTime(phaseLeft);
    el.timeKicker.textContent = 'Interval';
    const countdown = phaseLeft > 0 && phaseLeft <= 3;
    el.timeCell.classList.toggle('is-countdown', countdown);
  } else {
    el.rideTime.textContent = formatTime(state.rideSeconds);
    el.timeKicker.textContent = 'Čas jazdy';
    el.timeCell.classList.remove('is-countdown');
  }
  el.powerValue.textContent = String(power);
  const zone = powerZoneForWatts(power, state.ftp);
  if (el.powerCell) {
    if (zone) {
      el.powerCell.dataset.zone = String(zone.zone);
      const pct = Math.round((power / Math.max(50, state.ftp || 200)) * 100);
      el.powerCell.title = `${zone.label} · ${zone.name} (${pct} % FTP)`;
    } else {
      delete el.powerCell.dataset.zone;
      el.powerCell.removeAttribute('title');
    }
  }
  if (el.wkgCell) {
    if (zone && !locked) {
      el.wkgCell.dataset.zone = String(zone.zone);
    } else {
      delete el.wkgCell.dataset.zone;
    }
  }
  if (el.powerZoneBadge) {
    el.powerZoneBadge.hidden = !zone;
    if (zone) el.powerZoneBadge.textContent = zone.label;
  }
  setLockableValue(
    el.hrValue,
    state.hr !== null && Number.isFinite(state.hr) ? String(Math.round(state.hr)) : '0',
    locked,
    '🔒',
    'Tep je dostupný po prihlásení'
  );
  setLockableValue(
    el.wkgValue,
    (power / Math.max(1, state.weight)).toFixed(2),
    locked,
    '🔒',
    'W/kg je dostupné po prihlásení'
  );

  if (state.route) {
    const progressM = routeProgressM();
    const remainingKm = Math.max(0, (state.route.totalM - progressM) / 1000);
    el.remainValue.textContent = `${formatKm(remainingKm, remainingKm >= 10 ? 1 : 2)} km`;
  } else {
    el.remainValue.textContent = '--';
  }

  updateGradeChip(state.route ? state.currentGrade : 0);
}

function updateChartMarker(force = false) {
  if (!profileChart) return;
  const now = performance.now();
  if (!force && now - lastChartUpdateAt < 450) return;
  lastChartUpdateAt = now;
  profileChart.update('none');
}

function updateDebugPanel() {
  if (!state.route) {
    el.debugText.textContent = 'bez GPX trasy';
    return;
  }

  const clampedM = routeProgressM();
  const pct = state.route.totalM > 0 ? (clampedM / state.route.totalM) * 100 : 0;
  const sample = sampleRoute(clampedM);
  const cpText = lastCpResult === null
    ? '--'
    : (lastCpResult === -1
      ? 'bez odpovede'
      : lastCpResult >= 0
        ? `0x${lastCpResult.toString(16).toUpperCase().padStart(2, '0')}`
        : String(lastCpResult));
  const cpAge = lastCpAt > 0 ? `${((performance.now() - lastCpAt) / 1000).toFixed(1)} s` : '--';

  el.debugText.textContent = [
    `GPX   ${(state.route.totalM / 1000).toFixed(2)} km · ${state.route.points.length} b · +${Math.round(state.route.ascentM)} m`,
    `POS   ${(clampedM / 1000).toFixed(3)} km (${pct.toFixed(1)} %) · prejdené ${(state.rideM / 1000).toFixed(3)} km · štart ${(state.startM / 1000).toFixed(3)} km`,
    `SKLON trasa ${formatGrade(sample ? sample.grade : 0)} · filter ${formatGrade(state.currentGrade)}`,
    `CP    0x11 → ${cpText} (${cpAge})`,
    `DIST  ${state.lastTotalDistance === null ? '--' : state.lastTotalDistance} m · Δ ${Math.round(state.lastTotalDelta)} m · ${state.workoutActive ? `fyzika ${(state.virtualSpeedMps * 3.6).toFixed(1)} km/h` : (state.hasTotalDistance ? 'total' : 'speed')}`,
    `BIKE  ${state.speed.toFixed(1)} km/h · ${Math.round(state.power)} W · ${Math.round(state.cadence)} rpm · HR ${state.hr === null ? '--' : Math.round(state.hr)}`
  ].join('\n');
}

function tick(now) {
  const dt = clamp((now - lastTickAt) / 1000, 0, 1.5);
  lastTickAt = now;

  if (heartRateSensor && state.lastHrAt > 0 && now - state.lastHrAt > 15000) {
    state.hr = null;
  }

  if (state.ridePaused) {
    renderHUD(now);
    renderWorkoutPanel(now);
    return;
  }

  const bikeAlive = Boolean(trainer) && (now - state.lastBikeAt < 6000);
  const speed = bikeAlive ? Math.max(0, state.speed) : 0;
  const power = bikeAlive ? Math.max(0, state.power) : 0;
  const moving = bikeAlive && (speed > 0.8 || power > 10);

  if (state.hr !== null && Number.isFinite(state.hr) && state.hr > 0) {
    state.hrAllSum += state.hr * dt;
    state.hrAllTime += dt;
  }

  const totalFresh = bikeAlive && state.hasTotalDistance &&
    (now - state.lastDistChangeAt < 2500);
  const integrateSpeed = moving && (!state.hasTotalDistance || !totalFresh);

  if (moving) {
    state.rideSeconds += dt;
    state.powerSum += power * dt;
    state.powerTime += dt;
    state.powerSamples.push(power);
    if (state.powerSamples.length > 12) state.powerSamples.shift();
    recordNormalizedPower(power, dt);

    // Mechanická práca v kJ / (efektivita bicyklovania × kJ na kcal).
    // Pri efektivite 24 % vychádza približne 1 kJ ≈ 1 kcal.
    const mechanicalKj = (power * dt) / 1000;
    state.energyKcal += mechanicalKj / (CYCLING_EFFICIENCY * KJ_PER_KCAL);

    if (state.hr !== null && Number.isFinite(state.hr) && state.hr > 0) {
      state.hrMovingSum += state.hr * dt;
      state.hrMovingTime += dt;
    }
  }
  if (state.workoutActive) {
    if (moving) {
      const routeSample = state.route ? sampleRoute(routeProgressM()) : null;
      const routeGrade = routeSample ? routeSample.grade : 0;
      const targetV = solveCyclingSpeedMps(power, routeGrade, state.weight);
      if (state.virtualSpeedMps <= 0.05) {
        state.virtualSpeedMps = targetV;
      } else {
        const vAlpha = 1 - Math.exp(-dt / VIRTUAL_SPEED_TAU_S);
        state.virtualSpeedMps += (targetV - state.virtualSpeedMps) * vAlpha;
      }
      state.rideM += state.virtualSpeedMps * dt;
    } else {
      state.virtualSpeedMps = 0;
    }
  } else if (integrateSpeed) {
    state.distanceFallback = state.hasTotalDistance;
    state.rideM += (speed / 3.6) * dt;
  }

  if (state.workoutActive) {
    if (moving && !advanceWorkout(dt)) {
      renderHUD(now);
      renderWorkoutPanel(now);
      return;
    }
  }

  if (state.route) {
    let progressM;

    if (state.workoutActive) {
      const loopLength = Math.max(50, state.route.totalM - state.startM);
      const loopIndex = Math.floor(state.rideM / loopLength);
      if (loopIndex !== state.workoutLoopIndex) {
        state.workoutLoopIndex = loopIndex;
        state.lastEle = null;
        if (loopIndex === 1) {
          showToast('Trasa sa opakuje, kým tréning neskončí.', 'info', 4200);
        }
      }
    }

    progressM = routeProgressM();

    if (!state.workoutActive && !state.routeFinished && progressM >= state.route.totalM - 0.5) {
      state.routeFinished = true;
      showToast('Cieľ trasy dosiahnutý!', 'success', 5500);
      openFinishModal();
    }

    const sample = sampleRoute(progressM);
    state.profileKm = progressM / 1000;

    if (sample && Number.isFinite(sample.ele)) {
      if (state.lastEle !== null) {
        const dEle = sample.ele - state.lastEle;
        if (dEle > 0) state.ascentM += dEle;
      }
      state.lastEle = sample.ele;
    }

    const target = clamp(
      state.workoutActive ? 0 : (state.routeFinished ? 0 : (sample ? sample.grade : 0)),
      GRADE_MIN,
      GRADE_MAX
    );
    state.targetGrade = target;

    if (!Number.isFinite(state.currentGrade)) {
      state.currentGrade = target;
    } else {
      const alpha = 1 - Math.exp(-dt / GRADE_FILTER_TAU_S);
      const desired = state.currentGrade + (target - state.currentGrade) * alpha;
      const maxStep = GRADE_MAX_RATE * dt;
      state.currentGrade = clamp(
        state.currentGrade + clamp(desired - state.currentGrade, -maxStep, maxStep),
        GRADE_MIN,
        GRADE_MAX
      );
    }

    if (sample) updateMapPosition(sample);
    if (moving) pushRideSample(sample);

    if (state.workoutActive) {
      if (state.workoutErg) queueTargetPower();
    } else {
      queueSimulation();
    }
    updateChartMarker();
  } else {
    state.currentGrade = 0;
    state.targetGrade = 0;
    if (moving) pushRideSample(null);
  }

  renderHUD(now);
  renderWorkoutPanel(now);
  if (!el.debugPanel.hidden) updateDebugPanel();
}

/* =========================================================================
   PROFIL JAZDCA (HMOTNOSŤ, FTP) A OVLÁDANIE
   ========================================================================= */
function saveProfileWeightInput() {
  if (!el.profileWeight) return;
  const value = normalizeRiderWeight(String(el.profileWeight.value).replace(',', '.'));
  if (value === null) {
    el.profileWeight.value = String(state.weight);
    showToast('Zadaj hmotnosť v rozsahu 30 – 250 kg.', 'error', 4200);
    return;
  }
  if (value === state.weight) {
    syncProfileInputs();
    return;
  }

  const now = Date.now();
  state.weight = value;
  storeRiderWeightLocally(value, now);
  syncProfileInputs();
  renderHUD();
  showToast(`Hmotnosť jazdca: ${value} kg`, 'info', 2200);
  if (supa && accountUser) saveRiderWeightToAccount(value, now);
}

function saveProfileFtpInput() {
  if (!el.profileFtp) return;
  const prev = state.ftp;
  if (!setFtp(el.profileFtp.value)) {
    el.profileFtp.value = String(state.ftp);
    showToast('FTP musí byť v rozsahu 50 – 600 W.', 'warning', 4000);
    return;
  }
  if (state.ftp !== prev) {
    showToast(`FTP nastavené na ${state.ftp} W`, 'info', 2200);
  }
  if (el.workoutModal && el.workoutModal.classList.contains('open')) {
    renderWorkoutPreview();
  }
  renderWorkoutPanel();
}

el.btnTrainer.addEventListener('click', connectTrainer);
el.btnHr.addEventListener('click', connectHeartRate);

el.btnGpx.addEventListener('click', openGpxPicker);
el.btnLoadGpxEmpty.addEventListener('click', openGpxPicker);
el.btnLoadDemoGpx.addEventListener('click', loadDemoRoute);

el.hrValue.addEventListener('click', () => { if (!accountUser) requireLogin('Tep'); });
el.wkgValue.addEventListener('click', () => { if (!accountUser) requireLogin('W/kg'); });
el.statAvgWkg.addEventListener('click', () => { if (!accountUser) requireLogin('W/kg'); });
el.statAvgHr.addEventListener('click', () => { if (!accountUser) requireLogin('Priemerný tep'); });

el.gpxInput.addEventListener('change', () => {
  const file = el.gpxInput.files && el.gpxInput.files[0];
  if (file) loadGPXFile(file);
});

if (el.profileWeight) el.profileWeight.addEventListener('change', saveProfileWeightInput);
if (el.profileFtp) el.profileFtp.addEventListener('change', saveProfileFtpInput);
el.btnFinish.addEventListener('click', () => {
  if (state.workoutActive) finishWorkout('manual');
  else openFinishModal();
});
el.btnCloseModal.addEventListener('click', closeFinishModal);
el.btnResumeRide.addEventListener('click', closeFinishModal);
el.btnSaveActivity.addEventListener('click', saveCurrentActivity);
el.btnExportStrava.addEventListener('click', exportToStrava);
el.btnActivityClose.addEventListener('click', closeFinishModal);
el.btnActivityDelete.addEventListener('click', () => {
  if (viewingActivityId) deleteSavedActivity(viewingActivityId);
});
el.btnResetRide.addEventListener('click', () => {
  resetRideStats();
  closeFinishModal();
  showToast('Štatistiky jazdy boli vynulované.', 'info', 3000);
});
function bindBackdropClose(modal, onClose) {
  if (!modal) return;
  let startedOnBackdrop = false;
  modal.addEventListener('pointerdown', (event) => {
    startedOnBackdrop = event.target === modal;
  });
  modal.addEventListener('click', (event) => {
    if (startedOnBackdrop && event.target === modal) onClose();
    startedOnBackdrop = false;
  });
}

bindBackdropClose(el.finishModal, closeFinishModal);

el.btnHelp.addEventListener('click', openHelpModal);
el.btnCloseHelp.addEventListener('click', closeHelpModal);
el.btnCloseHelpAction.addEventListener('click', closeHelpModal);
bindBackdropClose(el.helpModal, closeHelpModal);

el.btnAccount.addEventListener('click', openAccountModal);
el.btnCloseAccount.addEventListener('click', closeAccountModal);
el.btnCloseAccountAction.addEventListener('click', closeAccountModal);
bindBackdropClose(el.accountModal, closeAccountModal);
el.btnGoogleLogin.addEventListener('click', signInWithGoogle);
el.btnSignOut.addEventListener('click', signOutAccount);
el.btnSaveRoute.addEventListener('click', saveCurrentRoute);

el.btnRoutes.addEventListener('click', openRoutesModal);
el.btnCloseRoutes.addEventListener('click', closeRoutesModal);
el.btnCloseRoutesAction.addEventListener('click', closeRoutesModal);
bindBackdropClose(el.routesModal, closeRoutesModal);

el.btnActivities.addEventListener('click', openActivitiesModal);
el.btnCloseActivities.addEventListener('click', closeActivitiesModal);
el.btnCloseActivitiesAction.addEventListener('click', closeActivitiesModal);
bindBackdropClose(el.activitiesModal, closeActivitiesModal);

el.btnWorkout.addEventListener('click', openWorkoutModal);
el.btnCloseWorkout.addEventListener('click', closeWorkoutModal);
el.btnCloseWorkoutAction.addEventListener('click', closeWorkoutModal);
bindBackdropClose(el.workoutModal, closeWorkoutModal);
el.workoutFtp.addEventListener('change', () => {
  if (!setFtp(el.workoutFtp.value)) {
    el.workoutFtp.value = String(state.ftp);
    showToast('FTP musí byť v rozsahu 50 – 600 W.', 'warning', 4000);
  }
  renderWorkoutPreview();
});
el.workoutFtp.addEventListener('input', renderWorkoutPreview);
if (el.btnFtpMinus) el.btnFtpMinus.addEventListener('click', () => stepWorkoutFtp(-5));
if (el.btnFtpPlus) el.btnFtpPlus.addEventListener('click', () => stepWorkoutFtp(5));
if (el.btnWorkoutErg) {
  el.btnWorkoutErg.addEventListener('click', () => {
    state.workoutErgPreferred = true;
    updateWorkoutModalState();
  });
}
if (el.btnWorkoutManual) {
  el.btnWorkoutManual.addEventListener('click', () => {
    state.workoutErgPreferred = false;
    updateWorkoutModalState();
  });
}
if (el.workoutRouteSelect) {
  el.workoutRouteSelect.addEventListener('change', async () => {
    const val = el.workoutRouteSelect.value;
    if (val === '__demo__') {
      await loadDemoRoute({ silent: true });
      refreshWorkoutRouteNote();
    } else if (val.startsWith('saved:')) {
      await loadSavedRoute(val.slice(6));
      refreshWorkoutRouteNote();
    }
  });
}
el.btnStartWorkout.addEventListener('click', startWorkout);
el.wpSkip.addEventListener('click', skipWorkoutPhase);
el.wpStop.addEventListener('click', () => finishWorkout('manual'));
el.wpRouteLoad.addEventListener('click', openGpxPicker);

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  dragDepth++;
});
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer) return;
  dragDepth = Math.max(0, dragDepth - 1);
});
window.addEventListener('drop', (event) => {
  if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
  event.preventDefault();
  dragDepth = 0;
  const file = event.dataTransfer.files[0];
  if (!/\.gpx$/i.test(file.name)) {
    showToast('Pretiahni prosím súbor s príponou .gpx.', 'warning', 4500);
    return;
  }
  loadGPXFile(file);
});

window.addEventListener('resize', () => {
  map.resize();
});

let wakeLockSentinel = null;
let wakeLockPending = false;

function shouldKeepScreenAwake() {
  return !state.ridePaused && (Boolean(trainer) || state.workoutActive);
}

async function syncWakeLock() {
  if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
  const want = shouldKeepScreenAwake() && document.visibilityState === 'visible';
  if (want) {
    if (wakeLockSentinel || wakeLockPending) return;
    wakeLockPending = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
      });
    } catch (_) {
    } finally {
      wakeLockPending = false;
    }
  } else if (wakeLockSentinel) {
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    try { await sentinel.release(); } catch (_) {}
  }
}

document.addEventListener('visibilitychange', () => {
  syncWakeLock();
});

window.addEventListener('beforeunload', () => {
  try { if (wakeLockSentinel) wakeLockSentinel.release(); } catch (_) {}
  try { if (trainer) trainer.device.gatt.disconnect(); } catch (_) {}
  try { if (heartRateSensor) heartRateSensor.device.gatt.disconnect(); } catch (_) {}
});

/* =========================================================================
   ŠTART
   ========================================================================= */
if (new URLSearchParams(location.search).has('debug')) {
  el.debugPanel.hidden = false;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'F2') {
    event.preventDefault();
    el.debugPanel.hidden = !el.debugPanel.hidden;
    if (!el.debugPanel.hidden) updateDebugPanel();
  } else if (event.key === 'Escape') {
    if (el.helpModal.classList.contains('open')) closeHelpModal();
    else if (el.finishModal.classList.contains('open')) closeFinishModal();
    else if (el.routesModal.classList.contains('open')) closeRoutesModal();
    else if (el.activitiesModal.classList.contains('open')) closeActivitiesModal();
    else if (el.accountModal.classList.contains('open')) closeAccountModal();
    else if (el.workoutModal.classList.contains('open')) closeWorkoutModal();
  }
});

setTrainerUI('disconnected');
setHrUI('disconnected');
syncProfileInputs();
renderHUD();
updateGradeChip(0);
updateAuthLocks();
initAccount();

// Pri načítaní stránky sa hneď nahrá ukážková trasa (mapa je 3D / satelitná / Smer).
loadDemoRoute({ silent: true });
setTimeout(() => {
  map.resize();
  if (!state.route) fitSlovakiaOnMap();
}, 120);

setInterval(() => tick(performance.now()), 250);
