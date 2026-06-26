import { useEffect, useMemo, useState } from "react";
import Map, { type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer, IconLayer, TextLayer } from "@deck.gl/layers";
import * as satellite from "satellite.js";
import { useRef } from "react";
import type { DeckGLRef } from "@deck.gl/react"
import Earth3DView from "./Earth3DView";
import "./App.css";

type TleSatellite = {
  name: string;
  line1: string;
  line2: string;
  satrec: satellite.SatRec;
};

type SatellitePosition = {
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
};

type AdditionalSatellitePosition = SatellitePosition & {
  groupId: string;
};

type SatellitePath = {
  name: string;
  path: [number, number][][];
  fullPath: [number, number][];
};

type OrbitPathSegment = {
  path: [number, number][];
  progress: number;
};

type PositionFrame<T extends SatellitePosition = SatellitePosition> = {
  time: number;
  positions: T[];
};

type CrosshairSegment = {
  path: [number, number][];
};

type WorldSatellitePosition = {
  satellite: SatellitePosition;
  longitudeOffset: number;
  name: string;
};

type WorldAdditionalSatellitePosition = {
  satellite: AdditionalSatellitePosition;
  longitudeOffset: number;
  name: string;
};

type WorldStationLabel = WorldSatellitePosition & {
  labelIndex: number;
  labelCount: number;
};

type WorldOrbitPathSegment = {
  segment: OrbitPathSegment;
  longitudeOffset: number;
};

type WorldCrosshairSegment = {
  segment: CrosshairSegment;
  longitudeOffset: number;
};

type DisplayMode = "2d" | "3d";

const CACHE_EXPIRE_MS = 2 * 60 * 60 * 1000;
const WORLD_COPY_LONGITUDE_OFFSETS = [-720, -360, 0, 360, 720];
const STATION_ICON_URL = `${import.meta.env.BASE_URL}station-icon.png`;

const STARLINK_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STARLINK&FORMAT=tle";
const STATION_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=tle";

const ADDITIONAL_SATELLITE_GROUPS = [
  {
    id: "gnss",
    label: "GNSS",
    celestrakGroup: "GNSS",
    color: [80, 255, 160, 230] as [number, number, number, number],
  },
  {
    id: "oneweb",
    label: "ONEWEB",
    celestrakGroup: "ONEWEB",
    color: [255, 120, 210, 220] as [number, number, number, number],
  },
  {
    id: "weather",
    label: "WEATHER",
    celestrakGroup: "WEATHER",
    color: [255, 170, 60, 230] as [number, number, number, number],
  },
];

const STARLINK_ANIMATION_FPS = 30;
const STATION_ANIMATION_FPS = 60;
const ADDITIONAL_ANIMATION_FPS = 30;
const STARLINK_ANIMATION_FRAME_MS = 1000 / STARLINK_ANIMATION_FPS;
const STATION_ANIMATION_FRAME_MS = 1000 / STATION_ANIMATION_FPS;
const ADDITIONAL_ANIMATION_FRAME_MS = 1000 / ADDITIONAL_ANIMATION_FPS;
const STARLINK_VIEW_PADDING_LONGITUDE = 20;
const STARLINK_VIEW_PADDING_LATITUDE = 10;
const ORBIT_PREDICTION_MINUTES = [0, 15, 30, 45, 60, 75, 90];

async function fetchTleWithCache(url: string, cacheKey: string): Promise<string | null> {
  const timestampKey = `${cacheKey}_timestamp`;

  const cachedText = localStorage.getItem(cacheKey);
  const cachedTimestamp = localStorage.getItem(timestampKey);

  if (cachedText && cachedTimestamp) {
    const age = Date.now() - Number(cachedTimestamp);

    if (age < CACHE_EXPIRE_MS) {
      console.log(`${cacheKey} キャッシュ使用 (${Math.floor(age / 60000)}分経過)`);
      return cachedText;
    }
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();

    localStorage.setItem(cacheKey, text);
    localStorage.setItem(timestampKey, String(Date.now()));
    console.log(`${cacheKey} 更新取得`);
    return text;
  } catch (error) {
    console.error(error);

    if (cachedText) {
      console.warn(`${cacheKey} 期限切れキャッシュ利用`);
      return cachedText;
    }

    return null;
  }
}

function parseTleText(text: string): TleSatellite[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const satellites: TleSatellite[] = [];

  for (let i = 0; i < lines.length; i += 3) {
    if (!lines[i] || !lines[i + 1] || !lines[i + 2]) continue;
    if (!lines[i + 1].startsWith("1 ")) continue;
    if (!lines[i + 2].startsWith("2 ")) continue;

    satellites.push({
      name: lines[i],
      line1: lines[i + 1],
      line2: lines[i + 2],
      satrec: satellite.twoline2satrec(lines[i + 1], lines[i + 2]),
    });
  }
  return satellites;
}

function calculatePosition(tle: TleSatellite): SatellitePosition | null {
  const now = new Date();
  const pv = satellite.propagate(tle.satrec, now);

  if (!pv || !pv.position) return null;

  const gmst = satellite.gstime(now);
  const geo = satellite.eciToGeodetic(pv.position, gmst);

  const latitude = satellite.degreesLat(geo.latitude);
  const longitude = satellite.degreesLong(geo.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    name: tle.name,
    latitude,
    longitude,
    altitude: geo.height,
  };
}

function calculatePositionAt(tle: TleSatellite, date: Date): SatellitePosition | null {
  const pv = satellite.propagate(tle.satrec, date);

  if (!pv || !pv.position) return null;

  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);

  return {
    name: tle.name,
    latitude: satellite.degreesLat(geo.latitude),
    longitude: satellite.degreesLong(geo.longitude),
    altitude: geo.height,
  };
}

function splitPathByDateLine(path: [number, number][]): [number, number][][] {
  const paths: [number, number][][] = [];
  let current: [number, number][] = [];

  for (const point of path) {
    if (current.length === 0) {
      current.push(point);
      continue;
    }

    const prev = current[current.length - 1];

    if (Math.abs(point[1] - prev[1]) > 180) {
      paths.push(current);
      current = [point];
    } else {
      current.push(point);
    }
  }

  if (current.length > 0) {
    paths.push(current);
  }

  return paths;
}

