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
}

type OrbitPathSegment = {
  path: [number, number][];
};

const STARLINK_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STARLINK&FORMAT=tle";
const STATION_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=tle";

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

  const selectedSatellite =
    stationPositions.find((sat) => sat.name === selectedSatelliteName) ??
    starlinkPositions.find((sat) => sat.name === selectedSatelliteName) ??
    null;
  const mapRef = useRef<MapRef>(null);
  const deckRef = useRef<DeckGLRef>(null);

  useEffect(() => {
    const cachedStalinkTleText = localStorage.getItem("celstrak_starlink_tle");
    if (!cachedStalinkTleText) {
      console.error("キャッシュなし:starlink");
      return;
    }
    setStarlinkTles(parseTleText(cachedStalinkTleText));

    const cachedStationTleText = localStorage.getItem("celestrak_stations_tle");
    if (!cachedStationTleText) {
      console.error("キャッシュなし:stations");
      return;
    }
    setStationTles(parseTleText(cachedStationTleText));

    // const fetchTle = async () =>{
    //   const res = await fetch(STARLINK_TLE_URL);
    //   const text = await res.text();
    //   setTles(parseTleText(text));
    // };

    // fetchTle();
  }, []);

  useEffect(() => {
    if (starlinkTles.length === 0) return;

    const update = () => {
      const next = starlinkTles
        .map(calculatePosition)
        .filter((p): p is SatellitePosition => p !== null);

      setStarlinkPositions(next);
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
    if (!selectedSatellite) return;

    mapRef.current?.flyTo({
      center: [
        selectedSatellite.longitude,
        selectedSatellite.latitude,
      ],
      duration: 1000,
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

      for (let minutes = 0; minutes <= 30; minutes += 2) {
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

  const orbitPathSegments = useMemo<OrbitPathSegment[]>(
    () =>
      satellitePaths.flatMap((satPath) =>
        satPath.path.map((path) => ({
          path: path.map(([lat, lon]) => [lon, lat] as [number, number]),
        }))
      ),
    [satellitePaths]
  );

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
      new PathLayer<OrbitPathSegment>({
        id: "orbit-path",
        data: orbitPathSegments,
        getPath: (d) => d.path,
        getColor: [255, 0, 0],
        widthUnits: "pixels",
        getWidth: 3,
      }),
    ],
    [starlinkPositions, orbitPathSegments]
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
                <span style={{ fontSize: isSelected ? "24px" : "18px" }}>
                  {isSelected ? "🔴" : "🛰️"}
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