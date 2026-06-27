import { useEffect, useMemo, useRef, type MouseEvent, type PointerEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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

type AdditionalGroup = {
  id: string;
  color: [number, number, number, number];
};

type Earth3DViewProps = {
  starlinkPositions: SatellitePosition[];
  stationPositions: SatellitePosition[];
  additionalPositions: AdditionalSatellitePosition[];
  satellitePaths: SatellitePath[];
  selectedSatellite: SatellitePosition | null;
  selectedSatelliteName: string | null;
  showStarlink: boolean;
  showStations: boolean;
  showAdditionalGroups: Record<string, boolean>;
  additionalGroups: AdditionalGroup[];
  positionVersion: number;
  earthRotationEnabled: boolean;
  dayNightEnabled: boolean;
  onSelectSatellite: (name: string | null) => void;
  onFollowSatellite: (name: string | null) => void;
};

type PickTarget = {
  names: string[];
};

type PickCandidate = {
  object: THREE.Object3D;
  index?: number;
  distance: number;
  screenDistance: number;
  priority: number;
};

type StationSpriteSet = {
  group: THREE.Group;
  pickables: THREE.Object3D[];
  items: {
    name: string;
    icon: THREE.Sprite;
    label: THREE.Sprite;
    labelSlot: StationLabelSlot;
    labelAnchor: THREE.Vector3;
  }[];
};

type StationLabelSlot = {
  index: number;
  total: number;
};

const EARTH_RADIUS_KM = 6371;
const EARTH_SCENE_RADIUS = 1;
const SATELLITE_ALTITUDE_SCALE = 1;
const STATION_ICON_URL = `${import.meta.env.BASE_URL}station-icon.png`;
const SATELLITE_PICK_WORLD_THRESHOLD = 0.018;
const SATELLITE_PICK_SCREEN_THRESHOLD_PX = 9;
const SPRITE_PICK_SCREEN_THRESHOLD_PX = 28;
const STATION_ICON_SCREEN_SIZE_PX = 34;
const STATION_LABEL_SCREEN_WIDTH_PX = 150;
const STATION_LABEL_SCREEN_HEIGHT_PX = 33;
const STATION_LABEL_OFFSET_X_PX = 100;
const STATION_LABEL_STACK_STEP_PX = 18;
const EARTH_TEXTURES = {
  day: `${import.meta.env.BASE_URL}earth/earth_day.jpg`,
  lights: `${import.meta.env.BASE_URL}earth/earth_lights.png`,
  normal: `${import.meta.env.BASE_URL}earth/earth_normal.jpg`,
  specular: `${import.meta.env.BASE_URL}earth/earth_specular.jpg`,
  clouds: `${import.meta.env.BASE_URL}earth/earth_clouds.png`,
};
let satellitePointTexture: THREE.CanvasTexture | null = null;

function degToRad(value: number): number {
  return value * Math.PI / 180;
}

function latLonAltitudeToVector(
  latitude: number,
  longitude: number,
  altitude: number,
  radiusOffset = 0
): THREE.Vector3 {
  const lat = degToRad(latitude);
  const lon = degToRad(longitude);
  const radius =
    EARTH_SCENE_RADIUS +
    (Math.max(0, altitude) / EARTH_RADIUS_KM) * SATELLITE_ALTITUDE_SCALE +
    radiusOffset;
  const cosLat = Math.cos(lat);

  return new THREE.Vector3(
    radius * cosLat * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * cosLat * Math.sin(lon)
  );
}

function getSolarSubpoint(date: Date): { latitude: number; longitude: number } {
  const dayMs = 24 * 60 * 60 * 1000;
  const julianDays = date.getTime() / dayMs + 2440587.5;
  const daysSinceJ2000 = julianDays - 2451545.0;
  const meanLongitude = degToRad((280.46 + 0.9856474 * daysSinceJ2000) % 360);
  const meanAnomaly = degToRad((357.528 + 0.9856003 * daysSinceJ2000) % 360);
  const eclipticLongitude =
    meanLongitude +
    degToRad(1.915) * Math.sin(meanAnomaly) +
    degToRad(0.02) * Math.sin(2 * meanAnomaly);
  const obliquity = degToRad(23.439 - 0.0000004 * daysSinceJ2000);
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude)
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const gmst =
    degToRad(
      (280.46061837 +
        360.98564736629 * (julianDays - 2451545) +
        0.000387933 * (daysSinceJ2000 / 36525) ** 2 -
        ((daysSinceJ2000 / 36525) ** 3) / 38710000) %
      360
    );

  let longitude = (rightAscension - gmst) * 180 / Math.PI;
  longitude = ((longitude + 540) % 360) - 180;

  return {
    latitude: declination * 180 / Math.PI,
    longitude,
  };
}

