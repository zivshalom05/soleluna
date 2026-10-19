// The 3D tour. Everything is built from primitives in code (no model files),
// and the page's scroll position drives the camera through a list of stations:
// outside the tower → through the glass doors → lobby → elevator (white flash)
// → apartment living room → kitchen → master bedroom → balcony view.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const canvas = document.getElementById("scene");
const loader = document.getElementById("loader");
const fadeEl = document.getElementById("fade");
const labelsEl = document.getElementById("labels");
const journey = document.getElementById("journey");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = matchMedia("(max-width: 760px)").matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: "high-performance" });
} catch {
  document.body.classList.add("no-webgl");
  loader.classList.add("is-done");
  throw new Error("WebGL unavailable — showing the static page");
}
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

/* ================================================================ helpers */

const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...opts });
const glow = (color, intensity = 2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity });
const glass = (color = "#a9c3d6", opacity = 0.18) =>
  new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 0.05, metalness: 0.2, depthWrite: false });

// box placed by its bottom face: (x, yBottom, z)
function box(w, h, d, mat, x, y, z, parent = scene) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}
function rbox(w, h, d, r, mat, x, y, z, parent = scene) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}
function cyl(rTop, rBot, h, mat, x, y, z, parent = scene, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + rand() * (b - a);

/* ================================================================ textures */

const woodFloorTex = canvasTexture(512, 512, (g, w, h) => {
  const rows = 8;
  for (let i = 0; i < rows; i++) {
    for (let x = -((i % 2) * 128); x < w; x += 256) {
      const l = 58 + Math.random() * 10;
      g.fillStyle = `hsl(30, 38%, ${l}%)`;
      g.fillRect(x, (i * h) / rows, 256, h / rows);
      g.strokeStyle = "rgba(60,35,15,0.25)";
      g.strokeRect(x, (i * h) / rows, 256, h / rows);
      for (let k = 0; k < 6; k++) {
        g.strokeStyle = `rgba(90,55,25,${0.05 + Math.random() * 0.08})`;
        g.beginPath();
        const yy = (i * h) / rows + Math.random() * (h / rows);
        g.moveTo(x, yy);
        g.bezierCurveTo(x + 80, yy + 4, x + 170, yy - 4, x + 256, yy);
        g.stroke();
      }
    }
  }
});
woodFloorTex.wrapS = woodFloorTex.wrapT = THREE.RepeatWrapping;
woodFloorTex.repeat.set(5, 2.5);

const facadeTex = canvasTexture(256, 512, (g, w, h) => {
  g.fillStyle = "#d9d4cb";
  g.fillRect(0, 0, w, h);
  const cols = 5, rows = 12;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const lit = Math.random() < 0.18;
      g.fillStyle = lit ? "#f3d9a8" : `hsl(210, 22%, ${26 + Math.random() * 12}%)`;
      g.fillRect(c * (w / cols) + 8, r * (h / rows) + 8, w / cols - 16, h / rows - 14);
    }
});

function artTexture(palette) {
  return canvasTexture(512, 340, (g, w, h) => {
    g.fillStyle = palette[0];
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      g.fillStyle = palette[1 + (i % (palette.length - 1))];
      g.globalAlpha = 0.85;
      g.beginPath();
      g.arc(Math.random() * w, Math.random() * h, 30 + Math.random() * 120, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  });
}

/* ================================================================ sky, light, ground */

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1200, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color("#5f8fc4") },
      horizon: { value: new THREE.Color("#f4d6b4") },
      bottom: { value: new THREE.Color("#cdbfa9") },
    },
    vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader:
      "uniform vec3 top, horizon, bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, pow(-h, 0.4)); gl_FragColor = vec4(c, 1.0); }",
  })
);
sky.renderOrder = -1;
scene.add(sky);
scene.fog = new THREE.Fog("#e8d8c4", 160, 900);

