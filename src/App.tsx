import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip, useMap, CircleMarker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import * as satellite from "satellite.js";

type CalculatedPosition = {
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  visibility: string;
};

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

type MapViewState = {
  bounds: L.LatLngBounds | null;
  zoom: number;
};

function calculatePosition(tle: TleSatellite): CalculatedPosition | null {

  const now = new Date();
  const positionAndVelocity = satellite.propagate(tle.satrec, now);

  if (!positionAndVelocity || !positionAndVelocity.position) {
    return null;
  }

  const gmst = satellite.gstime(now);
  const geodetic = satellite.eciToGeodetic(
    positionAndVelocity.position,
    gmst
  );

  const latitude = satellite.degreesLat(geodetic.latitude);
  const longitude = satellite.degreesLong(geodetic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude: satellite.degreesLat(geodetic.latitude),
    longitude: satellite.degreesLong(geodetic.longitude),
    altitude: geodetic.height,
    velocity: 0,
    visibility: "unknown",
  };
}

function calculatePositionAt(tle: TleSatellite, date: Date): CalculatedPosition | null {
  const positionAndVelocity = satellite.propagate(tle.satrec, date);

  if (!positionAndVelocity || !positionAndVelocity.position) {
    return null;
  }

  const gmst = satellite.gstime(date);
  const geodetic = satellite.eciToGeodetic(
    positionAndVelocity.position,
    gmst
  );

  const latitude = satellite.degreesLat(geodetic.latitude);
  const longitude = satellite.degreesLong(geodetic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude: satellite.degreesLat(geodetic.latitude),
    longitude: satellite.degreesLong(geodetic.longitude),
    altitude: geodetic.height,
    velocity: 0,
    visibility: "unknown",
  };
}

function splitPathByDateLine(path: [number, number][]): [number, number][][] {
  const paths: [number, number][][] = [];
  let currentPath: [number, number][] = [];

  for (const point of path) {
    if (currentPath.length === 0) {
      currentPath.push(point);
      continue;
    }

    const previousPoint = currentPath[currentPath.length - 1];
    const previousLongitude = previousPoint[1];
    const currentLongitude = point[1];

    const longitudeDiff = Math.abs(currentLongitude - previousLongitude);

    if (longitudeDiff > 180) {
      paths.push(currentPath);
      currentPath = [point];
    } else {
      currentPath.push(point);
    }
  }

  if (currentPath.length > 0) {
    paths.push(currentPath);
  }

  return paths;
}

const satelliteIcon = L.divIcon({
  html: `
      <div style="
        font-size: 24px;
        transform: translate(-50%,-50%);
        ">
        🛰️
      </div>
    `,
  className: "",
});

const issIcon = L.divIcon({
  html: `
    <div style="
      font-size:32px;
      transform:translate(-50%,-50%);
    ">
      🛰️
    </div>
  `,
  className: "",
});

const STARLINK_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STARLINK&FORMAT=tle";
const STATIONS_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=tle";

const STARLINK_CACHE_KEY = "celstrak_starlink_tle";
const STARLINK_CACHE_TIME_KEY = "celstrak_starlink_tle_time";

const STATIONS_CACHE_KEY = "celestrak_stations_tle";
const STATIONS_CACHE_TIME_KEY = "celestrak_stations_tle_time";

const TLE_CHACHE_TTL_MS = 2 * 60 * 600 * 1000; // 2時間

