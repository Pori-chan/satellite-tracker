import { useEffect, useMemo, useState } from "react";
import Map, { Marker } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import * as satellite from "satellite.js";

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

  const selectedSatellite = stationPositions.find((sat) => sat.name === selectedSatelliteName) ?? null;

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

  const layers = useMemo(
    () => [
      new ScatterplotLayer<SatellitePosition>({
        id: "starlink",
        data: starlinkPositions,
        getPosition: (d) => [d.longitude, d.latitude],
        getRadius: 3,
        radiusUnits: "pixels",
        getFillColor: [255, 255, 0, 220],
        pickable: false,
      }),
    ],
    [starlinkPositions]
  );

  return (

    <div style={{ height: "100vh", width: "100vw", position: "relative" }}>
      <Map
        {...viewState}
        onMove={(evt) => {
          setViewState(evt.viewState);
        }}
        mapStyle="https://demotiles.maplibre.org/style.json"
        style={{ width: "100%", height: "100%", }}
      >
        {stationPositions.map((sat) => {
          const isSelected = sat.name === selectedSatelliteName;

          return (
            <Marker
              key={sat.name}
              longitude={sat.longitude}
              latitude={sat.latitude}
            >
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedSatelliteName(sat.name);
                }}
                style={{
                  fontSize: isSelected ? "32px" : "24px",
                  cursor: "pointer",
                }}
              >
                {isSelected ? "🔴" : "🛰️"}
              </span>
            </Marker>
          );
        })}
      </Map>
      <DeckGL
        viewState={viewState}
        controller={true}
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