scene.add(new THREE.HemisphereLight("#dbe7f5", "#b8a58b", 1.1));
const sun = new THREE.DirectionalLight("#ffe0b8", 2.6);
sun.position.set(-70, 90, 80);
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), M("#c9c0ae", { roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const treeTrunk = M("#6b5442");
const treeLeaf = M("#5f7f4d", { flatShading: true, roughness: 0.9 });
const treeLeaf2 = M("#7a9258", { flatShading: true, roughness: 0.9 });
const crownGeo = new THREE.IcosahedronGeometry(1, 1);
function tree(x, z, s = 1, parent = scene) {
  cyl(0.12 * s, 0.18 * s, 2.2 * s, treeTrunk, x, 0, z, parent, 8);
  const c = new THREE.Mesh(crownGeo, rand() < 0.5 ? treeLeaf : treeLeaf2);
  c.scale.setScalar(1.6 * s);
  c.position.set(x, 3.2 * s, z);
  c.rotation.set(rand() * 3, rand() * 3, 0);
  parent.add(c);
}

const cityMats = ["#d8d1c5", "#cfc8bd", "#e3ddd2", "#bfc4c8", "#c9bfb0"].map((c) => M(c, { map: facadeTex, roughness: 0.8 }));
function cityBlock(x, z, w, d, h) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), cityMats[Math.floor(rand() * cityMats.length)]);
  m.position.set(x, h / 2, z);
  scene.add(m);
}

/* ================================================================ the tower */

const T = { half: 9, lobbyH: 4.5, floorH: 3.3, floors: 12 };
const towerTop = T.lobbyH + T.floors * T.floorH;
const slabMat = M("#efebe3", { roughness: 0.6 });
const stoneMat = M("#d6cbb8", { roughness: 0.55 });
const mullionMat = M("#2b2f36", { roughness: 0.4, metalness: 0.6 });
const towerGlass = M("#29405e", { roughness: 0.06, metalness: 0.95, envMapIntensity: 1.4 });

// glass core of the upper floors
box(17.4, towerTop - T.lobbyH, 17.4, towerGlass, 0, T.lobbyH, 0);

// floor slabs (one instanced mesh)
{
  const geo = new THREE.BoxGeometry(18.6, 0.38, 18.6);
  const slabs = new THREE.InstancedMesh(geo, slabMat, T.floors + 1);
  const mtx = new THREE.Matrix4();
  for (let i = 0; i <= T.floors; i++) {
    mtx.makeTranslation(0, T.lobbyH + i * T.floorH, 0);
    slabs.setMatrixAt(i, mtx);
  }
  scene.add(slabs);
}

// vertical mullions on all four faces
{
  const per = 8;
  const geo = new THREE.BoxGeometry(0.16, towerTop - T.lobbyH, 0.3);
  const inst = new THREE.InstancedMesh(geo, mullionMat, per * 4);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const yMid = (towerTop + T.lobbyH) / 2;
  let n = 0;
  for (let f = 0; f < 4; f++) {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (f * Math.PI) / 2);
    for (let i = 0; i < per; i++) {
      const along = -7.6 + (i * 15.2) / (per - 1);
      const p = new THREE.Vector3(along, yMid, 8.75).applyQuaternion(q);
      mtx.compose(p, q, s);
      inst.setMatrixAt(n++, mtx);
    }
  }
  scene.add(inst);
}

// lit windows scattered on the glass so the tower feels inhabited
{
  const geo = new THREE.PlaneGeometry(1.7, 2.4);
  const inst = new THREE.InstancedMesh(geo, glow("#ffd8a0", 1.2), 70);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  for (let n = 0; n < 70; n++) {
    const f = Math.floor(rand() * 4);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (f * Math.PI) / 2);
    const col = Math.floor(rand() * 7);
    const along = -6.5 + col * 2.17;
    const y = T.lobbyH + Math.floor(rand() * T.floors) * T.floorH + 1.6;
    const p = new THREE.Vector3(along, y, 8.71).applyQuaternion(q);
    mtx.compose(p, q, s);
    inst.setMatrixAt(n, mtx);
  }
  scene.add(inst);
}

// staggered front balconies
for (let i = 1; i < T.floors; i++) {
  const x = i % 2 ? -4.5 : 4.5;
  const y = T.lobbyH + i * T.floorH;
  box(8, 0.32, 2.2, slabMat, x, y - 0.16, 10.1);
  box(8, 1.05, 0.05, glass("#cfe0ea", 0.35), x, y + 0.16, 11.17);
  box(8, 0.05, 0.08, mullionMat, x, y + 1.2, 11.17);
}

// crown + roof terrace frame for the penthouses
box(18.6, 0.6, 18.6, slabMat, 0, towerTop, 0);
box(12, 2.6, 12, stoneMat, 0, towerTop + 0.6, -2);
box(18.6, 0.4, 0.4, slabMat, 0, towerTop + 3.4, 9.1);
for (const x of [-9.1, 9.1]) box(0.4, 3.8, 0.4, slabMat, x, towerTop, 9.1);