function getSunDirection(date: Date): THREE.Vector3 {
  const subpoint = getSolarSubpoint(date);
  return latLonAltitudeToVector(subpoint.latitude, subpoint.longitude, 0).normalize();
}

function colorToCss(color: [number, number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function getOrbitPredictionColor(progress: number): THREE.Color {
  const clamped = THREE.MathUtils.clamp(progress, 0, 1);
  const early = new THREE.Color("#008cff");
  const mid = new THREE.Color("#58b8ff");
  const late = new THREE.Color("#d7ecff");

  return clamped < 0.5
    ? early.lerp(mid, clamped / 0.5)
    : mid.lerp(late, (clamped - 0.5) / 0.5);
}

function loadEarthTexture(loader: THREE.TextureLoader, url: string, colorTexture = true): THREE.Texture {
  const texture = loader.load(url);
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

function getSatellitePointTexture(): THREE.CanvasTexture {
  if (satellitePointTexture) return satellitePointTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");

  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 30);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.32, "rgba(255, 255, 255, 0.95)");
    gradient.addColorStop(0.62, "rgba(255, 255, 255, 0.34)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  satellitePointTexture = new THREE.CanvasTexture(canvas);
  satellitePointTexture.colorSpace = THREE.SRGBColorSpace;
  satellitePointTexture.minFilter = THREE.LinearFilter;
  satellitePointTexture.magFilter = THREE.LinearFilter;
  return satellitePointTexture;
}

function makeSatellitePoints(
  positions: SatellitePosition[],
  color: THREE.ColorRepresentation,
  size: number
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const coordinates = new Float32Array(positions.length * 3);

  positions.forEach((position, index) => {
    const vector = latLonAltitudeToVector(position.latitude, position.longitude, position.altitude, 0.012);
    coordinates[index * 3] = vector.x;
    coordinates[index * 3 + 1] = vector.y;
    coordinates[index * 3 + 2] = vector.z;
  });

  geometry.setAttribute("position", new THREE.BufferAttribute(coordinates, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

  const material = new THREE.PointsMaterial({
    color,
    map: getSatellitePointTexture(),
    size,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.88,
    alphaTest: 0.03,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.userData.pickTarget = {
    names: positions.map((position) => position.name),
  } satisfies PickTarget;
  return points;
}

function updateSatellitePointPositions(
  points: THREE.Points,
  positions: SatellitePosition[]
): void {
  const attribute = points.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!attribute || attribute.count !== positions.length) return;

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    const vector = latLonAltitudeToVector(
      position.latitude,
      position.longitude,
      position.altitude,
      0.012
    );
    attribute.setXYZ(index, vector.x, vector.y, vector.z);
  }

  attribute.needsUpdate = true;
}

function makePositionsKey(positions: SatellitePosition[]): string {
  if (positions.length === 0) return "0";
  const first = positions[0]?.name ?? "";
  const last = positions[positions.length - 1]?.name ?? "";
  return `${positions.length}:${first}:${last}`;
}

function groupAdditionalPositions(
  positions: AdditionalSatellitePosition[]
): Map<string, AdditionalSatellitePosition[]> {
  const grouped = new Map<string, AdditionalSatellitePosition[]>();

  for (const position of positions) {
    const current = grouped.get(position.groupId);
    if (current) {
      current.push(position);
    } else {
      grouped.set(position.groupId, [position]);
    }
  }

  return grouped;
}

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d");

  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "700 32px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.textBaseline = "middle";

    const metrics = context.measureText(text);
    const width = Math.min(canvas.width - 18, Math.max(160, metrics.width + 36));
    const height = 56;
    const x = 8;
    const y = 28;

    context.fillStyle = "rgba(2, 8, 16, 0.72)";
    context.strokeStyle = "rgba(80, 180, 255, 0.58)";
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(x, y, width, height, 8);
    context.fill();
    context.stroke();

    context.lineWidth = 5;
    context.strokeStyle = "rgba(0, 0, 0, 0.95)";
    context.strokeText(text, x + 18, y + height / 2);
    context.fillStyle = "rgba(230, 248, 255, 0.96)";
    context.fillText(text, x + 18, y + height / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function makeStationSprites(
  positions: SatellitePosition[],
  iconTexture: THREE.Texture
): StationSpriteSet {
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const items: StationSpriteSet["items"] = [];
  const labelSlots = makeStationLabelSlots(positions);

  for (const station of positions) {
    const icon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: iconTexture,
        color: "#52a7ff",
        transparent: true,
        opacity: 0.96,
        depthTest: true,
        depthWrite: false,
      })
    );
    icon.scale.setScalar(0.082);
    icon.userData.pickName = station.name;
    icon.userData.screenSize = {
      width: STATION_ICON_SCREEN_SIZE_PX,
      height: STATION_ICON_SCREEN_SIZE_PX,
    };
    group.add(icon);
    pickables.push(icon);

    const labelTexture = makeLabelTexture(station.name);
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture,
        transparent: true,
        opacity: 0.94,
        depthTest: true,
        depthWrite: false,
      })
    );
    label.scale.set(0.34, 0.074, 1);
    label.userData.pickName = station.name;
    label.userData.pickBox = {
      width: STATION_LABEL_SCREEN_WIDTH_PX,
      height: STATION_LABEL_SCREEN_HEIGHT_PX,
    };
    label.userData.screenSize = {
      width: STATION_LABEL_SCREEN_WIDTH_PX,
      height: STATION_LABEL_SCREEN_HEIGHT_PX,
    };
    label.userData.disposeMap = true;
    group.add(label);
    pickables.push(label);
    const labelSlot = labelSlots.get(station.name) ?? { index: 0, total: 1 };
    const stationItem = {
      name: station.name,
      icon,
      label,
      labelSlot,
      labelAnchor: new THREE.Vector3(),
    };
    items.push(stationItem);
    updateStationSpriteItem(
      stationItem,
      station,
      labelSlot
    );
  }

  return { group, pickables, items };
}