async function fetchTleTextWithCache(
  url: string,
  cacheKey: string,
  cacheTimeKey: string,
): Promise<string | null> {
  const cachedText = localStorage.getItem(cacheKey);
  const cachedTime = localStorage.getItem(cacheTimeKey);
  const now = Date.now();

  if (cachedText && cachedTime) {
    const age = now - Number(cachedTime);
    if (age < TLE_CHACHE_TTL_MS) {
      console.log("TLEはlocalStorageキャッシュを使用");
      return cachedText;
    }
  }

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.error("TLEの取得に失敗", response.status);
    }

    const text = await response.text();

    localStorage.setItem(cacheKey, text);
    localStorage.setItem(cacheTimeKey, String(now));

    console.log("TLEはネットワークから取得");
    return text;

  } catch (error) {
    console.error("TLEの取得に失敗。キャッシュ確認", error);

    if (cachedText) {
      console.warn("古いTLEキャッシュを使用");
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

function FollowSatellite({ position }: { position: SatellitePosition | null }) {
  const map = useMap();

  useEffect(() => {
    if (!position) return;

    map.setView(
      [position.latitude, position.longitude],
      map.getZoom(),
      {
        animate: true,
        duration: 1.0
      }
    );
  }, [map, position]);

  return null;
}

function MapViewWatcher({
  onChange,
}: {
  onChange: (state: MapViewState) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      onChange({
        bounds: map.getBounds(),
        zoom: map.getZoom(),
      });
    },
    zoomend: () => {
      onChange({
        bounds: map.getBounds(),
        zoom: map.getZoom(),
      });
    },
  });

  useEffect(() => {
    onChange({
      bounds: map.getBounds(),
      zoom: map.getZoom(),
    });
  }, [map, onChange]);

  return null;
}

function ClearSelectionOnMapClick({
  onMapClick,
}: {
  onMapClick: () => void;
}) {
  useMapEvents({
    click: () => {
      onMapClick();
    },
  });
  return null;
}

const orbitColors = [
  "red",
  "blue",
  "green",
  "orange",
  "purple",
  "cyan",
  "magenta",
  "brown",
];