// stone columns at the lobby corners
for (const x of [-8.7, 8.7]) for (const z of [-8.7, 8.7]) box(0.9, T.lobbyH, 0.9, stoneMat, x, 0, z);

/* ================================================================ site around the tower */

box(60, 0.06, 40, M("#ddd4c4", { roughness: 0.8 }), 0, 0, 12); // plaza paving
box(400, 0.05, 12, M("#5c5f66", { roughness: 0.9 }), 0, 0, 42); // road
for (let x = -190; x < 190; x += 8) box(3, 0.06, 0.25, M("#e8e2d5"), x, 0.02, 42);
box(26, 0.08, 18, M("#8aa36b", { roughness: 1 }), -24, 0, 14); // private garden lawn
box(26, 0.08, 18, M("#8aa36b", { roughness: 1 }), 24, 0, 6);
for (let i = 0; i < 16; i++) tree(-24 + rr(-11, 11), 14 + rr(-7, 7), rr(0.8, 1.2));
for (let i = 0; i < 10; i++) tree(24 + rr(-11, 11), 6 + rr(-7, 7), rr(0.8, 1.2));
for (let x = -60; x <= 60; x += 9) tree(x, 35.5, 0.9);
// entrance planters
for (const x of [-4, 4]) {
  box(2, 0.6, 2, stoneMat, x, 0, 13);
  tree(x, 13, 0.6);
}

// neighbouring buildings, kept clear of the camera path
for (let i = 0; i < 46; i++) {
  const x = rr(-220, 220), z = rr(-220, 30);
  if (Math.abs(x) < 45 && z > -60) continue;
  cityBlock(x, z, rr(10, 22), rr(10, 22), rr(8, 34));
}

/* ================================================================ lobby (inside the tower podium) */

const lobby = new THREE.Group();
scene.add(lobby);
const LH = T.lobbyH;

const lobbyFloor = new THREE.Mesh(new THREE.PlaneGeometry(17.4, 17.4), M("#ebe6dc", { roughness: 0.12, metalness: 0.05 }));
lobbyFloor.rotation.x = -Math.PI / 2;
lobbyFloor.position.y = 0.07;
lobby.add(lobbyFloor);
const lobbyCeil = new THREE.Mesh(new THREE.PlaneGeometry(17.4, 17.4), M("#f3f0ea"));
lobbyCeil.rotation.x = Math.PI / 2;
lobbyCeil.position.y = LH - 0.2;
lobby.add(lobbyCeil);
for (let x = -6; x <= 6; x += 3) for (let z = -6; z <= 6; z += 3) {
  const d = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), glow("#fff3df", 3));
  d.rotation.x = Math.PI / 2;
  d.position.set(x, LH - 0.21, z);
  lobby.add(d);
}

const woodWall = M("#8b6a4e", { roughness: 0.55 });
box(17.4, LH, 0.2, woodWall, 0, 0, -8.8, lobby); // back wall (elevators)
box(0.2, LH, 17.4, glass(), -8.7, 0, 0, lobby);
box(0.2, LH, 17.4, glass(), 8.7, 0, 0, lobby);
// front glazing with a door opening in the middle
box(7.2, LH, 0.08, glass(), -5.1, 0, 8.7, lobby);
box(7.2, LH, 0.08, glass(), 5.1, 0, 8.7, lobby);
box(3, LH - 3, 0.08, glass(), 0, 3, 8.7, lobby);
box(3.2, 0.12, 0.2, mullionMat, 0, 3, 8.7, lobby);
for (const x of [-1.55, 1.55]) box(0.1, 3, 0.2, mullionMat, x, 0, 8.7, lobby);
const doorL = box(1.5, 3, 0.05, glass("#bcd3e0", 0.3), -0.75, 0, 8.78, lobby);
const doorR = box(1.5, 3, 0.05, glass("#bcd3e0", 0.3), 0.75, 0, 8.78, lobby);