function makeStationLabelSlots(positions: SatellitePosition[]): Map<string, StationLabelSlot> {
  const clusters = new Map<string, SatellitePosition[]>();

  for (const position of positions) {
    const key = [
      Math.round(position.latitude * 10),
      Math.round(position.longitude * 10),
      Math.round(position.altitude / 10),
    ].join(":");
    const cluster = clusters.get(key);
    if (cluster) {
      cluster.push(position);
    } else {
      clusters.set(key, [position]);
    }
  }

  const slots = new Map<string, StationLabelSlot>();
  for (const cluster of clusters.values()) {
    const sorted = [...cluster].sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach((position, index) => {
      slots.set(position.name, { index, total: sorted.length });
    });
  }

  return slots;
}

function updateStationSpriteItem(
  item: StationSpriteSet["items"][number],
  station: SatellitePosition,
  labelSlot: StationLabelSlot = { index: 0, total: 1 }
): void {
  const position = latLonAltitudeToVector(
    station.latitude,
    station.longitude,
    station.altitude,
    0.018
  );
  const radial = position.clone().normalize();
  const tangent = new THREE.Vector3(0, 1, 0).cross(radial).normalize();

  if (!Number.isFinite(tangent.x + tangent.y + tangent.z) || tangent.lengthSq() === 0) {
    tangent.set(1, 0, 0);
  }

  item.labelSlot = labelSlot;

  item.icon.position.copy(position);
  item.labelAnchor
    .copy(position)
    .addScaledVector(radial, 0.016);
  item.label.position.copy(item.labelAnchor);
}

function updateStationSprites(
  spriteSet: StationSpriteSet,
  positions: SatellitePosition[]
): void {
  const positionMap = new Map(positions.map((position) => [position.name, position]));
  const labelSlots = makeStationLabelSlots(positions);

  for (const item of spriteSet.items) {
    const position = positionMap.get(item.name);
    if (position) updateStationSpriteItem(item, position, labelSlots.get(item.name));
  }
}

function getWorldUnitsPerPixel(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): number {
  const height = Math.max(1, renderer.domElement.clientHeight);
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const distance = cameraPosition.distanceTo(point);
  const visibleHeight = 2 * Math.tan(degToRad(camera.fov) / 2) * distance;

  return visibleHeight / height;
}

function updateScreenSizedSprite(
  sprite: THREE.Sprite,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  scaleAnchor?: THREE.Vector3
): void {
  const screenSize = sprite.userData.screenSize as { width: number; height: number } | undefined;
  if (!screenSize) return;

  const worldUnitsPerPixel = getWorldUnitsPerPixel(
    scaleAnchor ?? sprite.getWorldPosition(new THREE.Vector3()),
    camera,
    renderer
  );
  sprite.scale.set(
    screenSize.width * worldUnitsPerPixel,
    screenSize.height * worldUnitsPerPixel,
    1
  );
}

