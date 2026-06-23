import { useEffect, useMemo, useState } from "react";
import Map, { Marker, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer } from "@deck.gl/layers";
import * as satellite from "satellite.js";
import { useRef } from "react";
import type { DeckGLRef } from "@deck.gl/react"

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

type SatellitePath = {
  name: string;
  path: [number, number][][];
};

type OrbitPathSegment = {
  path: [number, number][];
  progress: number;
};

type PositionFrame = {
  time: number;
  positions: SatellitePosition[];
};

type CrosshairSegment = {
  path: [number, number][];
};

const CACHE_EXPIRE_MS = 2*60*60*1000;

const STARLINK_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STARLINK&FORMAT=tle";
const STATION_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=tle";

async function fetchTleWithCache(url:string,cacheKey:string):Promise<string|null>{
  const timestampKey = `${cacheKey}_timestamp`;

  const cachedText = localStorage.getItem(cacheKey);
  const cachedTimestamp = localStorage.getItem(timestampKey);

  if(cachedText && cachedTimestamp){
    const age = Date.now() - Number(cachedTimestamp);

    if(age < CACHE_EXPIRE_MS){
      console.log(`${cacheKey} キャッシュ使用 (${Math.floor(age/60000)}分経過)`);
      return cachedText;
    }
  }

  try {
    const response = await fetch(url);
    if(!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();

    localStorage.setItem(cacheKey,text);
    localStorage.setItem(timestampKey,String(Date.now()));
    console.log(`${cacheKey} 更新取得`);
    return text;
  }catch(error){
    console.error(error);

    if(cachedText){
      console.warn(`%{cacheKey} 期限切れキャッシュ利用`);
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

function App() {
  const [starlinkTles, setStarlinkTles] = useState<TleSatellite[]>([]);
  const [stationTles, setStationTles] = useState<TleSatellite[]>([]);
  const [starlinkPositions, setStarlinkPositions] = useState<SatellitePosition[]>([]);
  const [stationPositions, setStationPositions] = useState<SatellitePosition[]>([]);
  const [selectedSatelliteName, setSelectedSatelliteName] = useState<string | null>(null);
  const [viewState, setViewState] = useState({
    longitude: 139.7671,
    latitude: 35.6812,
    zoom: 3,
    pitch: 0,
    bearing: 0,
  });
  const [satellitePaths, setSatellitePaths] = useState<SatellitePath[]>([]);
  const [pulse, setPulse] = useState(0);

  const selectedSatellite =
    stationPositions.find((sat) => sat.name === selectedSatelliteName) ??
    starlinkPositions.find((sat) => sat.name === selectedSatelliteName) ??
    null;
  const mapRef = useRef<MapRef>(null);
  const deckRef = useRef<DeckGLRef>(null);
  const starlinkPrevFrameRef = useRef<PositionFrame | null>(null);
  const starlinkNextFrameRef = useRef<PositionFrame | null>(null);

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
      if(stationText)setStationTles(parseTleText(stationText));
    };

    load();
  }, []);

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

      setStationPositions(next);
    };

    update();

    const timerId = setInterval(update, 1000);
    return () => clearInterval(timerId);
  }, [stationTles]);

  useEffect(() => {
    let animationId = 0;

    const animate = () => {
      const prevFrame = starlinkPrevFrameRef.current;
      const nextFrame = starlinkNextFrameRef.current;

      if (prevFrame && nextFrame) {
        const elapsed = Date.now() - nextFrame.time;
        const t = Math.min(elapsed / 1000, 1);

        const interpolated = nextFrame.positions.map((next, index) => {
          const prev = prevFrame.positions[index];
          if (!prev || prev.name !== next.name) return next;

          return {
            name: next.name,
            latitude: prev.latitude + (next.latitude - prev.latitude) * t,
            longitude: prev.longitude + (next.longitude - prev.longitude) * t,
            altitude: prev.altitude + (next.altitude - prev.altitude) * t,
          };
        });

        setStarlinkPositions(interpolated);
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    if (!selectedSatellite) return;

    mapRef.current?.jumpTo({
      center: [
        selectedSatellite.longitude,
        selectedSatellite.latitude,
      ],
    });
  }, [selectedSatellite]);

  useEffect(() => {
    if (!selectedSatelliteName) {
      setSatellitePaths([]);
      return;
    }

    const tle =
      stationTles.find(sat => sat.name === selectedSatelliteName) ??
      starlinkTles.find(sat => sat.name === selectedSatelliteName);

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
      },
      ]);
    };

    updatePath();

    const timerId = setInterval(updatePath, 1000);
    return () => clearInterval(timerId);
  }, [selectedSatelliteName, stationTles]);

  useEffect(() => {
    let animationId = 0;

    const animate = () => {
      setPulse((Date.now() % 1000) / 1000);
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationId);
  }, []);

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
  }, [selectedSatellite]);

  const layers = useMemo(
    () => [
      new ScatterplotLayer<SatellitePosition>({
        id: "starlink",
        data: starlinkPositions,
        getPosition: (d) => [d.longitude, d.latitude],
        getRadius: 3,
        radiusUnits: "pixels",
        getFillColor: [255, 255, 0, 220],
        pickable: true,
      }),
      new ScatterplotLayer<SatellitePosition>({
        id: "selected-satellite-ring",
        data: selectedSatellite ? [selectedSatellite] : [],
        getPosition: (d) => [d.longitude, d.latitude],
        getRadius: 18 + pulse * 10,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [0, 160, 255, Math.round(240 * (1 - pulse))],
        lineWidthUnits: "pixels",
        getLineWidth: 3,
        pickable: false,
      }),
      new ScatterplotLayer<SatellitePosition>({
        id: "selected-satellite-ring-outer",
        data: selectedSatellite ? [selectedSatellite] : [],
        getPosition: (d) => [d.longitude, d.latitude],
        getRadius: 24 + pulse * 14,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [0, 160, 255, Math.round(120 * (1 - pulse))],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        pickable: false,
      }),
      new PathLayer<OrbitPathSegment>({
        id: "orbit-path",
        data: orbitPathSegments,
        getPath: (d) => d.path,
        getColor: (d) => [80, 180, 255, Math.round(255 * (1 - d.progress)),],
        widthUnits: "pixels",
        getWidth: (d) => 1 + 1 * Math.pow(1 - d.progress, 2),
      }),
      new PathLayer<CrosshairSegment>({
        id: "crosshair",
        data: crosshairSegments,
        getPath: (d) => d.path,
        getColor: [0, 180, 255, 220],
        widthUnits: "pixels",
        getWidth: 2,
        pickable: false,
      }),
    ],
    [selectedSatellite, starlinkPositions, orbitPathSegments, crosshairSegments, pulse]
  );

  return (

    <div style={{ height: "100vh", width: "100vw", position: "relative" }}>
      <Map
        ref={mapRef}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        onClick={(evt) => {
          const picked = deckRef.current?.pickObject({
            x: evt.point.x,
            y: evt.point.y,
            radius: 5,
          });

          if (picked?.object) {
            setSelectedSatelliteName(picked.object.name);
            return;
          }
          setSelectedSatelliteName(null);
        }}
        mapStyle="https://tiles.openfreemap.org/styles/liberty"
        style={{ width: "100%", height: "100%" }}
      >
        {stationPositions.map((sat) => {
          const isSelected = sat.name === selectedSatelliteName;

          return (
            <Marker
              key={sat.name}
              longitude={sat.longitude}
              latitude={sat.latitude}
            >
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedSatelliteName(sat.name);
                }}
                style={{
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: isSelected ? "24px" : "18px",
                  color: isSelected ? "red" : "white",
                  textShadow: "0 0 3px black",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontSize: "18px" }}>
                  🛰️
                </span>
                {/* <span>{sat.name}</span> */}
              </div>
            </Marker>
          );
        })}
      </Map>

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

      {
        selectedSatellite && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 1000,
              backgroundColor: "white",
              padding: "10px",
              borderRadius: "8px",
              fontFamily: "Arial, sans-serif",
              fontSize: "13px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <div>名前: {selectedSatellite.name}</div>
            <div>緯度: {selectedSatellite.latitude.toFixed(4)}</div>
            <div>経度: {selectedSatellite.longitude.toFixed(4)}</div>
            <div>高度: {selectedSatellite.altitude.toFixed(4)}</div>
          </div>
        )
      }

      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 10,
          zIndex: 10,
          backgroundColor: "white",
          padding: "8px",
          borderRadius: "8px",
          fontFamily: "Arial, sans-serif",
          fontSize: "13px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        }}
      >
        <div>STARLINK TLE: {starlinkTles.length}</div>
        <div>STARLINK 表示: {starlinkPositions.length}</div>
      </div>
    </div >
  );
}

export default App;