// elevators: bright cab behind brushed steel doors
const elevatorLeaves = [];
for (const ex of [-1.7, 1.7]) {
  box(1.7, 2.9, 0.06, mullionMat, ex, 0, -8.68, lobby);
  box(1.2, 2.5, 0.02, glow("#fff4e2", 1.6), ex, 0.05, -8.64, lobby);
  for (const side of [-1, 1]) {
    const leaf = box(0.6, 2.5, 0.04, M("#c9c3b8", { metalness: 0.9, roughness: 0.28 }), ex + side * 0.3, 0.05, -8.6, lobby);
    leaf.userData = { x0: ex + side * 0.3, side };
    elevatorLeaves.push(leaf);
  }
  box(0.2, 0.08, 0.02, glow("#ffb547", 2), ex, 2.75, -8.62, lobby); // floor indicator
}
for (const [x, pal] of [[-5.6, ["#efe6d6", "#c47a4f", "#2f4b63", "#d9b27c"]], [5.6, ["#e7e1d3", "#5f7f6c", "#d19a66", "#283244"]]]) {
  box(3.4, 2.2, 0.05, M("#ffffff", { map: artTexture(pal), roughness: 0.8 }), x, 1.1, -8.66, lobby);
}

// reception
box(4.2, 1.1, 1, M("#f1ece3", { roughness: 0.3 }), -4.6, 0, -3.2, lobby);
box(4.4, 0.06, 1.2, M("#2a2a2c", { roughness: 0.15, metalness: 0.3 }), -4.6, 1.1, -3.2, lobby);
box(5.2, 3.4, 0.16, woodWall, -4.6, 0, -6, lobby);
const logoRing = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 12, 48), glow("#d9b27c", 1.4));
logoRing.position.set(-4.6, 2.3, -5.9);
lobby.add(logoRing);

// waiting lounge
const velvet = M("#36475e", { roughness: 0.85 });
rbox(3, 0.45, 1, 0.12, velvet, 4.8, 0, -0.4, lobby);
rbox(3, 0.55, 0.3, 0.12, velvet, 4.8, 0.4, -0.85, lobby);
for (const z of [2.6]) for (const x of [3.8, 5.8]) rbox(0.95, 0.75, 0.95, 0.15, M("#c8a27a", { roughness: 0.8 }), x, 0, z, lobby);
cyl(0.55, 0.55, 0.42, M("#2a2a2c", { roughness: 0.2, metalness: 0.4 }), 4.8, 0, 1.1, lobby);
box(5, 0.01, 4.4, M("#b9ad9a", { roughness: 1 }), 4.8, 0.08, 1, lobby);
for (const [x, z] of [[-7.6, -7.6], [7.6, -7.6], [-7.6, 7.4], [7.6, 7.4]]) {
  cyl(0.45, 0.35, 0.9, M("#e9e4da", { roughness: 0.4 }), x, 0, z, lobby);
  tree(x, z, 0.45, lobby);
}

// ring chandelier
const chandelier = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.05, 12, 96), glow("#ffe2b0", 2.2));
chandelier.rotation.x = Math.PI / 2;
chandelier.position.set(0, 3.5, 0);
lobby.add(chandelier);
const lobbyLight = new THREE.PointLight("#ffd9a8", 60, 22, 2);
lobbyLight.position.set(0, 3.3, 0);
lobby.add(lobbyLight);

/* ================================================================ the apartment (floor 9) */
// Built away from the tower so its view can be a proper city/park/sea panorama.

const A = new THREE.Vector3(400, 30, 0);
const apt = new THREE.Group();
apt.position.copy(A);
scene.add(apt);
const H = 2.9;

const wallMat = M("#efebe4", { roughness: 0.9 });
const oak = M("#ffffff", { map: woodFloorTex, roughness: 0.55 });
const quartz = M("#f3f1ec", { roughness: 0.18 });
const sage = M("#56665a", { roughness: 0.55 });
const darkMetal = M("#1f2125", { roughness: 0.35, metalness: 0.7 });
const linen = M("#cfc6b8", { roughness: 0.95 });

box(20, 0.2, 10, oak, 3, -0.2, 0, apt); // floor x: -7..13, z: -5..5
box(20, 0.2, 10, wallMat, 3, H, 0, apt); // ceiling
box(20, H, 0.2, wallMat, 3, 0, -5.1, apt); // back wall
box(0.2, H, 10, wallMat, -7.1, 0, 0, apt);
box(0.2, H, 10, wallMat, 13.1, 0, 0, apt);

// window wall with an open slider (x 2..7) onto the balcony
box(9, H, 0.04, glass("#b9d0de", 0.1), -2.5, 0, 5, apt);
box(6, H, 0.04, glass("#b9d0de", 0.1), 10, 0, 5, apt);
box(20, 0.12, 0.12, darkMetal, 3, H - 0.12, 5, apt);
box(20, 0.06, 0.12, darkMetal, 3, 0, 5, apt);
for (const x of [-7, -4.5, -2, 0.5, 2, 7, 9, 11, 13]) box(0.07, H, 0.12, darkMetal, x, 0, 5, apt);
box(2.6, H, 0.04, glass("#b9d0de", 0.14), 6.6, 0, 5.1, apt); // the slid-open panel