function normalizeLongitude(lon: number): number {
  if (lon > 180) return lon - 360;
  if (lon < -180) return lon + 360;
  return lon;
}

function shortestLongitudeDelta(from: number, to: number): number {
  let delta = to - from;

  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;

  return delta;
}

function interpolateLongitude(from: number, to: number, t: number): number {
  return normalizeLongitude(from + shortestLongitudeDelta(from, to) * t);
}

function getWorldSatellitePosition(d: WorldSatellitePosition): [number, number] {
  return [
    d.satellite.longitude + d.longitudeOffset,
    d.satellite.latitude,
  ];
}

function stationLabelDistance(a: SatellitePosition, b: SatellitePosition): number {
  const latDelta = a.latitude - b.latitude;
  const lonDelta =
    shortestLongitudeDelta(a.longitude, b.longitude) *
    Math.cos(((a.latitude + b.latitude) / 2) * Math.PI / 180);

  return Math.sqrt(latDelta * latDelta + lonDelta * lonDelta);
}

function getPickedSatelliteName(object: unknown): string | null {
  if (!object || typeof object !== "object") return null;

  const picked = object as {
    name?: unknown;
    satellite?: { name?: unknown };
  };

  if (typeof picked.satellite?.name === "string") return picked.satellite.name;
  if (typeof picked.name === "string") return picked.name;
  return null;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCoordinate(value: number, axis: "latitude" | "longitude"): string {
  const direction =
    axis === "latitude"
      ? value >= 0 ? "N" : "S"
      : value >= 0 ? "E" : "W";

  return `${Math.abs(value).toFixed(2)}° ${direction}`;
}

function formatUtcDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function App() {
  const [starlinkTles, setStarlinkTles] = useState<TleSatellite[]>([]);
  const [stationTles, setStationTles] = useState<TleSatellite[]>([]);
  const [additionalTles, setAdditionalTles] = useState<Record<string, TleSatellite[]>>({});
  const [starlinkPositions, setStarlinkPositions] = useState<SatellitePosition[]>([]);
  const [stationPositions, setStationPositions] = useState<SatellitePosition[]>([]);
  const [additionalPositions, setAdditionalPositions] = useState<AdditionalSatellitePosition[]>([]);
  const [selectedSatelliteName, setSelectedSatelliteName] = useState<string | null>(null);
  const [followSatelliteName, setFollowSatelliteName] = useState<string | null>(null);
  const [viewState, setViewState] = useState({
    longitude: 139.7671,
    latitude: 35.6812,
    zoom: 3,
    pitch: 0,
    bearing: 0,
  });
  const [satellitePaths, setSatellitePaths] = useState<SatellitePath[]>([]);
  const [pulse, setPulse] = useState(0);
  const [starlinkRenderTick, setStarlinkRenderTick] = useState(0);
  const [stationRenderTick, setStationRenderTick] = useState(0);
  const [additionalRenderTick, setAdditionalRenderTick] = useState(0);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("2d");
  const [clockNow, setClockNow] = useState(() => new Date());
  const [earthRotationEnabled, setEarthRotationEnabled] = useState(false);
  const [showStarlink, setShowStarlink] = useState(true);
  const [showStations, setShowStations] = useState(true);
  const [showAdditionalGroups, setShowAdditionalGroups] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        ADDITIONAL_SATELLITE_GROUPS.map((group) => [group.id, true])
      )
  );

  const selectedSatellite =
    (showStations ? stationPositions.find((sat) => sat.name === selectedSatelliteName) : null) ??
    (showStarlink ? starlinkPositions.find((sat) => sat.name === selectedSatelliteName) : null) ??
    additionalPositions.find(
      (sat) => showAdditionalGroups[sat.groupId] && sat.name === selectedSatelliteName
    ) ??
    null;
  const followSatellite =
    (showStations ? stationPositions.find((sat) => sat.name === followSatelliteName) : null) ??
    (showStarlink ? starlinkPositions.find((sat) => sat.name === followSatelliteName) : null) ??
    additionalPositions.find(
      (sat) => showAdditionalGroups[sat.groupId] && sat.name === followSatelliteName
    ) ??
    null;
  const threeDPositionVersion =
    starlinkRenderTick + stationRenderTick + additionalRenderTick;
  const mapRef = useRef<MapRef>(null);
  const deckRef = useRef<DeckGLRef>(null);
  const starlinkPrevFrameRef = useRef<PositionFrame | null>(null);
  const starlinkNextFrameRef = useRef<PositionFrame | null>(null);
  const starlinkInterpolatedPositionsRef = useRef<SatellitePosition[]>([]);
  const stationPrevFrameRef = useRef<PositionFrame | null>(null);
  const stationNextFrameRef = useRef<PositionFrame | null>(null);
  const stationInterpolatedPositionsRef = useRef<SatellitePosition[]>([]);
  const additionalPrevFrameRef = useRef<PositionFrame<AdditionalSatellitePosition> | null>(null);
  const additionalNextFrameRef = useRef<PositionFrame<AdditionalSatellitePosition> | null>(null);
  const additionalInterpolatedPositionsRef = useRef<AdditionalSatellitePosition[]>([]);

  useEffect(() => {
    const load = async () => {
      const starlinkText = await fetchTleWithCache(
        STARLINK_TLE_URL,
        "celestrak_starlink_tle"
      );
      if (starlinkText) setStarlinkTles(parseTleText(starlinkText));

      const stationText = await fetchTleWithCache(
        STATION_TLE_URL,
        "celestrak_stations_tle"
      );
      if (stationText) setStationTles(parseTleText(stationText));

      const additionalEntries = await Promise.all(
        ADDITIONAL_SATELLITE_GROUPS.map(async (group) => {
          const text = await fetchTleWithCache(
            `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group.celestrakGroup}&FORMAT=tle`,
            `celestrak_${group.id}_tle`
          );

          return [group.id, text ? parseTleText(text) : []] as const;
        })
      );

      setAdditionalTles(Object.fromEntries(additionalEntries));
    };

    load();
  }, []);

  useEffect(() => {
    const timerId = setInterval(() => setClockNow(new Date()), 1000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (
      (!showStations && stationPositions.some((sat) => sat.name === selectedSatelliteName)) ||
      (!showStarlink && starlinkPositions.some((sat) => sat.name === selectedSatelliteName)) ||
      additionalPositions.some(
        (sat) => !showAdditionalGroups[sat.groupId] && sat.name === selectedSatelliteName
      )
    ) {
      setSelectedSatelliteName(null);
    }

    if (
      (!showStations && stationPositions.some((sat) => sat.name === followSatelliteName)) ||
      (!showStarlink && starlinkPositions.some((sat) => sat.name === followSatelliteName)) ||
      additionalPositions.some(
        (sat) => !showAdditionalGroups[sat.groupId] && sat.name === followSatelliteName
      )
    ) {
      setFollowSatelliteName(null);
    }
  }, [
    showStations,
    showStarlink,
    showAdditionalGroups,
    selectedSatelliteName,
    followSatelliteName,
    stationPositions,
    starlinkPositions,
    additionalPositions,
  ]);

  useEffect(() => {
    if (starlinkTles.length === 0) return;

    const update = () => {
      const next = starlinkTles
        .map(calculatePosition)
        .filter((p): p is SatellitePosition => p !== null);

      starlinkPrevFrameRef.current = starlinkNextFrameRef.current;
      starlinkNextFrameRef.current = {
        time: Date.now(),
        positions: next,
      };

      if (!starlinkPrevFrameRef.current) {
        setStarlinkPositions(next);
      }
    };

    update();

    const timerId = setInterval(update, 1000);
    return () => clearInterval(timerId);
  }, [starlinkTles]);

  useEffect(() => {
    if (stationTles.length === 0) return;

    const update = () => {
      const next = stationTles
        .map(calculatePosition)
        .filter((p): p is SatellitePosition => p !== null);

      stationPrevFrameRef.current = stationNextFrameRef.current;
      stationNextFrameRef.current = {
        time: Date.now(),
        positions: next,
      };

      if (!stationPrevFrameRef.current) {
        setStationPositions(next);
      }
    };

    update();

    const timerId = setInterval(update, 1000);
    return () => clearInterval(timerId);
  }, [stationTles]);

  useEffect(() => {
    const hasAdditionalTles = Object.values(additionalTles).some(
      (tles) => tles.length > 0
    );
    if (!hasAdditionalTles) return;

    const update = () => {
      const next = ADDITIONAL_SATELLITE_GROUPS.flatMap((group) =>
        (additionalTles[group.id] ?? [])
          .map(calculatePosition)
          .filter((p): p is SatellitePosition => p !== null)
          .map((position) => ({
            ...position,
            groupId: group.id,
          }))
      );

      additionalPrevFrameRef.current = additionalNextFrameRef.current;
      additionalNextFrameRef.current = {
        time: Date.now(),
        positions: next,
      };

      if (!additionalPrevFrameRef.current) {
        setAdditionalPositions(next);
      }
    };

    update();

    const timerId = setInterval(update, 1000);
    return () => clearInterval(timerId);
  }, [additionalTles]);

  useEffect(() => {
    let animationId = 0;
    let lastRenderTime = 0;

    const animate = (time: number) => {
      const prevFrame = starlinkPrevFrameRef.current;
      const nextFrame = starlinkNextFrameRef.current;

      if (prevFrame && nextFrame && time - lastRenderTime >= STARLINK_ANIMATION_FRAME_MS) {
        lastRenderTime = time;

        const elapsed = Date.now() - nextFrame.time;
        const t = Math.min(elapsed / 1000, 1);

        const buffer = starlinkInterpolatedPositionsRef.current;
        buffer.length = nextFrame.positions.length;

        for (let index = 0; index < nextFrame.positions.length; index += 1) {
          const next = nextFrame.positions[index];
          const prev = prevFrame.positions[index];

          const current = buffer[index] ?? {
            name: next.name,
            latitude: next.latitude,
            longitude: next.longitude,
            altitude: next.altitude,
          };

          if (!prev || prev.name !== next.name) {
            current.name = next.name;
            current.latitude = next.latitude;
            current.longitude = next.longitude;
            current.altitude = next.altitude;
          } else {
            current.name = next.name;
            current.latitude = prev.latitude + (next.latitude - prev.latitude) * t;
            current.longitude = interpolateLongitude(prev.longitude, next.longitude, t);
            current.altitude = prev.altitude + (next.altitude - prev.altitude) * t;
          }

          buffer[index] = current;
        }

        setStarlinkPositions(buffer);
        setStarlinkRenderTick((tick) => tick + 1);
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    let animationId = 0;
    let lastRenderTime = 0;

    const animate = (time: number) => {
      const prevFrame = stationPrevFrameRef.current;
      const nextFrame = stationNextFrameRef.current;

      if (prevFrame && nextFrame && time - lastRenderTime >= STATION_ANIMATION_FRAME_MS) {
        lastRenderTime = time;

        const elapsed = Date.now() - nextFrame.time;
        const t = Math.min(elapsed / 1000, 1);
        const buffer = stationInterpolatedPositionsRef.current;

        buffer.length = nextFrame.positions.length;

        for (let index = 0; index < nextFrame.positions.length; index += 1) {
          const next = nextFrame.positions[index];
          const prev = prevFrame.positions[index];

          const current = buffer[index] ?? {
            name: next.name,
            latitude: next.latitude,
            longitude: next.longitude,
            altitude: next.altitude,
          };

          if (!prev || prev.name !== next.name) {
            current.name = next.name;
            current.latitude = next.latitude;
            current.longitude = next.longitude;
            current.altitude = next.altitude;
          } else {
            current.name = next.name;
            current.latitude = prev.latitude + (next.latitude - prev.latitude) * t;
            current.longitude = interpolateLongitude(prev.longitude, next.longitude, t);
            current.altitude = prev.altitude + (next.altitude - prev.altitude) * t;
          }

          buffer[index] = current;
        }

        setStationPositions(buffer);
        setStationRenderTick((tick) => tick + 1);
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    let animationId = 0;
    let lastRenderTime = 0;

    const animate = (time: number) => {
      const prevFrame = additionalPrevFrameRef.current;
      const nextFrame = additionalNextFrameRef.current;

      if (prevFrame && nextFrame && time - lastRenderTime >= ADDITIONAL_ANIMATION_FRAME_MS) {
        lastRenderTime = time;

        const elapsed = Date.now() - nextFrame.time;
        const t = Math.min(elapsed / 1000, 1);
        const buffer = additionalInterpolatedPositionsRef.current;

        buffer.length = nextFrame.positions.length;

        for (let index = 0; index < nextFrame.positions.length; index += 1) {
          const next = nextFrame.positions[index];
          const prev = prevFrame.positions[index];

          const current = buffer[index] ?? {
            name: next.name,
            latitude: next.latitude,
            longitude: next.longitude,
            altitude: next.altitude,
            groupId: next.groupId,
          };

          if (!prev || prev.name !== next.name || prev.groupId !== next.groupId) {
            current.name = next.name;
            current.latitude = next.latitude;
            current.longitude = next.longitude;
            current.altitude = next.altitude;
            current.groupId = next.groupId;
          } else {
            current.name = next.name;
            current.latitude = prev.latitude + (next.latitude - prev.latitude) * t;
            current.longitude = interpolateLongitude(prev.longitude, next.longitude, t);
            current.altitude = prev.altitude + (next.altitude - prev.altitude) * t;
            current.groupId = next.groupId;
          }

          buffer[index] = current;
        }

        setAdditionalPositions(buffer);
        setAdditionalRenderTick((tick) => tick + 1);
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    if (!followSatellite) return;

    mapRef.current?.jumpTo({
      center: [
        followSatellite.longitude,
        followSatellite.latitude,
      ],
    });
  }, [followSatellite, starlinkRenderTick, stationRenderTick]);

  useEffect(() => {
    if (!selectedSatelliteName) {
      setSatellitePaths([]);
      return;
    }

    const tle =
      stationTles.find(sat => sat.name === selectedSatelliteName) ??
      starlinkTles.find(sat => sat.name === selectedSatelliteName) ??
      Object.values(additionalTles)
        .flat()
        .find(sat => sat.name === selectedSatelliteName);

    if (!tle) return;

    const updatePath = () => {
      const now = new Date();
      const path: [number, number][] = [];

      for (let minutes = 0; minutes <= 90; minutes += 2) {
        const future = new Date(now.getTime() + minutes * 60000);
        const pos = calculatePositionAt(tle, future);
        if (pos) {
          path.push([pos.latitude, pos.longitude,]);
        }
      }

      setSatellitePaths([{
        name: tle.name,
        path: splitPathByDateLine(path),
        fullPath: path,
      },
      ]);
    };

    updatePath();

    const timerId = setInterval(updatePath, 1000);
    return () => clearInterval(timerId);
  }, [selectedSatelliteName, stationTles, starlinkTles, additionalTles]);

  useEffect(() => {
    if (!selectedSatelliteName) {
      setPulse(0);
      return;
    }

    let animationId = 0;
    let lastRenderTime = 0;
    const frameMs = 1000 / 30;

    const animate = (time: number) => {
      if (time - lastRenderTime >= frameMs) {
        lastRenderTime = time;
        setPulse((Date.now() % 1000) / 1000);
      }
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, [selectedSatelliteName]);

  const orbitPathSegments = useMemo<OrbitPathSegment[]>(
    () =>
      satellitePaths.flatMap((satPath) =>
        satPath.path.flatMap((path) =>
          path.slice(0, -1).map((point, index) => ({
            path: [
              [point[1], point[0]],
              [path[index + 1][1], path[index + 1][0]],
            ] as [number, number][],
            progress: index / Math.max(path.length - 2, 1),
          }))
        )
      ),
    [satellitePaths]
  );

  const crosshairSegments = useMemo<CrosshairSegment[]>(() => {
    if (!selectedSatellite) return [];

    const lon = selectedSatellite.longitude;
    const lat = selectedSatellite.latitude;

    const sizeLat = 0.25;
    const sizeLon = 0.25 / Math.cos(lat * Math.PI / 180);
    const gap = 0.15;

    return [
      { path: [[lon - sizeLon, lat + sizeLat], [lon - gap, lat + sizeLat]] },
      { path: [[lon - sizeLon, lat + sizeLat], [lon - sizeLon, lat + gap]] },
      { path: [[lon + gap, lat + sizeLat], [lon + sizeLon, lat + sizeLat]] },
      { path: [[lon + sizeLon, lat + sizeLat], [lon + sizeLon, lat + gap]] },
      { path: [[lon - sizeLon, lat - sizeLat], [lon - gap, lat - sizeLat]] },
      { path: [[lon - sizeLon, lat - sizeLat], [lon - sizeLon, lat - gap]] },
      { path: [[lon + Math.min(gap, sizeLon), lat - sizeLat], [lon + sizeLon, lat - sizeLat]] },
      { path: [[lon + sizeLon, lat - sizeLat], [lon + sizeLon, lat - gap]] },
    ];
  }, [selectedSatellite, starlinkRenderTick, stationRenderTick]);

  const worldStarlinkPositions = useMemo<WorldSatellitePosition[]>(
    () =>
      WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
        starlinkPositions.map((satellite) => ({
          satellite,
          longitudeOffset,
          name: satellite.name,
        }))
      ),
    [starlinkPositions, starlinkPositions.length]
  );

  const visibleWorldStarlinkPositions = useMemo<WorldSatellitePosition[]>(() => {
    const bounds = mapRef.current?.getBounds();

    if (!bounds) return worldStarlinkPositions;

    const west = bounds.getWest() - STARLINK_VIEW_PADDING_LONGITUDE;
    const east = bounds.getEast() + STARLINK_VIEW_PADDING_LONGITUDE;
    const south = Math.max(-90, bounds.getSouth() - STARLINK_VIEW_PADDING_LATITUDE);
    const north = Math.min(90, bounds.getNorth() + STARLINK_VIEW_PADDING_LATITUDE);

    return worldStarlinkPositions.filter((d) => {
      const longitude = d.satellite.longitude + d.longitudeOffset;
      const latitude = d.satellite.latitude;

      return (
        longitude >= west &&
        longitude <= east &&
        latitude >= south &&
        latitude <= north
      );
    });
  }, [worldStarlinkPositions, viewState]);

  const worldAdditionalPositions = useMemo<WorldAdditionalSatellitePosition[]>(
    () =>
      WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
        additionalPositions.map((satellite) => ({
          satellite,
          longitudeOffset,
          name: satellite.name,
        }))
      ),
    [additionalPositions, additionalPositions.length, additionalRenderTick]
  );

  const visibleWorldAdditionalPositions = useMemo<WorldAdditionalSatellitePosition[]>(() => {
    const bounds = mapRef.current?.getBounds();

    if (!bounds) return worldAdditionalPositions;

    const west = bounds.getWest() - STARLINK_VIEW_PADDING_LONGITUDE;
    const east = bounds.getEast() + STARLINK_VIEW_PADDING_LONGITUDE;
    const south = Math.max(-90, bounds.getSouth() - STARLINK_VIEW_PADDING_LATITUDE);
    const north = Math.min(90, bounds.getNorth() + STARLINK_VIEW_PADDING_LATITUDE);

    return worldAdditionalPositions.filter((d) => {
      const longitude = d.satellite.longitude + d.longitudeOffset;
      const latitude = d.satellite.latitude;

      return (
        longitude >= west &&
        longitude <= east &&
        latitude >= south &&
        latitude <= north
      );
    });
  }, [worldAdditionalPositions, viewState]);

  const worldStationPositions = useMemo<WorldSatellitePosition[]>(
    () =>
      WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
        stationPositions.map((satellite) => ({
          satellite,
          longitudeOffset,
          name: satellite.name,
        }))
      ),
    [stationPositions, stationPositions.length, stationRenderTick]
  );

  const worldStationLabels = useMemo<WorldStationLabel[]>(() => {
    const clusters: SatellitePosition[][] = [];
    const labelOffsets = new globalThis.Map<string, { index: number; count: number }>();

    for (const station of stationPositions) {
      const cluster = clusters.find((items) =>
        items.some((item) => stationLabelDistance(item, station) < 0.35)
      );

      if (cluster) {
        cluster.push(station);
      } else {
        clusters.push([station]);
      }
    }

    for (const cluster of clusters) {
      cluster
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((station, index) => {
          labelOffsets.set(station.name, {
            index,
            count: cluster.length,
          });
        });
    }

    return WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
      stationPositions.map((satellite) => {
        const offset = labelOffsets.get(satellite.name) ?? { index: 0, count: 1 };

        return {
          satellite,
          longitudeOffset,
          name: satellite.name,
          labelIndex: offset.index,
          labelCount: offset.count,
        };
      })
    );
  }, [stationPositions, stationRenderTick]);

  const worldSelectedSatellitePositions = useMemo<WorldSatellitePosition[]>(
    () =>
      selectedSatellite
        ? WORLD_COPY_LONGITUDE_OFFSETS.map((longitudeOffset) => ({
          satellite: selectedSatellite,
          longitudeOffset,
          name: selectedSatellite.name,
        }))
        : [],
    [selectedSatellite, starlinkRenderTick, stationRenderTick, additionalRenderTick]
  );

  const worldOrbitPathSegments = useMemo<WorldOrbitPathSegment[]>(
    () =>
      WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
        orbitPathSegments.map((segment) => ({
          segment,
          longitudeOffset,
        }))
      ),
    [orbitPathSegments]
  );

  const worldCrosshairSegments = useMemo<WorldCrosshairSegment[]>(
    () =>
      WORLD_COPY_LONGITUDE_OFFSETS.flatMap((longitudeOffset) =>
        crosshairSegments.map((segment) => ({
          segment,
          longitudeOffset,
        }))
      ),
    [crosshairSegments]
  );

  const starlinkLayers = useMemo(
    () => [
      new ScatterplotLayer<WorldSatellitePosition>({
        id: "starlink",
        data: showStarlink ? visibleWorldStarlinkPositions : [],
        getPosition: getWorldSatellitePosition,
        getRadius: 3,
        radiusUnits: "pixels",
        getFillColor: [255, 255, 0, 220],
        pickable: true,
        updateTriggers: {
          getPosition: starlinkRenderTick,
        },
      }),
    ],
    [visibleWorldStarlinkPositions, showStarlink, starlinkRenderTick]
  );

  const stationLayers = useMemo(
    () => [
      new IconLayer<WorldSatellitePosition>({
        id: "stations",
        data: showStations ? worldStationPositions : [],
        getIcon: () => ({
          url: STATION_ICON_URL,
          width: 256,
          height: 256,
          anchorX: 128,
          anchorY: 128,
          mask: false,
        }),
        getPosition: getWorldSatellitePosition,
        getSize: (d) => d.name === selectedSatelliteName ? 72 : 54,
        sizeMinPixels: 36,
        sizeUnits: "pixels",
        pickable: true,
        updateTriggers: {
          getPosition: stationRenderTick,
        },
      }),
      new TextLayer<WorldStationLabel>({
        id: "station-labels",
        data: showStations ? worldStationLabels : [],
        getPosition: getWorldSatellitePosition,
        getText: (d) => d.name,
        getSize: 12,
        sizeUnits: "pixels",
        getColor: (d) =>
          d.name === selectedSatelliteName
            ? [255, 255, 255, 255]
            : [210, 240, 255, 230],
        getTextAnchor: "start",
        getAlignmentBaseline: "center",
        getPixelOffset: (d) => [
          38,
          (d.labelIndex - (d.labelCount - 1) / 2) * 16,
        ],
        background: true,
        getBackgroundColor: [5, 12, 24, 190],
        backgroundPadding: [4, 2],
        fontFamily: "monospace",
        fontWeight: 600,
        pickable: true,
        updateTriggers: {
          getPosition: stationRenderTick,
        },
      }),
    ],
    [worldStationPositions, worldStationLabels, showStations, stationRenderTick, selectedSatelliteName]
  );

  const additionalSatelliteLayers = useMemo(
    () => [
      new ScatterplotLayer<WorldAdditionalSatellitePosition>({
        id: "additional-satellites",
        data: visibleWorldAdditionalPositions.filter(
          (d) => showAdditionalGroups[d.satellite.groupId]
        ),
        getPosition: getWorldSatellitePosition,
        getRadius: 4,
        radiusUnits: "pixels",
        getFillColor: (d) =>
          ADDITIONAL_SATELLITE_GROUPS.find((group) => group.id === d.satellite.groupId)?.color ??
          [255, 255, 255, 220],
        pickable: true,
        updateTriggers: {
          getPosition: additionalRenderTick,
        },
      }),
    ],
    [visibleWorldAdditionalPositions, showAdditionalGroups, additionalRenderTick]
  );

  const selectedLayers = useMemo(
    () => [
      new ScatterplotLayer<WorldSatellitePosition>({
        id: "selected-satellite-ring",
        data: worldSelectedSatellitePositions,
        getPosition: getWorldSatellitePosition,
        getRadius: 18 + pulse * 10,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [0, 160, 255, Math.round(240 * (1 - pulse))],
        lineWidthUnits: "pixels",
        getLineWidth: 3,
        pickable: false,
      }),
    ], [worldSelectedSatellitePositions, pulse]
  );
  const layers = useMemo(
    () => [
      ...starlinkLayers,
      ...stationLayers,
      ...additionalSatelliteLayers,
      ...selectedLayers,
      new ScatterplotLayer<WorldSatellitePosition>({
        id: "selected-satellite-ring-outer",
        data: worldSelectedSatellitePositions,
        getPosition: getWorldSatellitePosition,
        getRadius: 24 + pulse * 14,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [0, 160, 255, Math.round(120 * (1 - pulse))],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        pickable: false,
      }),
      new PathLayer<WorldOrbitPathSegment>({
        id: "orbit-path",
        data: worldOrbitPathSegments,
        getPath: (d) =>
          d.segment.path.map(([longitude, latitude]) => [
            longitude + d.longitudeOffset,
            latitude,
          ] as [number, number]),
        getColor: (d) => [80, 180, 255, Math.round(255 * (1 - d.segment.progress)),],
        widthUnits: "pixels",
        getWidth: (d) => 1 + 1 * Math.pow(1 - d.segment.progress, 2),
      }),
      new PathLayer<WorldCrosshairSegment>({
        id: "crosshair",
        data: worldCrosshairSegments,
        getPath: (d) =>
          d.segment.path.map(([longitude, latitude]) => [
            longitude + d.longitudeOffset,
            latitude,
          ] as [number, number]),
        getColor: [0, 180, 255, 220],
        widthUnits: "pixels",
        getWidth: 2,
        pickable: false,
      }),
    ],
    [starlinkLayers, stationLayers, additionalSatelliteLayers, selectedLayers, worldSelectedSatellitePositions, worldOrbitPathSegments, worldCrosshairSegments, pulse]
  );

  const selectedOrbitPredictionRows = useMemo(() => {
    if (!selectedSatellite) return [];

    const selectedPath = satellitePaths.find((path) => path.name === selectedSatellite.name);
    const fullPath = selectedPath?.fullPath ?? [];

    return ORBIT_PREDICTION_MINUTES.map((minutes) => {
      const pathIndex = Math.round(minutes / 2);
      const point = minutes === 0
        ? [selectedSatellite.latitude, selectedSatellite.longitude] as [number, number]
        : fullPath[pathIndex];

      return {
        minutes,
        latitude: point?.[0] ?? null,
        longitude: point?.[1] ?? null,
      };
    });
  }, [selectedSatellite, satellitePaths]);

  return (

    <div style={{ height: "100vh", width: "100vw", position: "relative" }}>
      {displayMode === "2d" ? (
        <>
          <Map
            ref={mapRef}
            {...viewState}
            renderWorldCopies={true}
            onMove={(evt) => setViewState(evt.viewState)}
            onClick={(evt) => {
              const picked = deckRef.current?.pickObject({
                x: evt.point.x,
                y: evt.point.y,
                radius: 5,
              });
              const pickedSatelliteName = getPickedSatelliteName(picked?.object);

              if (pickedSatelliteName) {
                setSelectedSatelliteName(pickedSatelliteName);
                return;
              }
              setSelectedSatelliteName(null);
              setFollowSatelliteName(null);
            }}
            onDblClick={(evt) => {
              const picked = deckRef.current?.pickObject({
                x: evt.point.x,
                y: evt.point.y,
                radius: 5,
              });
              const pickedSatelliteName = getPickedSatelliteName(picked?.object);

              if (pickedSatelliteName) {
                setSelectedSatelliteName(pickedSatelliteName);
                setFollowSatelliteName(pickedSatelliteName);
                return;
              }
              setFollowSatelliteName(null)
            }}
            mapStyle="https://tiles.openfreemap.org/styles/liberty"
            style={{ width: "100%", height: "100%" }}
          />

          <DeckGL
            ref={deckRef}
            viewState={viewState}
            controller={false}
            layers={layers}
            style={{
              position: "absolute",
              inset: "0",
              pointerEvents: "none",
            }}
          />
        </>
      ) : (
        <Earth3DView
          starlinkPositions={starlinkPositions}
          stationPositions={stationPositions}
          additionalPositions={additionalPositions}
          satellitePaths={satellitePaths}
          selectedSatellite={selectedSatellite}
          selectedSatelliteName={selectedSatelliteName}
          showStarlink={showStarlink}
          showStations={showStations}
          showAdditionalGroups={showAdditionalGroups}
          additionalGroups={ADDITIONAL_SATELLITE_GROUPS}
          positionVersion={threeDPositionVersion}
          earthRotationEnabled={earthRotationEnabled}
          onSelectSatellite={(name) => {
            setSelectedSatelliteName(name);
            if (!name) setFollowSatelliteName(null);
          }}
          onFollowSatellite={setFollowSatelliteName}
        />
      )}

      <div className="sat-hud sat-hud-shared" aria-label="Satellite tracker mode controls">
        <header className="sat-hud-top">
          <div className="sat-hud-brand">
            <span>Satellite Tracker</span>
          </div>
          <div className="sat-hud-mode">
            {(["2d", "3d"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDisplayMode(mode)}
                aria-pressed={displayMode === mode}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
        </header>
      </div>

      {displayMode === "3d" && (
        <div className="sat-hud" aria-label="3D satellite tracker HUD">
          {selectedSatellite && (
            <section className="sat-hud-card sat-hud-info-card">
              <div className="sat-hud-card-title">衛星情報</div>
              <div className="sat-hud-sat-name" title={selectedSatellite.name}>
                {selectedSatellite.name}
              </div>
              <div className="sat-hud-info-grid">
                <span>高度</span>
                <strong>{selectedSatellite.altitude.toFixed(1)} km</strong>
                <span>緯度</span>
                <strong>{formatCoordinate(selectedSatellite.latitude, "latitude")}</strong>
                <span>経度</span>
                <strong>{formatCoordinate(selectedSatellite.longitude, "longitude")}</strong>
              </div>
            </section>
          )}

          {selectedSatellite && selectedOrbitPredictionRows.length > 0 && (
            <section className="sat-hud-card sat-hud-prediction-card">
              <h2>軌道予測（90分）</h2>
              <div className="sat-hud-prediction-list">
                {selectedOrbitPredictionRows.map((row, index) => (
                  <div
                    key={row.minutes}
                    className={index === 0 ? "sat-hud-prediction-row is-now" : "sat-hud-prediction-row"}
                  >
                    <span className="sat-hud-timeline-dot" />
                    <span>{row.minutes === 0 ? "現在（0分）" : `${row.minutes}分後`}</span>
                    <strong>
                      {row.latitude === null || row.longitude === null
                        ? "計算中"
                        : `${formatCoordinate(row.latitude, "latitude")}, ${formatCoordinate(row.longitude, "longitude")}`}
                    </strong>
                  </div>
                ))}
              </div>
            </section>
          )}

          <footer className="sat-hud-bottom">
            <div>
              <span>UTC</span>
              <strong>{formatUtcDate(clockNow)}</strong>
            </div>
            <div className="sat-hud-bottom-legend">
              <span><i className="sat-hud-line" />軌道（90分予測）</span>
              <button
                type="button"
                className={earthRotationEnabled ? "sat-hud-mini-toggle is-active" : "sat-hud-mini-toggle"}
                onClick={() => setEarthRotationEnabled((enabled) => !enabled)}
              >
                <i className="sat-hud-rotation-icon" />
                <span>
                  <b>自転</b>
                  <small>{earthRotationEnabled ? "ON" : "OFF"}</small>
                </span>
              </button>
              <button
                type="button"
                className={showStarlink ? "sat-hud-mini-toggle is-active" : "sat-hud-mini-toggle"}
                onClick={() => setShowStarlink((visible) => !visible)}
              >
                <i className="sat-hud-dot sat-hud-dot-starlink" />
                <span>
                  <b>STARLINK</b>
                  <small>{formatCount(showStarlink ? starlinkPositions.length : 0)}/{formatCount(starlinkTles.length)}</small>
                </span>
              </button>
              <button
                type="button"
                className={showStations ? "sat-hud-mini-toggle is-active" : "sat-hud-mini-toggle"}
                onClick={() => setShowStations((visible) => !visible)}
              >
                <i className="sat-hud-dot sat-hud-dot-station" />
                <span>
                  <b>STATIONS</b>
                  <small>{formatCount(showStations ? stationPositions.length : 0)}/{formatCount(stationTles.length)}</small>
                </span>
              </button>
              {ADDITIONAL_SATELLITE_GROUPS.map((group) => {
                const visible = showAdditionalGroups[group.id] ?? true;
                const visibleCount = visible
                  ? additionalPositions.filter((sat) => sat.groupId === group.id).length
                  : 0;
                const totalCount = additionalTles[group.id]?.length ?? 0;

                return (
                  <button
                    key={group.id}
                    type="button"
                    className={visible ? "sat-hud-mini-toggle is-active" : "sat-hud-mini-toggle"}
                    onClick={() =>
                      setShowAdditionalGroups((current) => ({
                        ...current,
                        [group.id]: !(current[group.id] ?? true),
                      }))
                    }
                  >
                    <i
                      style={{
                        background: `rgb(${group.color[0]}, ${group.color[1]}, ${group.color[2]})`,
                      }}
                    />
                    <span>
                      <b>{group.label}</b>
                      <small>{formatCount(visibleCount)}/{formatCount(totalCount)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </footer>
        </div>
      )}

      {
        selectedSatellite && displayMode === "2d" && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 1000,
              backgroundColor: "rgba(5,10,20,0.9)",
              padding: "10px 12px",
              border: "1px solid rgba(0,191,255,0.75)",
              clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))",
              color: "#8edcff",
              fontFamily: "monospace",
              fontSize: "15px",
              boxShadow: "0 0 10px rgba(0,191,255,0.35), inset 0 0 10px rgba(0,191,255,0.1)",
              backdropFilter: "blur(6px)",
              filter: "drop-shadow(0 0 10px rgba(0,91,255,0.4))",
              width: "fit-content",
              maxWidth: "min(360px, calc(100vw - 20px))",
            }}
          >
            <div style={{
              marginBottom: "6px",
              color: "#00bfff",
              fontWeight: "bold",
              letterSpacing: "0.8px",
              fontSize: "12px",
            }}
            >
              SATELLITE INFO
            </div>
            <div
              title={selectedSatellite.name}
              style={{
                color: "#e6fbff",
                fontSize: "20px",
                fontWeight: "bold",
                marginBottom: "8px",
                maxWidth: "300px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selectedSatellite.name}
            </div>
            <div className="satellite-info-details" style={{
              display: "grid",
              gridTemplateColumns: "60px minmax(0, 1fr)",
              width: "100%",
              rowGap: "3px",
              columnGap: "10px",
              alignItems: "baseline",
            }}
            >
              <div style={{ color: "#5fbfff" }}>緯度</div>
              <div style={{ color: "#e6fbff", textAlign: "right" }}>{selectedSatellite.latitude.toFixed(4)}°</div>
              <div style={{ color: "#5fbfff" }}>経度</div>
              <div style={{ color: "#e6fbff", textAlign: "right" }}>{selectedSatellite.longitude.toFixed(4)}°</div>
              <div style={{ color: "#5fbfff" }}>高度</div>
              <div style={{ color: "#e6fbff", textAlign: "right" }}>{selectedSatellite.altitude.toFixed(4)} km</div>
            </div>
          </div>
        )
      }

      {displayMode === "2d" && (
      <div
        style={{
          position: "absolute",
          bottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
          left: "calc(10px + env(safe-area-inset-left, 0px))",
          zIndex: 1000,
          minWidth: "min(190px, calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))",
          maxWidth: "calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))",
          maxHeight: "calc(100vh - 20px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
          overflow: "auto",
          padding: "10px 14px",
          background: "rgba(5,10,20,0.88)",
          border: "1px solid rgba(0,191,255,0.7)",
          color: "#8edcff",
          fontFamily: "monospace",
          fontSize: "13px",
          filter: "drop-shadow(0 0 10px rgba(0,191,255,0.45))",
          clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))",
        }}
      >
        <div style={{
          marginBottom: "6px",
          color: "#00bfff",
          fontWeight: "bold",
          letterSpacing: "1px",
        }}>
          LAYERS
        </div>
        <div style={{
          display: "grid",
          rowGap: "4px",
        }}
        >
          <button
            type="button"
            onClick={() => setShowStations((visible) => !visible)}
            style={{
              display: "grid",
              gridTemplateColumns: "36px minmax(82px, 1fr) auto",
              columnGap: "8px",
              alignItems: "center",
              minHeight: "28px",
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
              opacity: showStations ? 1 : 0.38,
            }}
          >
            <span style={{ display: "grid", placeItems: "center", width: "36px", height: "28px" }}>
              <img
                src={STATION_ICON_URL}
                alt=""
                style={{
                  width: "30px",
                  height: "30px",
                  objectFit: "contain",
                  filter: showStations ? "drop-shadow(0 0 5px rgba(142,220,255,0.65))" : "grayscale(1)",
                }}
              />
            </span>
            <span style={{ color: "#e6fbff", textAlign: "left" }}>STATIONS</span>
            <span style={{ color: "#8edcff", textAlign: "right", minWidth: "66px" }}>
              {showStations ? stationPositions.length : 0}/{stationTles.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setShowStarlink((visible) => !visible)}
            style={{
              display: "grid",
              gridTemplateColumns: "36px minmax(82px, 1fr) auto",
              columnGap: "8px",
              alignItems: "center",
              minHeight: "28px",
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
              opacity: showStarlink ? 1 : 0.38,
            }}
          >
            <span style={{ display: "grid", placeItems: "center", width: "36px", height: "28px" }}>
              <span
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "50%",
                  background: "rgb(255,255,0)",
                  boxShadow: showStarlink ? "0 0 7px rgba(255,255,0,0.85)" : "none",
                }}
              />
            </span>
            <span style={{ color: "#e6fbff", textAlign: "left" }}>STARLINK</span>
            <span style={{ color: "#8edcff", textAlign: "right", minWidth: "66px" }}>
              {showStarlink ? visibleWorldStarlinkPositions.length : 0}/{starlinkTles.length}
            </span>
          </button>
          {ADDITIONAL_SATELLITE_GROUPS.map((group) => {
            const isVisible = showAdditionalGroups[group.id] ?? true;
            const visibleCount = visibleWorldAdditionalPositions.filter(
              (d) => d.satellite.groupId === group.id
            ).length;
            const tleCount = additionalTles[group.id]?.length ?? 0;

            return (
              <button
                key={group.id}
                type="button"
                onClick={() =>
                  setShowAdditionalGroups((current) => ({
                    ...current,
                    [group.id]: !(current[group.id] ?? true),
                  }))
                }
                style={{
                  display: "grid",
                  gridTemplateColumns: "36px minmax(82px, 1fr) auto",
                  columnGap: "8px",
                  alignItems: "center",
                  minHeight: "28px",
                  padding: 0,
                  border: 0,
                  background: "transparent",
                  color: "inherit",
                  font: "inherit",
                  cursor: "pointer",
                  opacity: isVisible ? 1 : 0.38,
                }}
              >
                <span style={{ display: "grid", placeItems: "center", width: "36px", height: "28px" }}>
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      borderRadius: "50%",
                      background: `rgba(${group.color[0]},${group.color[1]},${group.color[2]},1)`,
                      boxShadow: isVisible
                        ? `0 0 7px rgba(${group.color[0]},${group.color[1]},${group.color[2]},0.75)`
                        : "none",
                    }}
                  />
                </span>
                <span style={{ color: "#e6fbff", textAlign: "left" }}>{group.label}</span>
                <span style={{ color: "#8edcff", textAlign: "right", minWidth: "66px" }}>
                  {isVisible ? visibleCount : 0}/{tleCount}
                </span>
              </button>
            );
          })}
        </div>
      </div >
      )}
    </div>
  );
}

export default App;