function offsetSpriteByScreenPixels(
  sprite: THREE.Sprite,
  anchor: THREE.Vector3,
  offsetX: number,
  offsetY: number,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): void {
  if (offsetX === 0 && offsetY === 0) {
    sprite.position.copy(anchor);
    return;
  }

  const worldUnitsPerPixel = getWorldUnitsPerPixel(anchor, camera, renderer);
  const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
  const screenRight = new THREE.Vector3().crossVectors(cameraDirection, camera.up).normalize();
  const screenUp = new THREE.Vector3().crossVectors(screenRight, cameraDirection).normalize();

  sprite.position
    .copy(anchor)
    .addScaledVector(screenRight, offsetX * worldUnitsPerPixel)
    .addScaledVector(screenUp, -offsetY * worldUnitsPerPixel);
}

function updateStationScreenScales(
  spriteSet: StationSpriteSet | null,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): void {
  if (!spriteSet) return;

  for (const item of spriteSet.items) {
    const scaleAnchor = item.icon.getWorldPosition(new THREE.Vector3());
    updateScreenSizedSprite(item.icon, camera, renderer, scaleAnchor);
    updateScreenSizedSprite(item.label, camera, renderer, scaleAnchor);
    offsetSpriteByScreenPixels(
      item.label,
      item.labelAnchor,
      STATION_LABEL_OFFSET_X_PX,
      (item.labelSlot.index - (item.labelSlot.total - 1) / 2) * STATION_LABEL_STACK_STEP_PX,
      camera,
      renderer
    );
  }
}

function getObjectPosition(object: THREE.Object3D, index?: number): THREE.Vector3 | null {
  if (object instanceof THREE.Points) {
    if (index === undefined) return null;

    return getPointPosition(object, index);
  }

  return object.getWorldPosition(new THREE.Vector3());
}

function getPointPosition(points: THREE.Points, index: number): THREE.Vector3 | null {
  const positions = points.geometry.getAttribute("position");
  if (!positions || index < 0 || index >= positions.count) return null;

  return new THREE.Vector3(
    positions.getX(index),
    positions.getY(index),
    positions.getZ(index)
  ).applyMatrix4(points.matrixWorld);
}

function isOccludedByEarth(point: THREE.Vector3, camera: THREE.PerspectiveCamera): boolean {
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const segment = point.clone().sub(cameraPosition);
  const lengthSq = segment.lengthSq();
  if (lengthSq === 0) return false;

  const t = THREE.MathUtils.clamp(-cameraPosition.dot(segment) / lengthSq, 0, 1);
  if (t <= 0 || t >= 1) return false;

  const closestPoint = cameraPosition.clone().add(segment.multiplyScalar(t));
  return closestPoint.length() < EARTH_SCENE_RADIUS * 1.012;
}

function getScreenDistance(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  rect: DOMRect,
  clientX: number,
  clientY: number
): number {
  const projected = point.clone().project(camera);
  const x = rect.left + (projected.x + 1) * rect.width / 2;
  const y = rect.top + (1 - projected.y) * rect.height / 2;

  return Math.hypot(clientX - x, clientY - y);
}

function getScreenPoint(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  rect: DOMRect
): { x: number; y: number; z: number } {
  const projected = point.clone().project(camera);

  return {
    x: rect.left + (projected.x + 1) * rect.width / 2,
    y: rect.top + (1 - projected.y) * rect.height / 2,
    z: projected.z,
  };
}

function getPickScreenThreshold(object: THREE.Object3D): number {
  return object instanceof THREE.Points ? SATELLITE_PICK_SCREEN_THRESHOLD_PX : SPRITE_PICK_SCREEN_THRESHOLD_PX;
}

function getLabelPickCandidates(
  pickables: THREE.Object3D[],
  camera: THREE.PerspectiveCamera,
  rect: DOMRect,
  clientX: number,
  clientY: number
): PickCandidate[] {
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const candidates: PickCandidate[] = [];

  for (const object of pickables) {
    const pickBox = object.userData.pickBox as { width: number; height: number } | undefined;
    if (!pickBox) continue;

    const point = getObjectPosition(object);
    if (!point || isOccludedByEarth(point, camera)) continue;

    const screenPoint = getScreenPoint(point, camera, rect);
    if (screenPoint.z < -1 || screenPoint.z > 1) continue;

    const dx = clientX - screenPoint.x;
    const dy = clientY - screenPoint.y;
    if (Math.abs(dx) > pickBox.width / 2 || Math.abs(dy) > pickBox.height / 2) continue;

    candidates.push({
      object,
      distance: cameraPosition.distanceTo(point),
      screenDistance: Math.hypot(dx, dy),
      priority: 0,
    });
  }

  return candidates;
}