// partition to the master bedroom (x = 7), opening near the windows
box(0.15, H, 6.5, wallMat, 7, 0, -1.75, apt);
box(0.15, 0.45, 3.5, wallMat, 7, H - 0.45, 3.25, apt);

// --- living room
box(4.4, 0.012, 3.2, linen, -3.5, 0, 0.9, apt);
const sofaMat = M("#b5ab9c", { roughness: 0.95 });
rbox(3, 0.42, 1, 0.1, sofaMat, -3.5, 0.05, -0.55, apt);
rbox(3, 0.6, 0.28, 0.1, sofaMat, -3.5, 0.35, -0.95, apt);
for (const x of [-4.95, -2.05]) rbox(0.25, 0.62, 1, 0.08, sofaMat, x, 0.05, -0.55, apt);
for (const x of [-4.3, -3.5, -2.7]) rbox(0.6, 0.4, 0.14, 0.06, M("#8e9a86", { roughness: 1 }), x, 0.55, -0.7, apt);
cyl(0.55, 0.55, 0.06, M("#e7e2d9", { roughness: 0.15 }), -3.5, 0.36, 1.1, apt, 40);
cyl(0.08, 0.2, 0.36, darkMetal, -3.5, 0, 1.1, apt, 16);
rbox(0.9, 0.75, 0.9, 0.12, M("#9a6b4a", { roughness: 0.6 }), -5.7, 0.02, 1.9, apt).rotation.y = 0.6;
box(0.5, 0.5, 3, M("#6d5240", { roughness: 0.5 }), -6.75, 0, 0.6, apt); // media console
box(0.06, 0.9, 1.6, M("#0e0f11", { roughness: 0.2, metalness: 0.5 }), -6.95, 1.05, 0.6, apt); // TV
box(2.6, 1.5, 0.04, M("#ffffff", { map: artTexture(["#efe8dc", "#c98b5a", "#3f5a70", "#e3c58f"]) }), -3.5, 1.2, -4.98, apt);
cyl(0.015, 0.015, 1.6, darkMetal, -6, 0, -1.4, apt, 8); // floor lamp
cyl(0.18, 0.28, 0.32, glow("#ffe6c2", 1.1), -6, 1.55, -1.4, apt);
cyl(0.35, 0.28, 0.7, M("#e9e4da"), -6.3, 0, 4.2, apt);
tree(-6.3, 4.2, 0.5, apt);

// --- dining
box(1.9, 0.05, 0.95, M("#7a5a43", { roughness: 0.45 }), 0.3, 0.72, -2.7, apt);
for (const [x, z] of [[-0.5, -3.1], [1.1, -3.1], [-0.5, -2.3], [1.1, -2.3]]) cyl(0.03, 0.03, 0.72, darkMetal, x, 0, z, apt, 6);
for (const x of [-0.25, 0.85]) for (const z of [-3.45, -1.95]) rbox(0.45, 0.85, 0.45, 0.06, M("#d9cfbf"), x, 0, z, apt);
const diningLamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), glow("#fff0d6", 1.4));
diningLamp.position.set(0.3, 1.9, -2.7);
apt.add(diningLamp);

// --- kitchen
box(4.6, 0.9, 0.6, sage, 3.3, 0, -4.7, apt); // base cabinets
box(4.7, 0.05, 0.65, quartz, 3.3, 0.9, -4.68, apt);
box(4.6, 0.85, 0.02, M("#d8d0c3", { roughness: 0.3 }), 3.3, 0.95, -4.98, apt); // backsplash
box(4.6, 1.0, 0.4, sage, 3.3, 1.9, -4.8, apt); // uppers to the ceiling
box(0.7, 0.02, 0.5, M("#111111", { roughness: 0.2 }), 2.6, 0.95, -4.7, apt); // cooktop
box(0.6, 0.02, 0.42, darkMetal, 4.4, 0.95, -4.7, apt); // sink
cyl(0.02, 0.02, 0.35, darkMetal, 4.4, 0.95, -4.92, apt, 8);
box(0.9, 2.2, 0.7, M("#c7c9cb", { roughness: 0.3, metalness: 0.8 }), 6.2, 0, -4.65, apt); // fridge
box(2.4, 0.9, 1, sage, 4, 0, -2.2, apt); // island
box(2.6, 0.06, 1.1, quartz, 4, 0.9, -2.2, apt);
for (const x of [3.2, 4, 4.8]) {
  cyl(0.2, 0.2, 0.06, M("#c8a27a"), x, 0.72, -1.35, apt);
  cyl(0.025, 0.025, 0.72, darkMetal, x, 0, -1.35, apt, 6);
  const p = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.22, 24, 1, true), M("#1f2125", { metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }));
  p.position.set(x, 2.05, -2.2);
  apt.add(p);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), glow("#ffe8c8", 3));
  b.position.set(x, 1.96, -2.2);
  apt.add(b);
  cyl(0.004, 0.004, 0.75, darkMetal, x, 2.15, -2.2, apt, 4);
}