function App() {
  const [starlinkTles, setStarlinkTles] = useState<TleSatellite[]>([]);
  const [stationTles, setStationTles] = useState<TleSatellite[]>([]);

  const [starlinkPositions, setStarlinkPositions] = useState<SatellitePosition[]>([]);
  const [stationPositions, setStationPositions] = useState<SatellitePosition[]>([]);

  const [stationPaths, setStationPaths] = useState<SatellitePath[]>([]);

  const [selectedSatelliteName, setSelectedSatelliteName] = useState<string | null>(null);

  const [mapViewState, setMapViewState] = useState<MapViewState>({
    bounds: null,
    zoom: 5,
  });

  useEffect(() => {
    const fetchAllTle = async () => {
      const starlinkText = await fetchTleTextWithCache(
        STARLINK_TLE_URL,
        STARLINK_CACHE_KEY,
        STARLINK_CACHE_TIME_KEY
      );

      if (starlinkText) {
        setStarlinkTles(parseTleText(starlinkText));
      }

      const stationsText = await fetchTleTextWithCache(
        STATIONS_TLE_URL,
        STATIONS_CACHE_KEY,
        STATIONS_CACHE_TIME_KEY
      );

      if (stationsText) {
        setStationTles(parseTleText(stationsText));
      }
    };

    fetchAllTle();
  }, []);

  useEffect(() => {
    if (starlinkTles.length === 0 && stationTles.length === 0) return;

    const updateAllPositions = () => {
      const newStarlinkPositions = starlinkTles.map((tle) => {
        const pos = calculatePosition(tle);
        if (!pos) return null;

        return {
          name: tle.name,
          latitude: pos.latitude,
          longitude: pos.longitude,
          altitude: pos.altitude,
        };
      })
        .filter((pos): pos is SatellitePosition => pos !== null);

      setStarlinkPositions(newStarlinkPositions);

      const newStationPositions = stationTles.map((tle) => {
        const pos = calculatePosition(tle);
        if (!pos) return null;

        return {
          name: tle.name,
          latitude: pos.latitude,
          longitude: pos.longitude,
          altitude: pos.altitude,
        };
      })
        .filter((pos): pos is SatellitePosition => pos !== null);

      setStationPositions(newStationPositions);

      const now = new Date();

      const newStationPaths = stationTles
        .filter((tle) => tle.name == selectedSatelliteName)
        .map((tle) => {
          const path: [number, number][] = [];

          for (let minutes = 0; minutes <= 30; minutes += 2) {
            const future = new Date(now.getTime() + minutes * 60 * 1000);
            const pos = calculatePositionAt(tle, future);

            if (pos) {
              path.push([pos.latitude, pos.longitude]);
            }
          }

          return {
            name: tle.name,
            path: splitPathByDateLine(path),
          };
        });

      setStationPaths(newStationPaths);
    };

    updateAllPositions();

    const timerId = setInterval(updateAllPositions, 1000);

    return () => clearInterval(timerId);
  }, [starlinkTles, stationTles, selectedSatelliteName]);

  const selectedSatellite = stationPositions.find(sat => sat.name === selectedSatelliteName) ?? null;

  const visibleStarlinkPositions = mapViewState.bounds
    ? starlinkPositions.filter((sat) =>
      mapViewState.bounds!.contains(
        L.latLng(
          sat.latitude,
          sat.longitude
        )
      )
    )
    : starlinkPositions;

  const sortedStationPositions = [...stationPositions].toSorted((a, b) => {
    if (a.name === selectedSatelliteName) return 1;
    if (b.name === selectedSatelliteName) return -1;

    if (a.name == "ISS (ZARYA)") return 1;
    if (b.name == "ISS (ZARYA)") return -1;
    return 0;
  });

  const canvasRenderer = L.canvas({
    padding: 0.5,
  });

  return (
    <>
      <div style={{
        position: 'absolute',
        bottom: 10,
        left: 10,
        zIndex: 1000,
        backgroundColor: 'white',
        padding: '10px',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        fontFamily: 'Arial, sans-serif',
        fontSize: '13px',
      }}>
        <div>STARLINK TLE: {starlinkTles.length}</div>
        <div>STARLINK 全位置: {starlinkPositions.length}</div>
        <div>STARLINK 描画: {visibleStarlinkPositions.length}</div>
        <div>Zoom: {mapViewState.zoom}</div>
        <div>STATIONS TLE: {stationTles.length}</div>
        <div>STATIONS 表示: {stationPositions.length}</div>
      </div>

      <div style={{ height: '100vh', width: '100vw', position: 'relative' }}>
        {selectedSatellite && (
          <div style={{
            position: 'absolute',
            top: 10,
            right: 10,
            zIndex: 1000,
            backgroundColor: 'white',
            padding: '10px',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
            fontFamily: 'Arial, sans-serif',
          }}>
            <div>名前: {selectedSatellite?.name}</div>
            <div>緯度: {selectedSatellite.latitude.toFixed(4)}</div>
            <div>経度: {selectedSatellite.longitude.toFixed(4)}</div>
            <div>高度: {selectedSatellite.altitude.toFixed(1)} km</div>
          </div>
        )}
        <MapContainer
          center={[35.6812, 139.7671]}
          zoom={5}
          style={{ height: '100%', width: '100%' }}
          renderer={canvasRenderer}
        >
          <ClearSelectionOnMapClick onMapClick={() => setSelectedSatelliteName(null)} />
          <MapViewWatcher onChange={setMapViewState} />
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {sortedStationPositions.map((sat) => {
            return (
              <Marker
                key={`station-${sat.name}`}
                position={[sat.latitude, sat.longitude]}
                icon={
                  sat.name === "ISS (ZARYA)"
                    ? issIcon
                    : satelliteIcon
                }
                eventHandlers={{
                  click: (e) => {
                    L.DomEvent.stopPropagation(e.originalEvent);
                    setSelectedSatelliteName(sat.name);
                  },
                }}
              >
                <Tooltip
                  permanent
                  direction="right"
                  offset={[12, 0]}
                  interactive={true}
                  eventHandlers={{
                    click: (e) => {
                      L.DomEvent.stopPropagation(e.originalEvent);
                      setSelectedSatelliteName(sat.name);
                    },
                  }}
                >
                  {sat.name}
                </Tooltip>

              </Marker>
            );
          })}

          {visibleStarlinkPositions.map((sat) => {
            return (
              <CircleMarker
                key={sat.name}
                center={[sat.latitude, sat.longitude]}
                radius={3}
                interactive={false}
                pathOptions={{
                  color: "yellow",
                  fillColor: "yellow",
                  fillOpacity: 0.8,
                  weight: 0,
                }}
              >
              </CircleMarker>
            );
          })}

          {stationPaths.map((satPath, satIndex) =>
            (satPath.path ?? []).map((path, pathIndex) => (
              <Polyline
                key={`${satPath.name}-${pathIndex}`}
                positions={path}
                interactive={false}
                weight={2}
                color={orbitColors[satIndex % orbitColors.length]}
              />
            ))
          )}

          <FollowSatellite position={selectedSatellite} />

        </MapContainer>
      </div>
    </>
  );
}

export default App;