function makeOrbitPreview(
  selectedSatellite: SatellitePosition,
  orbitPath: SatellitePath
): THREE.Group {
  const group = new THREE.Group();
  const points = orbitPath.fullPath.length > 1
    ? orbitPath.fullPath
    : orbitPath.path.flat();

  if (points.length < 2) return group;

  const orbitAltitude = Math.max(selectedSatellite.altitude, 420);
  const currentVector = latLonAltitudeToVector(
    selectedSatellite.latitude,
    selectedSatellite.longitude,
    orbitAltitude,
    0.018
  );
  const vectors = points.map(([latitude, longitude]) =>
    latLonAltitudeToVector(latitude, longitude, orbitAltitude, 0.018)
  );
  vectors[0] = currentVector;
  for (let index = 0; index < vectors.length - 1; index += 1) {
    const progress = index / Math.max(vectors.length - 2, 1);
    const curve = new THREE.LineCurve3(vectors[index], vectors[index + 1]);
    const color = getOrbitPredictionColor(progress);
    const fade = Math.pow(1 - progress, 1.9);
    const glow = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 3, 0.0065, 8, false),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.24 * fade + 0.02,
        depthTest: true,
        depthWrite: false,
      })
    );
    const line = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 3, 0.0014, 8, false),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.78 * fade + 0.04,
        depthTest: true,
        depthWrite: false,
      })
    );

    group.add(glow, line);
  }

  for (let minutes = 15; minutes <= 90; minutes += 15) {
    const point = points[Math.min(Math.round(minutes / 2), points.length - 1)];

    if (!point) continue;

    const progress = minutes / 90;
    const color = getOrbitPredictionColor(progress);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.0065, 14, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: Math.max(0.3, 0.82 - progress * 0.58),
        depthTest: true,
        depthWrite: false,
      })
    );

    marker.position.copy(
      latLonAltitudeToVector(point[0], point[1], orbitAltitude, 0.018)
    );
    group.add(marker);
  }

  return group;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;
    const maybeGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const maybeMaterial = mesh.material as THREE.Material | THREE.Material[] | undefined;

    maybeGeometry?.dispose();
    if (Array.isArray(maybeMaterial)) {
      maybeMaterial.forEach((material) => material.dispose());
    } else {
      const materialWithMap = maybeMaterial as (THREE.Material & { map?: THREE.Texture }) | undefined;
      if (child.userData.disposeMap) {
        materialWithMap?.map?.dispose();
      }
      maybeMaterial?.dispose();
    }
  });
}