// --- master bedroom
const bedFabric = M("#61708a", { roughness: 0.9 });
rbox(2.3, 1.15, 0.14, 0.05, bedFabric, 10.5, 0, -4.9, apt);
box(2, 0.32, 2.2, M("#7a5a43"), 10.5, 0, -3.75, apt);
rbox(1.92, 0.25, 2.1, 0.06, M("#f6f3ee", { roughness: 1 }), 10.5, 0.32, -3.75, apt);
rbox(1.98, 0.08, 1.5, 0.04, M("#cdbba3", { roughness: 1 }), 10.5, 0.55, -3.3, apt);
for (const x of [10, 11]) rbox(0.75, 0.16, 0.4, 0.07, M("#ffffff", { roughness: 1 }), x, 0.57, -4.55, apt);
for (const x of [8.85, 12.15]) {
  box(0.5, 0.5, 0.45, M("#7a5a43"), x, 0, -4.6, apt);
  cyl(0.12, 0.16, 0.3, glow("#ffe6c2", 1), x, 0.5, -4.6, apt);
}
box(4, 0.012, 3, M("#d7cbb9", { roughness: 1 }), 10.5, 0, -2.8, apt);
box(0.65, 2.6, 3.4, M("#e4dccf", { roughness: 0.6 }), 12.65, 0, 0.9, apt); // wardrobe / walk-in
for (const z of [-0.2, 0.9, 2]) box(0.02, 0.5, 0.03, darkMetal, 12.31, 1.1, z, apt);
rbox(1.3, 0.45, 0.45, 0.08, bedFabric, 10.5, 0, -2.25, apt); // bench
rbox(0.85, 0.8, 0.85, 0.12, linen, 11.6, 0, 3.8, apt).rotation.y = -0.7;

// --- balcony
box(20, 0.2, 3.2, M("#a99a86", { roughness: 0.8 }), 3, -0.2, 6.6, apt);
box(20, 0.25, 3.2, wallMat, 3, H, 6.6, apt);
box(20, 1.1, 0.04, glass("#d4e3ec", 0.22), 3, 0, 8.15, apt); // frameless glass rail keeps the view clear
for (const x of [9.5, 11]) rbox(0.75, 0.38, 1.6, 0.1, M("#e9e1d3", { roughness: 1 }), x, 0, 6.6, apt);
cyl(0.35, 0.35, 0.45, M("#2a2a2c", { roughness: 0.3 }), 10.25, 0, 7.6, apt);
for (const x of [-6, -4.8]) {
  box(0.9, 0.7, 0.9, M("#7c746a"), x, 0, 6.8, apt);
  tree(x, 6.8, 0.42, apt);
}

const aptLights = [
  [-3.5, 2.5, 0.5, 9],
  [3.8, 2.3, -2.4, 7],
  [10.5, 2.5, -1.5, 8],
];
for (const [x, y, z, i] of aptLights) {
  const l = new THREE.PointLight("#ffdcb0", i, 14, 2);
  l.position.set(x, y, z);
  apt.add(l);
}

