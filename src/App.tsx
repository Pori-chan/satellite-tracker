import { useEffect, useMemo, useState } from "react";
import Map from "react-map-gl/maplibre";
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
  const [tles, setTles] = useState<TleSatellite[]>([]);
  const [positions, setPositions] = useState<SatellitePosition[]>([]);

  useEffect(()=>{
    const cachedText = localStorage.getItem("celstrak_starlink_tle");

    if(!cachedText){
      console.error("キャッシュなし");
      return;
    }
    setTles(parseTleText(cachedText));

    // const fetchTle = async () =>{
    //   const res = await fetch(STARLINK_TLE_URL);
    //   const text = await res.text();
    //   setTles(parseTleText(text));
    // };

    // fetchTle();
  },[]);

  useEffect(()=>{
    if(tles.length===0)return;

    const update = ()=>{
      const next = tles
        .map(calculatePosition)
        .filter((p):p is SatellitePosition => p !== null);

      setPositions(next);
    };

    update();

    const timerId = setInterval(update,1000);
    return () => clearInterval(timerId);
  },[tles]);

  const layers = useMemo(
    ()=>[
      new ScatterplotLayer<SatellitePosition>({
        id: "starlink",
        data: positions,
        getPosition: (d)=>[d.longitude,d.latitude],
        getRadius:20000,
        radiusUnits:"meters",
        getFillColor:[255,255,0,220],
        pickable:false,
      }),
    ],
    [positions]
  );

  return(
    <div style={{height:"100vh",width:"100vw"}}>
      <DeckGL
        initialViewState={{
          longitude: 139.7671,
          latitude: 35.6812,
          zoom:3,
          pitch:0,
          bearing:0,
        }}
        controller={true}
        layers={layers}
      >
        <Map
          mapStyle="https://demotiles.maplibre.org/style.json"
        />
      </DeckGL>

      <div
        style={{
          position: "absolute",
          bottom:10,
          left:10,
          zIndex:10,
          backgroundColor:"white",
          padding:"8px",
          borderRadius: "8px",
          fontFamily: "Arial, sans-serif",
          fontSize: "13px",
        }}
      >
        <div>STARLINK TLE: {tles.length}</div>
        <div>STARLINK 表示: {positions.length}</div>
      </div>
    </div>
  );
}

export default App;