function Earth3DView({
  starlinkPositions,
  stationPositions,
  additionalPositions,
  satellitePaths,
  selectedSatellite,
  selectedSatelliteName,
  showStarlink,
  showStations,
  showAdditionalGroups,
  additionalGroups,
  positionVersion,
  earthRotationEnabled,
  dayNightEnabled,
  onSelectSatellite,
  onFollowSatellite,
}: Earth3DViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const earthFixedRootRef = useRef<THREE.Group | null>(null);
  const satelliteRootRef = useRef<THREE.Group | null>(null);
  const selectedRootRef = useRef<THREE.Group | null>(null);
  const sunUniformRef = useRef<THREE.Uniform<THREE.Vector3> | null>(null);
  const dayNightUniformRef = useRef<THREE.Uniform<number> | null>(null);
  const stationIconTextureRef = useRef<THREE.Texture | null>(null);
  const pickablesRef = useRef<THREE.Object3D[]>([]);
  const starlinkPointsRef = useRef<THREE.Points | null>(null);
  const stationSpriteSetRef = useRef<StationSpriteSet | null>(null);
  const additionalPointsRef = useRef(new Map<string, THREE.Points>());
  const selectedRingRef = useRef<THREE.Mesh | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const pointerDraggedRef = useRef(false);
  const earthRotationEnabledRef = useRef(earthRotationEnabled);

  const additionalColorMap = useMemo(
    () => new Map(additionalGroups.map((group) => [group.id, colorToCss(group.color)])),
    [additionalGroups]
  );

  const visibleAdditionalPositions = useMemo(
    () => additionalPositions.filter((sat) => showAdditionalGroups[sat.groupId]),
    [additionalPositions, showAdditionalGroups, positionVersion]
  );

  const starlinkStructureKey = makePositionsKey(starlinkPositions);
  const stationStructureKey = makePositionsKey(stationPositions);
  const additionalStructureKey = Array.from(groupAdditionalPositions(visibleAdditionalPositions))
    .map(([groupId, positions]) => `${groupId}:${makePositionsKey(positions)}`)
    .sort()
    .join("|");
  const selectedOrbitKey = selectedSatellite ? selectedSatellite.name : "";
  const selectedOrbitPositionKey = selectedSatellite
    ? [
      selectedSatellite.name,
      selectedSatellite.latitude.toFixed(2),
      selectedSatellite.longitude.toFixed(2),
      selectedSatellite.altitude.toFixed(1),
    ].join(":")
    : "";

  useEffect(() => {
    earthRotationEnabledRef.current = earthRotationEnabled;
  }, [earthRotationEnabled]);

  useEffect(() => {
    if (dayNightUniformRef.current) {
      dayNightUniformRef.current.value = dayNightEnabled ? 1 : 0;
    }
  }, [dayNightEnabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#020713");
    scene.fog = new THREE.Fog("#020713", 4.5, 9);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);
    camera.position.set(0.35, 0.58, 2.25);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.35;
    controls.maxDistance = 9;
    controls.rotateSpeed = 0.45;
    controls.zoomSpeed = 0.8;

    const earthFixedRoot = new THREE.Group();
    scene.add(earthFixedRoot);

    const textureLoader = new THREE.TextureLoader();
    const dayTexture = loadEarthTexture(textureLoader, EARTH_TEXTURES.day);
    const lightsTexture = loadEarthTexture(textureLoader, EARTH_TEXTURES.lights);
    const normalTexture = loadEarthTexture(textureLoader, EARTH_TEXTURES.normal, false);
    const specularTexture = loadEarthTexture(textureLoader, EARTH_TEXTURES.specular, false);
    const cloudsTexture = loadEarthTexture(textureLoader, EARTH_TEXTURES.clouds);
    const stationIconTexture = textureLoader.load(STATION_ICON_URL);
    stationIconTexture.colorSpace = THREE.SRGBColorSpace;
    stationIconTexture.minFilter = THREE.LinearFilter;
    stationIconTexture.magFilter = THREE.LinearFilter;
    stationIconTextureRef.current = stationIconTexture;
    const earthTextures = [
      dayTexture,
      lightsTexture,
      normalTexture,
      specularTexture,
      cloudsTexture,
      stationIconTexture,
    ];
    const sunDirection = getSunDirection(new Date());
    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayTexture: { value: dayTexture },
        lightsTexture: { value: lightsTexture },
        normalTexture: { value: normalTexture },
        specularTexture: { value: specularTexture },
        sunDirection: { value: sunDirection.clone() },
        cameraPositionUniform: { value: camera.position },
        dayNightMix: { value: dayNightEnabled ? 1 : 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        void main() {
          vUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D dayTexture;
        uniform sampler2D lightsTexture;
        uniform sampler2D normalTexture;
        uniform sampler2D specularTexture;
        uniform vec3 sunDirection;
        uniform vec3 cameraPositionUniform;
        uniform float dayNightMix;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        void main() {
          vec3 base = texture2D(dayTexture, vUv).rgb;
          vec3 cityLights = texture2D(lightsTexture, vUv).rgb;
          vec3 normalSample = texture2D(normalTexture, vUv).rgb * 2.0 - 1.0;
          float oceanMask = texture2D(specularTexture, vUv).r;
          vec3 normal = normalize(vWorldNormal + normalSample * 0.08);
          vec3 sun = normalize(sunDirection);
          vec3 viewDirection = normalize(cameraPositionUniform - vWorldPosition);
          vec3 halfVector = normalize(sun + viewDirection);
          float sunlight = dot(normal, sun);
          float shadedDayAmount = smoothstep(-0.28, 0.22, sunlight);
          float shadedNightAmount = 1.0 - smoothstep(-0.34, 0.04, sunlight);
          float dayAmount = mix(1.0, shadedDayAmount, dayNightMix);
          float nightAmount = shadedNightAmount * dayNightMix;
          float specular = pow(max(dot(normal, halfVector), 0.0), 42.0) * oceanMask * dayAmount * 0.42;
          vec3 brightBase = base * vec3(1.18, 1.14, 1.08);
          vec3 nightBase = base * vec3(0.035, 0.065, 0.12);
          vec3 lights = cityLights * vec3(1.8, 1.45, 1.05) * nightAmount * 1.55;
          vec3 atmosphere = vec3(0.22, 0.55, 1.0) * pow(max(0.0, 1.0 - dot(normal, viewDirection)), 2.2) * 0.25;
          vec3 shadedColor = mix(nightBase + lights, base, dayAmount) + atmosphere + vec3(specular);
          vec3 color = mix(brightBase + atmosphere * 0.45, shadedColor, dayNightMix);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    sunUniformRef.current = earthMaterial.uniforms.sunDirection as THREE.Uniform<THREE.Vector3>;
    dayNightUniformRef.current = earthMaterial.uniforms.dayNightMix as THREE.Uniform<number>;

    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_SCENE_RADIUS, 128, 64),
      earthMaterial
    );
    earthFixedRoot.add(earth);

    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_SCENE_RADIUS * 1.012, 128, 64),
      new THREE.MeshPhongMaterial({
        map: cloudsTexture,
        color: "#ffffff",
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        blending: THREE.NormalBlending,
      })
    );
    earthFixedRoot.add(clouds);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_SCENE_RADIUS * 1.035, 96, 48),
      new THREE.MeshBasicMaterial({
        color: "#58c8ff",
        transparent: true,
        opacity: 0.13,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    earthFixedRoot.add(atmosphere);

    const sunlight = new THREE.DirectionalLight("#ffffff", 1.8);
    sunlight.position.copy(sunDirection.multiplyScalar(4));
    scene.add(sunlight);
    scene.add(new THREE.AmbientLight("#7ba8ff", 0.28));

    const stars = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: "#dcecff", size: 1, sizeAttenuation: false, transparent: true, opacity: 0.55 })
    );
    const starCoordinates = new Float32Array(900);
    for (let index = 0; index < starCoordinates.length; index += 3) {
      const vector = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize().multiplyScalar(12);
      starCoordinates[index] = vector.x;
      starCoordinates[index + 1] = vector.y;
      starCoordinates[index + 2] = vector.z;
    }
    stars.geometry.setAttribute("position", new THREE.BufferAttribute(starCoordinates, 3));
    scene.add(stars);

    const satelliteRoot = new THREE.Group();
    const selectedRoot = new THREE.Group();
    earthFixedRoot.add(satelliteRoot, selectedRoot);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    earthFixedRootRef.current = earthFixedRoot;
    satelliteRootRef.current = satelliteRoot;
    selectedRootRef.current = selectedRoot;

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let animationId = 0;
    const animate = () => {
      const nextSunDirection = getSunDirection(new Date());
      sunUniformRef.current?.value.copy(nextSunDirection);
      sunlight.position.copy(nextSunDirection.multiplyScalar(4));
      if (earthRotationEnabledRef.current) {
        earthFixedRoot.rotation.y += 0.00008;
        clouds.rotation.y += 0.00005;
      }
      controls.update();
      updateStationScreenScales(stationSpriteSetRef.current, camera, renderer);
      renderer.render(scene, camera);
      animationId = requestAnimationFrame(animate);
    };
    animationId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(scene);
      earthTextures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const satelliteRoot = satelliteRootRef.current;
    if (!satelliteRoot) return;

    satelliteRoot.children.forEach(disposeObject);
    satelliteRoot.clear();
    pickablesRef.current = [];
    starlinkPointsRef.current = null;
    stationSpriteSetRef.current = null;
    additionalPointsRef.current.clear();

    if (showStarlink) {
      const starlinks = makeSatellitePoints(starlinkPositions, "#ffe95a", 2.35);
      satelliteRoot.add(starlinks);
      pickablesRef.current.push(starlinks);
      starlinkPointsRef.current = starlinks;
    }

    if (showStations) {
      const stationSprites = makeStationSprites(
        stationPositions,
        stationIconTextureRef.current ?? getSatellitePointTexture()
      );
      satelliteRoot.add(stationSprites.group);
      pickablesRef.current.push(...stationSprites.pickables);
      stationSpriteSetRef.current = stationSprites;
    }

    const grouped = groupAdditionalPositions(visibleAdditionalPositions);

    for (const [groupId, positions] of grouped) {
      const points = makeSatellitePoints(
        positions,
        additionalColorMap.get(groupId) ?? "#ffffff",
        3.1
      );
      satelliteRoot.add(points);
      pickablesRef.current.push(points);
      additionalPointsRef.current.set(groupId, points);
    }
  }, [
    showStarlink,
    showStations,
    additionalColorMap,
    starlinkStructureKey,
    stationStructureKey,
    additionalStructureKey,
  ]);

  useEffect(() => {
    if (showStarlink && starlinkPointsRef.current) {
      updateSatellitePointPositions(starlinkPointsRef.current, starlinkPositions);
    }

    if (showStations && stationSpriteSetRef.current) {
      updateStationSprites(stationSpriteSetRef.current, stationPositions);
    }

    const grouped = groupAdditionalPositions(visibleAdditionalPositions);
    for (const [groupId, points] of additionalPointsRef.current) {
      const positions = grouped.get(groupId);
      if (positions) updateSatellitePointPositions(points, positions);
    }

    if (selectedSatellite && selectedRingRef.current) {
      selectedRingRef.current.position.copy(
        latLonAltitudeToVector(
          selectedSatellite.latitude,
          selectedSatellite.longitude,
          selectedSatellite.altitude,
          0.018
        )
      );
    }
  }, [
    starlinkPositions,
    stationPositions,
    visibleAdditionalPositions,
    showStarlink,
    showStations,
    selectedSatellite,
    positionVersion,
  ]);

  useEffect(() => {
    const selectedRoot = selectedRootRef.current;
    if (!selectedRoot) return;

    selectedRoot.children.forEach(disposeObject);
    selectedRoot.clear();
    selectedRingRef.current = null;
    if (!selectedSatellite) return;

    const position = latLonAltitudeToVector(
      selectedSatellite.latitude,
      selectedSatellite.longitude,
      selectedSatellite.altitude,
      0.018
    );
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(0.026, 24, 12),
      new THREE.MeshBasicMaterial({
        color: "#31d7ff",
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    ring.position.copy(position);
    selectedRoot.add(ring);
    selectedRingRef.current = ring;

    const orbitPath = satellitePaths.find((path) => path.name === selectedSatellite.name);
    if (orbitPath) {
      selectedRoot.add(makeOrbitPreview(selectedSatellite, orbitPath));
    }
  }, [selectedOrbitKey, selectedOrbitPositionKey, selectedSatelliteName, satellitePaths]);

  const pickSatellite = (event: MouseEvent<HTMLDivElement>, follow: boolean) => {
    if (pointerDraggedRef.current) {
      pointerDraggedRef.current = false;
      pointerDownRef.current = null;
      return;
    }

    const container = containerRef.current;
    const camera = cameraRef.current;
    if (!container || !camera) return;

    const rect = container.getBoundingClientRect();
    pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = raycasterRef.current;
    raycaster.params.Points.threshold = SATELLITE_PICK_WORLD_THRESHOLD;
    raycaster.setFromCamera(pointerRef.current, camera);
    const intersections = raycaster.intersectObjects(pickablesRef.current, false);
    const visibleHits = intersections.flatMap((intersection) => {
      const point = getObjectPosition(intersection.object, intersection.index);
      if (!point || isOccludedByEarth(point, camera)) return [];

      const screenDistance = getScreenDistance(point, camera, rect, event.clientX, event.clientY);
      if (screenDistance > getPickScreenThreshold(intersection.object)) return [];

      return [{
        object: intersection.object,
        index: intersection.index,
        distance: intersection.distance,
        screenDistance,
        priority: 1,
      } satisfies PickCandidate];
    });
    const visibleHit = [
      ...getLabelPickCandidates(pickablesRef.current, camera, rect, event.clientX, event.clientY),
      ...visibleHits,
    ].sort(
      (a, b) =>
        a.priority - b.priority ||
        a.screenDistance - b.screenDistance ||
        a.distance - b.distance
    )[0];

    if (!visibleHit) {
      onSelectSatellite(null);
      if (follow) onFollowSatellite(null);
      return;
    }

    const target = visibleHit.object.userData.pickTarget as PickTarget | undefined;
    const name =
      typeof visibleHit.object.userData.pickName === "string"
        ? visibleHit.object.userData.pickName
        : visibleHit.index === undefined
          ? null
          : target?.names[visibleHit.index] ?? null;
    onSelectSatellite(name);
    if (follow) onFollowSatellite(name);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointerDownRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    pointerDraggedRef.current = false;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerDownRef.current;
    if (!start) return;

    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > 6) {
      pointerDraggedRef.current = true;
    }
  };

  const handlePointerUp = () => {
    pointerDownRef.current = null;
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(event) => pickSatellite(event, false)}
      onDoubleClick={(event) => pickSatellite(event, true)}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background:
          "radial-gradient(circle at 50% 45%, rgba(30,80,130,0.24), rgba(2,7,19,1) 62%)",
      }}
    />
  );
}

export default Earth3DView;