// --- the view: park, city, sea
const parkC = new THREE.Vector3(A.x + 10, 0, 95);
box(120, 0.08, 70, M("#86a066", { roughness: 1 }), parkC.x, 0, parkC.z);
const pond = new THREE.Mesh(new THREE.CircleGeometry(12, 40), M("#5c86a0", { roughness: 0.1, metalness: 0.3 }));
pond.rotation.x = -Math.PI / 2;
pond.position.set(parkC.x - 20, 0.1, parkC.z + 6);
scene.add(pond);
for (let i = 0; i < 90; i++) tree(parkC.x + rr(-58, 58), parkC.z + rr(-33, 33), rr(1, 1.8));
for (let i = 0; i < 170; i++) {
  const x = A.x + rr(-260, 260), z = rr(-80, 420);
  if (Math.abs(x - parkC.x) < 66 && Math.abs(z - parkC.z) < 40) continue; // park
  if (Math.abs(x - A.x - 3) < 26 && z > -40 && z < 40) continue; // our own plot
  const far = z > 200 ? 0.6 : 1;
  cityBlock(x, z, rr(12, 26), rr(12, 26), rr(8, z < 60 ? 24 : 58) * far);
}
const sea = new THREE.Mesh(new THREE.PlaneGeometry(2400, 900), M("#4f7d99", { roughness: 0.12, metalness: 0.4 }));
sea.rotation.x = -Math.PI / 2;
sea.position.set(A.x, 0.2, 900);
scene.add(sea);
// a few low blocks under the apartment so it doesn't float in the void
box(22, A.y - 0.2, 12, M("#e3ddd2", { map: facadeTex }), A.x + 3, 0, A.z - 1);

/* ================================================================ camera stations */
// `s` is the scroll position measured in stages (0 = hero … 7 = balcony).
// `cut` means: don't interpolate to the next station, jump at the midpoint
// (hidden by the white elevator flash).

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const inApt = (x, y, z) => V(x, y, z).add(A);
const STATIONS = [
  { s: 0, pos: V(36, 17, 56), look: V(0, 20, 0) },
  { s: 1, pos: V(13, 4, 27), look: V(0, 7, 8) },
  { s: 1.55, pos: V(0, 1.7, 13.5), look: V(0, 1.7, 0) },
  { s: 2, pos: V(3.6, 1.75, 5.2), look: V(-2.4, 1.3, -4) },
  { s: 2.55, pos: V(0.4, 1.7, -2.4), look: V(0, 1.6, -9) },
  { s: 2.92, pos: V(0, 1.65, -7.7), look: V(0, 1.6, -9), cut: true },
  { s: 3.08, pos: inApt(6.2, 1.65, -3.7), look: inApt(-2, 1.2, 1.2) },
  { s: 4, pos: inApt(0.9, 1.6, -0.4), look: inApt(-4, 0.7, 0.7) },
  { s: 5, pos: inApt(1.4, 1.62, 1.9), look: inApt(4.6, 1, -3.2) },
  { s: 6, pos: inApt(7.9, 1.6, 4), look: inApt(10.8, 0.6, -3) },
  { s: 7, pos: inApt(3, 1.6, 6.1), look: inApt(4, -6, 70) },
];
const CUT_AT = 3;

// hotspot labels that appear around their station
const LABELS = [
  { s: 1, at: V(0, 3.4, 9.3), text: "כניסה ראשית" },
  { s: 1, at: V(0, towerTop + 2, 9.2), text: "פנטהאוזים · קומה 12" },
  { s: 1, at: V(-24, 2.5, 14), text: "גינה פרטית" },
  { s: 1, at: V(-4.5, T.lobbyH + 9 * T.floorH + 1, 11), text: "מרפסות שמש" },
  { s: 2, at: V(-4.6, 1.5, -3.2), text: "דלפק קונסיירז׳" },
  { s: 2, at: V(4.8, 1, 0), text: "פינת המתנה" },
  { s: 2, at: V(0, 2.9, -8.6), text: "מעליות מהירות" },
  { s: 4, at: inApt(-3.5, 1.05, -0.6), text: "סלון 38 מ״ר" },
  { s: 4, at: inApt(-3, 2, 5), text: "חלון פנורמי" },
  { s: 4, at: inApt(0.3, 1.1, -2.7), text: "פינת אוכל" },
  { s: 5, at: inApt(4, 1.15, -2.2), text: "אי מטבח 2.4 מ׳" },
  { s: 5, at: inApt(6.2, 2.35, -4.6), text: "מקרר מובנה" },
  { s: 5, at: inApt(3.3, 2.6, -4.8), text: "ארונות עד התקרה" },
  { s: 6, at: inApt(10.5, 0.95, -3.6), text: "מיטה זוגית" },
  { s: 6, at: inApt(12.6, 2, 0.9), text: "חדר ארונות" },
  { s: 6, at: inApt(8.85, 1, -4.6), text: "תאורה מובנית" },
  { s: 7, at: V(parkC.x - 20, 2, parkC.z + 6), text: "פארק עירוני" },
  { s: 7, at: V(A.x + 4, 5, 480), text: "קו הים" },
  { s: 7, at: inApt(10.2, 0.8, 6.6), text: "מרפסת 14 מ״ר" },
];
for (const l of LABELS) {
  l.el = document.createElement("div");
  l.el.className = "label";
  l.el.textContent = l.text;
  labelsEl.append(l.el);
}

/* ================================================================ scroll → s */

let anchors = [];
function measure() {
  const vh = innerHeight;
  anchors = [...journey.querySelectorAll(".stage")].map((el, i) =>
    i === 0 ? 0 : el.offsetTop + el.offsetHeight / 2 - vh / 2
  );
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 68 : 55;
  camera.updateProjectionMatrix();
}
function scrollToStage(y) {
  if (y <= anchors[0]) return 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    if (y < anchors[i + 1]) return i + (y - anchors[i]) / (anchors[i + 1] - anchors[i]);
  }
  return anchors.length - 1;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
function cameraAt(s) {
  if (s <= STATIONS[0].s) return void (camPos.copy(STATIONS[0].pos), camLook.copy(STATIONS[0].look));
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    if (s > b.s) continue;
    if (a.cut) {
      const src = s < CUT_AT ? a : b;
      camPos.copy(src.pos);
      camLook.copy(src.look);
    } else {
      const t = ease((s - a.s) / (b.s - a.s));
      camPos.lerpVectors(a.pos, b.pos, t);
      camLook.lerpVectors(a.look, b.look, t);
    }
    return;
  }
  const last = STATIONS[STATIONS.length - 1];
  camPos.copy(last.pos);
  camLook.copy(last.look);
}

/* ================================================================ loop */

const mouse = new THREE.Vector2();
addEventListener("pointermove", (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
});
addEventListener("resize", measure);
new ResizeObserver(measure).observe(journey);
measure();

const sway = new THREE.Vector2();
const tmp = new THREE.Vector3();
const right = new THREE.Vector3();
let sNow = scrollToStage(scrollY);
let last = performance.now();
let elapsed = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;

  // skip work once the visitor has scrolled past the tour into the sheets
  const jr = journey.getBoundingClientRect();
  if (jr.bottom < 0) return;

  const sTarget = scrollToStage(scrollY);
  sNow = reduceMotion ? sTarget : sNow + (sTarget - sNow) * (1 - Math.exp(-dt * 5));
  if (Math.abs(sTarget - sNow) < 0.0005) sNow = sTarget;

  cameraAt(sNow);

  // gentle hand-held sway + mouse parallax (less indoors, where walls are close)
  const indoors = sNow > 1.5;
  const amp = reduceMotion ? 0 : indoors ? 0.18 : 1.4;
  sway.lerp(mouse, 1 - Math.exp(-dt * 3));
  right.subVectors(camLook, camPos).cross(camera.up).normalize();
  camPos.addScaledVector(right, -sway.x * amp);
  camPos.y += -sway.y * amp * 0.5 + (reduceMotion ? 0 : Math.sin(elapsed * 0.6) * 0.04);
  if (sNow < 0.6 && !reduceMotion) camPos.addScaledVector(right, Math.sin(elapsed * 0.25) * 1.2 * (1 - sNow / 0.6));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  sky.position.copy(camera.position);

  // doors that open as you approach them
  const front = smooth(1.1, 1.5, sNow);
  doorL.position.x = -0.75 - front * 1.45;
  doorR.position.x = 0.75 + front * 1.45;
  const lift = smooth(2.45, 2.8, sNow);
  for (const leaf of elevatorLeaves) leaf.position.x = leaf.userData.x0 + leaf.userData.side * lift * 0.58;

  // white flash hides the jump from the elevator to the apartment
  fadeEl.style.opacity = (1 - smooth(0.06, 0.32, Math.abs(sNow - CUT_AT))).toFixed(3);

  chandelier.rotation.z += dt * 0.08;
  logoRing.rotation.y += dt * 0.4;

  const w = innerWidth, h = innerHeight;
  for (const l of LABELS) {
    const near = Math.abs(sNow - l.s) < 0.38;
    tmp.copy(l.at).project(camera);
    const onScreen = near && tmp.z < 1 && Math.abs(tmp.x) < 0.95 && Math.abs(tmp.y) < 0.9;
    l.el.classList.toggle("is-on", onScreen);
    if (onScreen) {
      l.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -120%)`;
    }
  }

  renderer.render(scene, camera);
}

renderer.compile(scene, camera);
requestAnimationFrame((t) => {
  last = t;
  frame(t);
  loader.classList.add("is-done");
});
