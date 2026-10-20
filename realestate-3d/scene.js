// The 3D tour. Everything is built from primitives in code (no model files),
// and the page's scroll position drives the camera through a list of stations:
// outside the tower → through the glass doors → lobby → elevator (white flash)
// → apartment living room → kitchen → master bedroom → balcony view.
//
// Performance: after the world is built, every static mesh is merged into one
// mesh per material (per area), so the whole scene renders in ~100 draw calls
// and stays smooth on phones.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const canvas = document.getElementById("scene");
const loader = document.getElementById("loader");
const fadeEl = document.getElementById("fade");
const labelsEl = document.getElementById("labels");
const journey = document.getElementById("journey");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
const Q = isMobile ? 0.55 : 1; // density of scattered city/park detail

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
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}
function cyl(rTop, rBot, h, mat, x, y, z, parent = scene, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}
function sphere(r, mat, x, y, z, parent = scene, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  parent.add(m);
  return m;
}
function group(x, y, z, ry = 0, parent = scene) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  return g;
}
// many boxes in one draw call: items are [w, h, d, x, yBottom, z, rotY?, color?]
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function boxes(items, mat, parent = scene) {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, items.length);
  items.forEach(([w, h, d, x, y, z, ry = 0, col], i) => {
    _m4.compose(_p.set(x, y + h / 2, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(w, h, d));
    im.setMatrixAt(i, _m4);
    if (col) im.setColorAt(i, new THREE.Color(col));
  });
  im.frustumCulled = false;
  parent.add(im);
  return im;
}
const dynamic = (o) => ((o.userData.dynamic = true), o);

function canvasTexture(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + rand() * (b - a);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/* ================================================================ textures */

const woodFloorTex = canvasTexture(512, 512, (g, w, h) => {
  const rows = 8;
  for (let i = 0; i < rows; i++) {
    for (let x = -((i % 2) * 128); x < w; x += 256) {
      g.fillStyle = `hsl(30, 36%, ${60 + Math.random() * 9}%)`;
      g.fillRect(x, (i * h) / rows, 256, h / rows);
      g.strokeStyle = "rgba(60,35,15,0.22)";
      g.strokeRect(x, (i * h) / rows, 256, h / rows);
      for (let k = 0; k < 6; k++) {
        g.strokeStyle = `rgba(90,55,25,${0.04 + Math.random() * 0.08})`;
        g.beginPath();
        const yy = (i * h) / rows + Math.random() * (h / rows);
        g.moveTo(x, yy);
        g.bezierCurveTo(x + 80, yy + 4, x + 170, yy - 4, x + 256, yy);
        g.stroke();
      }
    }
  }
}, [5, 2.5]);

function marble(base, vein) {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = vein;
      g.globalAlpha = 0.08 + Math.random() * 0.25;
      g.lineWidth = 0.5 + Math.random() * 2.5;
      g.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (Math.random() - 0.3) * 140;
        y += (Math.random() - 0.5) * 90;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}
const marbleTex = marble("#efece6", "#8d8a86");
const darkMarbleTex = marble("#2b2a2c", "#b9ad98");

const concreteTex = canvasTexture(256, 256, (g, w, h) => {
  g.fillStyle = "#b8b4ad";
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? "60,60,60" : "255,255,255"},${Math.random() * 0.08})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}, [3, 3]);

const deckTex = canvasTexture(256, 256, (g, w, h) => {
  for (let i = 0; i < 8; i++) {
    g.fillStyle = `hsl(28, 28%, ${44 + Math.random() * 8}%)`;
    g.fillRect(i * 32, 0, 30, h);
  }
}, [12, 2]);

const rugTex = canvasTexture(512, 384, (g, w, h) => {
  g.fillStyle = "#ddd2c2";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#b9a990";
  g.lineWidth = 6;
  g.strokeRect(24, 24, w - 48, h - 48);
  g.lineWidth = 2;
  g.strokeRect(44, 44, w - 88, h - 88);
  g.fillStyle = "#c9b79e";
  for (let i = 0; i < 6; i++) g.fillRect(90 + i * 60, h / 2 - 2, 34, 4);
});

const facadeTex = canvasTexture(256, 512, (g, w, h) => {
  g.fillStyle = "#d9d4cb";
  g.fillRect(0, 0, w, h);
  const cols = 5, rows = 12;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      g.fillStyle = Math.random() < 0.18 ? "#f3d9a8" : `hsl(210, 22%, ${26 + Math.random() * 12}%)`;
      g.fillRect(c * (w / cols) + 8, r * (h / rows) + 8, w / cols - 16, h / rows - 14);
    }
});
// curtain-wall towers: dark glass with thin white slab lines
const glassTowerTex = canvasTexture(128, 512, (g, w, h) => {
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#3d5878");
  grad.addColorStop(1, "#22344d");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#e9e5dc";
  for (let y = 0; y < h; y += 21) g.fillRect(0, y, w, 3);
  g.fillStyle = "rgba(255,255,255,0.12)";
  for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 1, h);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = "rgba(255,214,160,0.6)";
    g.fillRect(Math.floor(Math.random() * 8) * 16 + 2, Math.floor(Math.random() * 24) * 21 + 4, 12, 15);
  }
});

function textTexture(text, sub, w = 1024, h = 320, bg = "#1f2228", fg = "#d9b27c") {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.direction = "rtl";
    g.textAlign = "center";
    g.fillStyle = fg;
    g.font = `900 ${h * 0.42}px Heebo, Arial, sans-serif`;
    g.fillText(text, w / 2, h * 0.55);
    if (sub) {
      g.font = `300 ${h * 0.13}px Heebo, Arial, sans-serif`;
      g.fillStyle = "#e9e3d8";
      g.fillText(sub, w / 2, h * 0.82);
    }
  });
}

const screenTex = canvasTexture(256, 420, (g, w, h) => {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#1c2b44");
  grad.addColorStop(1, "#0d1422");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#d9b27c";
  g.fillRect(24, 30, 90, 8);
  g.fillStyle = "rgba(255,255,255,0.75)";
  for (let i = 0; i < 9; i++) g.fillRect(24, 70 + i * 36, 120 + Math.random() * 80, 10);
  g.fillStyle = "#4f9d74";
  for (let i = 0; i < 9; i++) g.fillRect(w - 50, 68 + i * 36, 22, 14);
});

function artTexture(palette) {
  return canvasTexture(512, 340, (g, w, h) => {
    g.fillStyle = palette[0];
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      g.fillStyle = palette[1 + (i % (palette.length - 1))];
      g.globalAlpha = 0.85;
      g.beginPath();
      if (i % 3 === 0) g.fillRect(Math.random() * w, Math.random() * h, 40 + Math.random() * 160, 30 + Math.random() * 120);
      else g.arc(Math.random() * w, Math.random() * h, 30 + Math.random() * 110, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  });
}

/* ================================================================ shared materials */

const MAT = {
  slab: M("#efebe3", { roughness: 0.6 }),
  stone: M("#d6cbb8", { roughness: 0.55 }),
  darkStone: M("#ffffff", { map: darkMarbleTex, roughness: 0.25 }),
  marble: M("#ffffff", { map: marbleTex, roughness: 0.15 }),
  concrete: M("#ffffff", { map: concreteTex, roughness: 0.85 }),
  alu: M("#b9ae9b", { roughness: 0.32, metalness: 0.8 }),
  black: M("#1d1f22", { roughness: 0.38, metalness: 0.6 }),
  steel: M("#c7c9cb", { roughness: 0.28, metalness: 0.85 }),
  brass: M("#c9a46a", { roughness: 0.3, metalness: 0.9 }),
  towerGlass: M("#29405e", { roughness: 0.06, metalness: 0.95, envMapIntensity: 1.4 }),
  darkGlass: M("#101418", { roughness: 0.08, metalness: 0.6 }),
  oak: M("#b38a60", { roughness: 0.5 }),
  walnut: M("#5e4230", { roughness: 0.48 }),
  wall: M("#efebe4", { roughness: 0.92 }),
  white: M("#f6f4f0", { roughness: 0.6 }),
  led: glow("#fff1d6", 2.6),
  ledSoft: glow("#ffe2b8", 1.2),
  water: M("#4aa3c2", { roughness: 0.04, metalness: 0.25, emissive: "#123e52", emissiveIntensity: 0.4 }),
  lawn: M("#8aa36b", { roughness: 1 }),
  leaf: M("#5f7f4d", { flatShading: true, roughness: 0.9 }),
  leaf2: M("#7a9258", { flatShading: true, roughness: 0.9 }),
  olive: M("#8b9a7a", { flatShading: true, roughness: 0.9 }),
  trunk: M("#6b5442"),
  glassLobby: glass(),
  glassWin: glass("#b9d0de", 0.1),
  glassRail: glass("#d4e3ec", 0.22),
  curtain: new THREE.MeshStandardMaterial({ color: "#f7f3ec", transparent: true, opacity: 0.55, roughness: 1, side: THREE.DoubleSide, depthWrite: false }),
};

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
dynamic(sky);
scene.add(sky);
scene.fog = new THREE.Fog("#e8d8c4", 160, 900);

scene.add(new THREE.HemisphereLight("#dbe7f5", "#b8a58b", 1.0));
const sun = new THREE.DirectionalLight("#ffe0b8", 2.6);
sun.position.set(-70, 90, 80);
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), M("#c9c0ae", { roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const crownGeo = new THREE.IcosahedronGeometry(1, 1);
function tree(x, z, s = 1, parent = scene, leaf) {
  cyl(0.12 * s, 0.18 * s, 2.2 * s, MAT.trunk, x, 0, z, parent, 7);
  const c = new THREE.Mesh(crownGeo, leaf || (rand() < 0.5 ? MAT.leaf : MAT.leaf2));
  c.scale.set(1.6 * s, 1.5 * s, 1.6 * s);
  c.position.set(x, 3.2 * s, z);
  c.rotation.set(rand() * 3, rand() * 3, 0);
  parent.add(c);
}
// olive tree: twisted trunk with a few grey-green clouds — a modern landscaping staple
function oliveTree(x, z, s = 1, parent = scene) {
  cyl(0.1 * s, 0.2 * s, 1.6 * s, MAT.trunk, x, 0, z, parent, 7);
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(crownGeo, MAT.olive);
    c.scale.setScalar((0.6 + rand() * 0.35) * s);
    c.position.set(x + rr(-0.5, 0.5) * s, (1.8 + rr(0, 0.7)) * s, z + rr(-0.5, 0.5) * s);
    parent.add(c);
  }
}
// tall grasses in a planter
function grasses(x, y, z, w, d, parent = scene) {
  const items = [];
  for (let i = 0; i < w * d * 18; i++) items.push([0.03, rr(0.35, 0.7), 0.03, x + rr(-w / 2, w / 2), y, z + rr(-d / 2, d / 2), rr(0, 3), pick(["#7d8f5a", "#94a46a", "#a7a77a"])]);
  boxes(items, M("#ffffff", { roughness: 1 }), parent);
}
function palm(x, z, s = 1) {
  const lean = rr(-0.12, 0.12);
  const t = cyl(0.12 * s, 0.2 * s, 7 * s, MAT.trunk, x, 0, z, scene, 7);
  t.rotation.z = lean;
  const top = new THREE.Vector3(x - Math.sin(lean) * 7 * s, 7 * s, z);
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(3 * s, 0.05, 0.5 * s), MAT.leaf);
    const a = (i / 7) * Math.PI * 2;
    f.position.set(top.x + Math.cos(a) * 1.3 * s, top.y - 0.3 * s, top.z + Math.sin(a) * 1.3 * s);
    f.rotation.set(0, -a, -0.45);
    scene.add(f);
  }
}

const cityMats = ["#d8d1c5", "#cfc8bd", "#e3ddd2", "#bfc4c8", "#c9bfb0"].map((c) => M(c, { map: facadeTex, roughness: 0.8 }));
const glassCityMat = M("#ffffff", { map: glassTowerTex, roughness: 0.15, metalness: 0.5 });
function cityBlock(x, z, w, d, h, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || pick(cityMats));
  m.position.set(x, h / 2, z);
  scene.add(m);
  // rooftop plant room on taller blocks
  if (h > 20) box(w * 0.4, 2.2, d * 0.4, MAT.slab, x + rr(-w, w) * 0.15, h, z + rr(-d, d) * 0.15);
}

function car(x, z, ry, color) {
  const g = group(x, 0, z, ry);
  const paint = M(color, { roughness: 0.25, metalness: 0.6 });
  rbox(4.5, 0.7, 1.9, 0.25, paint, 0, 0.3, 0, g);
  rbox(2.5, 0.62, 1.72, 0.25, MAT.darkGlass, -0.2, 0.9, 0, g);
  for (const wx of [-1.45, 1.45]) for (const wz of [-0.85, 0.85]) {
    const w = cyl(0.36, 0.36, 0.26, MAT.black, 0, 0, 0, g, 14);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.36, wz);
  }
  box(0.04, 0.12, 1.5, glow("#fff4e0", 1.5), 2.25, 0.62, 0, g);
  box(0.04, 0.1, 1.5, glow("#ff3a2a", 1.2), -2.25, 0.66, 0, g);
}

/* ================================================================ the tower */

const T = { half: 9, lobbyH: 4.5, floorH: 3.3, floors: 12 };
const towerTop = T.lobbyH + T.floors * T.floorH;
const upperH = towerTop - T.lobbyH;

box(17.4, upperH, 17.4, MAT.towerGlass, 0, T.lobbyH, 0); // glass core

// floor slabs + LED strip on every slab edge
{
  const slabs = [], leds = [];
  for (let i = 0; i <= T.floors; i++) {
    const y = T.lobbyH + i * T.floorH - 0.19;
    slabs.push([18.6, 0.38, 18.6, 0, y, 0]);
    leds.push([18.62, 0.035, 0.02, 0, y + 0.02, 9.31], [0.02, 0.035, 18.62, 9.31, y + 0.02, 0], [0.02, 0.035, 18.62, -9.31, y + 0.02, 0]);
  }
  boxes(slabs, MAT.slab);
  boxes(leds, MAT.ledSoft);
}

// mullions on all faces + champagne aluminium fins on the side faces
{
  const mull = [], fins = [];
  for (let i = 0; i < 8; i++) {
    const a = -7.6 + (i * 15.2) / 7;
    mull.push([0.16, upperH, 0.3, a, T.lobbyH, 8.75], [0.16, upperH, 0.3, a, T.lobbyH, -8.75], [0.3, upperH, 0.16, 8.75, T.lobbyH, a], [0.3, upperH, 0.16, -8.75, T.lobbyH, a]);
  }
  for (let i = 0; i < 10; i++) {
    const a = -8.1 + (i * 16.2) / 9;
    fins.push([0.55, upperH, 0.06, 9.2, T.lobbyH, a, 0.25], [0.55, upperH, 0.06, -9.2, T.lobbyH, a, -0.25]);
  }
  boxes(mull, MAT.black);
  boxes(fins, MAT.alu);
}

// lit windows scattered on the glass so the tower feels inhabited
{
  const geo = new THREE.PlaneGeometry(1.7, 2.4);
  const inst = new THREE.InstancedMesh(geo, glow("#ffd8a0", 1.1), 70);
  for (let n = 0; n < 70; n++) {
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.floor(rand() * 4) * Math.PI) / 2);
    const p = new THREE.Vector3(-6.5 + Math.floor(rand() * 7) * 2.17, T.lobbyH + Math.floor(rand() * T.floors) * T.floorH + 1.6, 8.71).applyQuaternion(_q);
    _m4.compose(p, _q, _s.set(1, 1, 1));
    inst.setMatrixAt(n, _m4);
  }
  inst.frustumCulled = false;
  scene.add(inst);
}

// staggered front balconies: slab, timber soffit, glass rail, LED edge, planters
for (let i = 1; i < T.floors; i++) {
  const x = i % 2 ? -4.5 : 4.5;
  const y = T.lobbyH + i * T.floorH;
  box(8, 0.32, 2.2, MAT.slab, x, y - 0.16, 10.1);
  box(7.9, 0.02, 2.1, MAT.oak, x, y - 0.18, 10.1);
  box(8, 1.05, 0.05, MAT.glassRail, x, y + 0.16, 11.17);
  box(8, 0.03, 0.02, MAT.ledSoft, x, y - 0.1, 11.21);
  if (i % 3 === 1) {
    box(1.2, 0.5, 0.5, MAT.concrete, x + 3, y + 0.16, 10.7);
    oliveTree(x + 3, 10.7, 0.35);
  }
}

// rooftop: penthouse box, infinity pool, pergola, solar array, glass parapet
{
  const R = towerTop + 0.6;
  box(18.6, 0.6, 18.6, MAT.slab, 0, towerTop, 0);
  box(11, 3, 9, MAT.stone, -3, R, -4.5);
  box(10.98, 2.4, 0.04, MAT.towerGlass, -3, R + 0.2, 0.01);
  box(7.4, 0.5, 3.6, MAT.slab, 4.6, R, 5.6);
  box(7, 0.04, 3.2, MAT.water, 4.6, R + 0.48, 5.6);
  box(18.6, 1.1, 0.05, MAT.glassRail, 0, R, 9.28);
  box(0.05, 1.1, 18.6, MAT.glassRail, 9.28, R, 0);
  box(0.05, 1.1, 18.6, MAT.glassRail, -9.28, R, 0);
  const louvers = [];
  for (let i = 0; i < 12; i++) louvers.push([0.12, 0.25, 4, -6.5 + i * 0.42, R + 2.6, 5.5]);
  boxes(louvers, MAT.oak);
  for (const [x, z] of [[-8.8, 3.6], [-1.6, 3.6], [-8.8, 7.4], [-1.6, 7.4]]) box(0.12, 2.6, 0.12, MAT.black, x, R, z);
  for (const x of [-7, -4, -1]) rbox(1.8, 0.35, 0.8, 0.1, M("#e9e1d3"), x, R, 6.2);
  const solar = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) solar.push([2, 0.05, 1.1, -6.5 + i * 2.3, R + 3.3, -7.5 + j * 1.6]);
  boxes(solar, M("#1c2c4a", { roughness: 0.2, metalness: 0.6 }));
  box(8, 0.6, 0.8, MAT.concrete, 4.6, R, 1.4);
  grasses(4.6, R + 0.6, 1.4, 7.6, 0.6);
}

// stone columns at the lobby corners + entrance canopy
for (const x of [-8.7, 8.7]) for (const z of [-8.7, 8.7]) box(0.9, T.lobbyH, 0.9, MAT.stone, x, 0, z);
box(10, 0.28, 4.6, MAT.slab, 0, 3.7, 11.1);
box(9.9, 0.02, 4.5, MAT.oak, 0, 3.69, 11.1);
box(10, 0.04, 0.02, MAT.led, 0, 3.8, 13.41);
for (const x of [-4.7, 4.7]) box(0.14, 3.7, 0.14, MAT.black, x, 0, 13.2);
{
  const spots = [];
  for (let x = -3.6; x <= 3.6; x += 1.8) for (const z of [10, 12]) spots.push([0.18, 0.01, 0.18, x, 3.675, z]);
  boxes(spots, MAT.led);
}

/* ================================================================ site around the tower */

box(60, 0.06, 40, M("#ddd4c4", { roughness: 0.8 }), 0, 0, 12); // plaza paving
box(4.4, 0.07, 24, M("#cfc4b1", { roughness: 0.7 }), 0, 0, 24); // entry walk
box(400, 0.05, 12, M("#55585f", { roughness: 0.9 }), 0, 0, 42); // road
boxes(Array.from({ length: 48 }, (_, i) => [3, 0.06, 0.25, -190 + i * 8, 0.02, 42]), M("#e8e2d5"));
boxes(Array.from({ length: 8 }, (_, i) => [0.5, 0.06, 5, -3.5 + i, 0.02, 42]), M("#ecebe6")); // crosswalk
box(400, 0.18, 3, M("#d8d2c6", { roughness: 0.8 }), 0, 0, 35.3); // sidewalk

// reflecting pools flanking the entry walk
for (const side of [-1, 1]) {
  box(6.4, 0.35, 8.4, MAT.darkStone, side * 6.2, 0, 18.5);
  box(6, 0.04, 8, MAT.water, side * 6.2, 0.33, 18.5);
  box(0.06, 0.03, 8, MAT.led, side * 3.05, 0.34, 18.5);
  rbox(2.4, 0.45, 0.6, 0.06, MAT.concrete, side * 10.6, 0, 18.5).rotation.y = Math.PI / 2;
  for (let z = 14; z <= 24; z += 5) oliveTree(side * 12, z, 0.9);
}
// bollard lights along the walk
for (let z = 15; z <= 33; z += 4) for (const x of [-2.5, 2.5]) {
  cyl(0.09, 0.09, 0.9, MAT.black, x, 0, z, scene, 10);
  cyl(0.085, 0.085, 0.08, MAT.led, x, 0.78, z, scene, 10);
}
// project sign monolith
{
  const sign = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.5, 0.45), [MAT.darkStone, MAT.darkStone, MAT.darkStone, MAT.darkStone, M("#ffffff", { map: textTexture("האופק", "מגורי יוקרה · שכונת הפארק"), roughness: 0.4 }), MAT.darkStone]);
  sign.position.set(-7.2, 0.75, 29);
  sign.rotation.y = 0.35;
  scene.add(sign);
  box(4.4, 0.3, 1.4, MAT.concrete, -7.2, 0, 29);
}

// private gardens with paths, benches and garden lights
for (const [cx, cz] of [[-25, 12], [25, 6]]) {
  box(24, 0.08, 18, MAT.lawn, cx, 0, cz);
  box(1.6, 0.1, 18, M("#d9cfbd"), cx, 0, cz);
  for (let i = 0; i < 14 * Q + 4; i++) {
    const x = cx + rr(-11, 11), z = cz + rr(-8, 8);
    if (Math.abs(x - cx) > 1.4) tree(x, z, rr(0.8, 1.2));
  }
  for (const z of [cz - 4, cz + 4]) rbox(1.8, 0.45, 0.55, 0.06, MAT.oak, cx + 1.6, 0, z).rotation.y = Math.PI / 2;
}
// street: trees, modern street lights and cars
for (let x = -60; x <= 60; x += 10) tree(x, 34.2, 0.9);
for (let x = -70; x <= 70; x += 20) {
  cyl(0.08, 0.11, 6.5, MAT.black, x + 5, 0, 36.6, scene, 8);
  box(1.6, 0.1, 0.18, MAT.black, x + 4.3, 6.4, 36.6);
  box(1.2, 0.03, 0.12, MAT.led, x + 4.1, 6.37, 36.6);
}
car(-14, 39.4, 0, "#e9e7e2");
car(-6.5, 39.4, 0, "#22303f");
car(9, 39.4, 0, "#7d8187");
car(17, 39.4, 0, "#a33a2a");
car(-30, 44.5, Math.PI, "#f0efea");
car(26, 44.5, Math.PI, "#30343a");

// neighbouring buildings, kept clear of the camera path
for (let i = 0; i < 46 * Q + 10; i++) {
  const x = rr(-220, 220), z = rr(-220, 30);
  if (Math.abs(x) < 45 && z > -60) continue;
  const tall = rand() < 0.25;
  cityBlock(x, z, rr(10, 22), rr(10, 22), tall ? rr(35, 60) : rr(8, 30), tall ? glassCityMat : undefined);
}

/* ================================================================ lobby (inside the tower podium) */

const lobby = new THREE.Group();
scene.add(lobby);
const LH = T.lobbyH;

const lobbyFloor = new THREE.Mesh(new THREE.PlaneGeometry(17.4, 17.4), M("#ffffff", { map: marble("#ece8e1", "#a39d95"), roughness: 0.1 }));
lobbyFloor.material.map.wrapS = lobbyFloor.material.map.wrapT = THREE.RepeatWrapping;
lobbyFloor.material.map.repeat.set(3, 3);
lobbyFloor.rotation.x = -Math.PI / 2;
lobbyFloor.position.y = 0.07;
lobby.add(lobbyFloor);
const lobbyCeil = new THREE.Mesh(new THREE.PlaneGeometry(17.4, 17.4), M("#f3f0ea"));
lobbyCeil.rotation.x = Math.PI / 2;
lobbyCeil.position.y = LH - 0.2;
lobby.add(lobbyCeil);
// linear LED lines in the ceiling
boxes([-7, -5, 5, 7].map((x) => [0.07, 0.02, 15.5, x, LH - 0.23, 0]), MAT.led, lobby);
boxes([-6, -3, 3, 6].map((z) => [3.2, 0.02, 0.07, -7.2 + 1.2, LH - 0.23, z]).concat([-6, -3, 3, 6].map((z) => [3.2, 0.02, 0.07, 6, LH - 0.23, z])), MAT.led, lobby);

// back wall: dark wall + walnut acoustic slats, marble portal around the elevators
box(17.4, LH, 0.2, M("#2a2522"), 0, 0, -8.8, lobby);
{
  const slats = [];
  for (let x = -8.55; x < -2.95; x += 0.17) slats.push([0.07, LH - 0.25, 0.09, x, 0.05, -8.64]);
  for (let x = 3.0; x < 8.6; x += 0.17) slats.push([0.07, LH - 0.25, 0.09, x, 0.05, -8.64]);
  boxes(slats, MAT.walnut, lobby);
}
box(5.9, LH - 0.2, 0.12, MAT.marble, 0, 0, -8.62, lobby);
box(17.4, 0.03, 0.03, MAT.ledSoft, 0, 0.08, -8.56, lobby);

box(0.2, LH, 17.4, MAT.glassLobby, -8.7, 0, 0, lobby);
box(0.2, LH, 17.4, MAT.glassLobby, 8.7, 0, 0, lobby);
// front glazing with a door opening in the middle
box(7.2, LH, 0.08, MAT.glassLobby, -5.1, 0, 8.7, lobby);
box(7.2, LH, 0.08, MAT.glassLobby, 5.1, 0, 8.7, lobby);
box(3, LH - 3, 0.08, MAT.glassLobby, 0, 3, 8.7, lobby);
box(3.2, 0.12, 0.2, MAT.black, 0, 3, 8.7, lobby);
for (const x of [-1.55, 1.55]) box(0.1, 3, 0.2, MAT.black, x, 0, 8.7, lobby);
const doorGlass = glass("#bcd3e0", 0.3);
const doorL = dynamic(box(1.5, 3, 0.05, doorGlass, -0.75, 0, 8.78, lobby));
const doorR = dynamic(box(1.5, 3, 0.05, doorGlass, 0.75, 0, 8.78, lobby));
for (const d of [doorL, doorR]) box(0.04, 1.2, 0.08, MAT.brass, 0, 0, 0, d).position.set(d === doorL ? 0.65 : -0.65, -0.4, 0.05);

// elevators: bright cab behind brushed steel doors, call buttons, floor indicator
const elevatorLeaves = [];
const leafMat = M("#c9c3b8", { metalness: 0.9, roughness: 0.28 });
for (const ex of [-1.7, 1.7]) {
  box(1.7, 2.9, 0.06, MAT.black, ex, 0, -8.52, lobby);
  box(1.2, 2.5, 0.02, glow("#fff4e2", 1.6), ex, 0.05, -8.48, lobby);
  for (const side of [-1, 1]) {
    const leaf = dynamic(box(0.6, 2.5, 0.04, leafMat, ex + side * 0.3, 0.05, -8.44, lobby));
    leaf.userData.x0 = ex + side * 0.3;
    leaf.userData.side = side;
    elevatorLeaves.push(leaf);
  }
  box(0.3, 0.07, 0.02, glow("#ffb547", 2), ex, 2.72, -8.47, lobby);
  box(0.12, 0.22, 0.02, MAT.black, ex + Math.sign(ex) * 1.05, 1.15, -8.54, lobby);
  sphere(0.025, glow("#ffffff", 3), ex + Math.sign(ex) * 1.05, 1.3, -8.52, lobby);
}
const directory = box(0.9, 1.5, 0.03, M("#ffffff", { map: screenTex, emissive: "#ffffff", emissiveMap: screenTex, emissiveIntensity: 0.9 }), 0, 0.9, -8.55, lobby);
box(1.0, 1.6, 0.02, MAT.black, 0, 0.85, -8.57, lobby);

// art on the slat wall behind the lounge
box(3.2, 2, 0.05, M("#ffffff", { map: artTexture(["#e7e1d3", "#5f7f6c", "#d19a66", "#283244"]), roughness: 0.8 }), 5.8, 1.2, -8.55, lobby);
box(3.3, 0.02, 0.1, MAT.led, 5.8, 3.3, -8.5, lobby);

// reception: marble block with LED underglow, black top, backdrop with sign
box(4.2, 1.05, 1, MAT.marble, -4.6, 0.04, -3.2, lobby);
box(4.4, 0.06, 1.2, M("#1f1f21", { roughness: 0.15, metalness: 0.3 }), -4.6, 1.09, -3.2, lobby);
box(4.1, 0.02, 0.02, MAT.led, -4.6, 0.05, -2.69, lobby);
box(0.55, 0.34, 0.03, MAT.darkGlass, -4.0, 1.27, -3.45, lobby).rotation.y = 0.3;
box(0.04, 0.12, 0.04, MAT.black, -4.0, 1.15, -3.46, lobby);
cyl(0.09, 0.07, 0.18, M("#e6e1d8"), -5.6, 1.15, -3.3, lobby);
grasses(-5.6, 1.33, -3.3, 0.15, 0.15, lobby);
box(5.2, 3.6, 0.16, MAT.walnut, -4.6, 0, -6, lobby);
box(2.2, 0.62, 0.02, M("#ffffff", { map: textTexture("האופק", null, 1024, 290, "#5e4230"), roughness: 0.5 }), -4.6, 1.75, -5.91, lobby);
const logoRing = dynamic(new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 12, 48), glow("#d9b27c", 1.4)));
logoRing.position.set(-4.6, 2.95, -5.86);
lobby.add(logoRing);

// waiting lounge: modular sofa, lounge chairs, marble coffee table, arc lamp, rug
const velvet = M("#36475e", { roughness: 0.85 });
rbox(3.2, 0.42, 1, 0.12, velvet, 4.8, 0, -0.4, lobby);
rbox(3.2, 0.55, 0.3, 0.12, velvet, 4.8, 0.38, -0.85, lobby);
for (const x of [4.0, 5.6]) rbox(0.6, 0.4, 0.14, 0.06, M("#c9a46a", { roughness: 0.9 }), x, 0.48, -0.6, lobby);
function loungeChair(x, z, ry, mat, parent) {
  const g = group(x, 0, z, ry, parent);
  rbox(0.8, 0.16, 0.8, 0.06, mat, 0, 0.3, 0, g);
  const back = rbox(0.8, 0.55, 0.14, 0.06, mat, 0, 0.4, -0.36, g);
  back.rotation.x = -0.2;
  for (const lx of [-0.33, 0.33]) for (const lz of [-0.3, 0.3]) cyl(0.015, 0.015, 0.3, MAT.black, lx, 0, lz, g, 6);
  return g;
}
loungeChair(3.6, 2.7, Math.PI + 0.3, M("#c8a27a", { roughness: 0.8 }), lobby);
loungeChair(6.0, 2.7, Math.PI - 0.3, M("#c8a27a", { roughness: 0.8 }), lobby);
cyl(0.6, 0.6, 0.05, MAT.marble, 4.8, 0.37, 1.1, lobby, 32);
cyl(0.12, 0.3, 0.37, MAT.black, 4.8, 0, 1.1, lobby, 16);
box(5.2, 0.012, 4.6, M("#ffffff", { map: rugTex, roughness: 1 }), 4.8, 0.075, 1, lobby);
function arcLamp(bx, bz, ry, parent) {
  const g = group(bx, 0, bz, ry, parent);
  cyl(0.2, 0.2, 0.05, MAT.marble, 0, 0, 0, g);
  cyl(0.015, 0.015, 1.0, MAT.brass, 0, 0, 0, g, 6);
  const arc = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.015, 6, 28, Math.PI / 2), MAT.brass);
  arc.position.set(-1.0, 1.0, 0);
  g.add(arc);
  const shade = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.black);
  shade.position.set(-1.0, 1.82, 0);
  g.add(shade);
  sphere(0.09, glow("#fff0d6", 3), -1.0, 1.8, 0, g);
}
arcLamp(7.2, 0.6, Math.PI, lobby);
cyl(0.6, 0.5, 0.75, MAT.concrete, 7.2, 0, -6.6, lobby, 24);
oliveTree(7.2, -6.6, 1.0, lobby);
for (const [x, z] of [[-7.6, 7.4], [7.6, 7.4]]) {
  cyl(0.45, 0.35, 0.9, MAT.white, x, 0, z, lobby);
  tree(x, z, 0.45, lobby);
}
rbox(2.6, 0.45, 0.6, 0.08, MAT.oak, -7.6, 0, 3, lobby).rotation.y = Math.PI / 2; // window bench

// layered ring chandeliers
const chandelier = dynamic(new THREE.Group());
chandelier.position.set(0, 3.5, 0);
lobby.add(chandelier);
for (const [r, y] of [[2.2, 0], [1.5, -0.35], [0.9, -0.6]]) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 10, 96), glow("#ffe2b0", 2.2));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = y;
  chandelier.add(ring);
}
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  cyl(0.004, 0.004, 0.8, MAT.black, Math.cos(a) * 2.2, -0.1, Math.sin(a) * 2.2, chandelier, 4);
}
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

const oakFloor = M("#ffffff", { map: woodFloorTex, roughness: 0.5 });
const quartz = M("#f3f1ec", { roughness: 0.16 });
const sage = M("#56665a", { roughness: 0.5 });
const linen = M("#cfc6b8", { roughness: 0.95 });

box(20, 0.2, 10, oakFloor, 3, -0.2, 0, apt); // floor x: -7..13, z: -5..5
box(20, 0.2, 10, MAT.wall, 3, H, 0, apt); // ceiling
box(20, H, 0.2, MAT.wall, 3, 0, -5.1, apt); // back wall
box(0.2, H, 10, MAT.wall, -7.1, 0, 0, apt);
box(0.2, H, 10, MAT.wall, 13.1, 0, 0, apt);
// shadow-gap skirting
boxes([[20, 0.06, 0.012, 3, 0, -4.99], [0.012, 0.06, 10, -6.99, 0, 0], [0.012, 0.06, 10, 12.99, 0, 0]], MAT.black, apt);

// ceiling: recessed downlights, a lowered soffit with cove LED, linear AC diffuser
{
  const dl = [];
  for (let x = -5.5; x <= 12; x += 2.2) for (const z of [-3.2, 0, 3.2]) if (!(x > 2 && x < 6 && z < -1)) dl.push([0.1, 0.012, 0.1, x, H - 0.012, z]);
  boxes(dl, MAT.led, apt);
}
box(20, 0.28, 0.7, MAT.wall, 3, H - 0.28, -4.65, apt);
box(20, 0.025, 0.025, MAT.led, 3, H - 0.3, -4.29, apt);
box(1.6, 0.012, 0.06, MAT.black, -3.5, H - 0.29, -4.5, apt);
box(1.6, 0.012, 0.06, MAT.black, 10.5, H - 0.29, -4.5, apt);

// window wall with an open slider (x 2..7) onto the balcony
box(9, H, 0.04, MAT.glassWin, -2.5, 0, 5, apt);
box(6, H, 0.04, MAT.glassWin, 10, 0, 5, apt);
box(20, 0.12, 0.12, MAT.black, 3, H - 0.12, 5, apt);
box(20, 0.06, 0.12, MAT.black, 3, 0, 5, apt);
boxes([-7, -4.5, -2, 0.5, 2, 7, 9, 11, 13].map((x) => [0.06, H, 0.12, x, 0, 5]), MAT.black, apt);
box(2.6, H, 0.04, MAT.glassWin, 6.6, 0, 5.1, apt); // the slid-open panel
box(20, 0.08, 0.2, MAT.black, 3, H - 0.1, 4.75, apt); // curtain track

// sheer curtains gathered at the ends of the glass
function curtain(width, x, z, parent) {
  const g = new THREE.PlaneGeometry(width, H - 0.15, 48, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / width) * 14 * Math.PI) * 0.05);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, MAT.curtain);
  m.position.set(x, (H - 0.15) / 2, z);
  parent.add(m);
}
curtain(1.3, -6.3, 4.72, apt);
curtain(1.1, 12.4, 4.72, apt);
curtain(0.8, 1.5, 4.72, apt);

// partition to the master bedroom (x = 7), opening near the windows
box(0.15, H, 6.5, MAT.wall, 7, 0, -1.75, apt);
box(0.15, 0.45, 3.5, MAT.wall, 7, H - 0.45, 3.25, apt);

// smart-home panel by the entry
box(0.14, 0.2, 0.012, MAT.darkGlass, 6.4, 1.3, -4.99, apt);
box(0.1, 0.12, 0.004, glow("#7fb3ff", 1.2), 6.4, 1.34, -4.98, apt);

// --- living room
box(4.6, 0.012, 3.4, M("#ffffff", { map: rugTex, roughness: 1 }), -3.5, 0, 0.9, apt);
const sofaMat = M("#b5ab9c", { roughness: 0.95 });
box(3.1, 0.12, 1.02, MAT.black, -3.5, 0, -0.55, apt); // recessed plinth
for (const x of [-4.5, -3.5, -2.5]) rbox(0.98, 0.32, 0.95, 0.1, sofaMat, x, 0.12, -0.5, apt);
rbox(3.1, 0.55, 0.28, 0.1, sofaMat, -3.5, 0.32, -0.95, apt);
for (const x of [-5.05, -1.95]) rbox(0.2, 0.55, 1.02, 0.08, sofaMat, x, 0.08, -0.55, apt);
for (const [x, c] of [[-4.4, "#8e9a86"], [-3.6, "#c97f52"], [-2.7, "#8e9a86"]]) rbox(0.5, 0.42, 0.14, 0.06, M(c, { roughness: 1 }), x, 0.44, -0.72, apt).rotation.z = rr(-0.12, 0.12);
rbox(0.9, 0.06, 0.5, 0.02, M("#d8c3a6"), -2.6, 0.45, -0.3, apt); // throw
// nesting coffee tables
cyl(0.55, 0.55, 0.05, MAT.marble, -3.6, 0.34, 1.05, apt, 40);
cyl(0.1, 0.24, 0.34, MAT.black, -3.6, 0, 1.05, apt, 16);
cyl(0.32, 0.32, 0.03, MAT.walnut, -2.75, 0.26, 1.5, apt, 30);
cyl(0.015, 0.015, 0.26, MAT.black, -2.75, 0, 1.5, apt, 6);
// table styling: books, bowl, candle
box(0.32, 0.04, 0.24, M("#2f3b4c"), -3.75, 0.39, 0.95, apt);
box(0.28, 0.03, 0.2, M("#d8c9ae"), -3.75, 0.43, 0.95, apt);
sphere(0.12, M("#2b2a2c", { roughness: 0.3 }), -3.35, 0.42, 1.2, apt, 1, 0.5, 1);
loungeChair(-5.8, 1.9, 2.2, M("#9a6b4a", { roughness: 0.6 }), apt);
arcLamp(-5.55, -0.7, Math.PI, apt); // arcs over the end of the sofa

// TV wall: walnut slats, floating console with LED underglow, frame-style TV
{
  const s = [];
  for (let z = -1.3; z <= 2.5; z += 0.15) s.push([0.08, H - 0.3, 0.06, -6.95, 0, z]);
  boxes(s, MAT.walnut, apt);
}
box(0.45, 0.42, 3.2, MAT.oak, -6.7, 0.3, 0.6, apt);
box(0.02, 0.02, 3.1, MAT.led, -6.48, 0.28, 0.6, apt);
box(0.05, 0.9, 1.6, M("#0e0f11", { roughness: 0.2, metalness: 0.5 }), -6.85, 1.15, 0.6, apt);
box(0.012, 0.8, 1.5, M("#ffffff", { map: artTexture(["#20304a", "#d9b27c", "#5f7f6c", "#efe6d6"]), emissive: "#ffffff", emissiveMap: artTexture(["#20304a", "#d9b27c", "#5f7f6c", "#efe6d6"]), emissiveIntensity: 0.35 }), -6.82, 1.2, 0.6, apt);
box(0.2, 0.08, 0.6, MAT.black, -6.65, 0.72, 0.6, apt); // soundbar
cyl(0.06, 0.06, 0.28, M("#e6dccb", { roughness: 0.3 }), -6.65, 0.72, -0.4, apt);
cyl(0.09, 0.06, 0.18, MAT.black, -6.65, 0.72, 1.6, apt);

// back wall: sideboard, art with picture light, bookshelf, tall plant
box(2.8, 0.62, 0.45, MAT.walnut, -3.5, 0.15, -4.75, apt);
boxes([[0.01, 0.5, 0.005, -4.2, 0.2, -4.52], [0.01, 0.5, 0.005, -2.8, 0.2, -4.52]], MAT.black, apt);
cyl(0.1, 0.07, 0.35, M("#d9cbb5", { roughness: 0.4 }), -4.4, 0.77, -4.75, apt);
sphere(0.11, MAT.brass, -2.6, 0.88, -4.75, apt);
box(2.6, 1.5, 0.04, M("#ffffff", { map: artTexture(["#efe8dc", "#c98b5a", "#3f5a70", "#e3c58f"]) }), -3.5, 1.05, -4.98, apt);
box(0.8, 0.03, 0.08, MAT.brass, -3.5, 2.62, -4.9, apt);
{
  const shelfX = -6.2, shelves = [], books = [];
  box(0.9, 2.3, 0.35, MAT.oak, shelfX, 0, -4.8, apt).scale.set(1, 1, 0.12);
  for (let i = 0; i < 5; i++) {
    const y = 0.15 + i * 0.48;
    shelves.push([0.9, 0.03, 0.32, shelfX, y, -4.78]);
    let x = shelfX - 0.4;
    while (x < shelfX + (i % 2 ? 0.1 : 0.35)) {
      const bw = rr(0.03, 0.06), bh = rr(0.2, 0.32);
      books.push([bw, bh, 0.22, x + bw / 2, y + 0.03, -4.78, 0, pick(["#2f3b4c", "#c97f52", "#d8c9ae", "#5f7f6c", "#efe6d6", "#1f2125", "#a3473a"])]);
      x += bw + 0.005;
    }
  }
  boxes(shelves, MAT.oak, apt);
  boxes(books, M("#ffffff", { roughness: 0.8 }), apt);
  sphere(0.08, M("#e6dccb", { roughness: 0.3 }), shelfX + 0.28, 0.78, -4.78, apt);
  cyl(0.06, 0.06, 0.2, MAT.black, shelfX + 0.3, 1.74, -4.78, apt);
}
cyl(0.3, 0.24, 0.6, MAT.concrete, -6.3, 0, 4.2, apt);
oliveTree(-6.3, 4.2, 0.6, apt);
cyl(0.18, 0.15, 0.4, MAT.white, -1.2, 0, 4.4, apt);
grasses(-1.2, 0.4, 4.4, 0.3, 0.3, apt);

// track light with spots over the living area
box(4, 0.04, 0.05, MAT.black, -3.5, H - 0.04, 1.2, apt);
for (const x of [-5, -4, -3, -2]) {
  const sp = cyl(0.04, 0.04, 0.12, MAT.black, x, H - 0.16, 1.2, apt, 10);
  sp.rotation.x = 0.4;
}

// --- dining: marble table, sled-leg chairs, linear pendant
box(1.9, 0.04, 0.95, MAT.marble, 0.3, 0.72, -2.7, apt);
for (const x of [-0.5, 1.1]) {
  box(0.03, 0.72, 0.03, MAT.black, x, 0, -3.05, apt);
  box(0.03, 0.72, 0.03, MAT.black, x, 0, -2.35, apt);
  box(0.03, 0.03, 0.7, MAT.black, x, 0.69, -2.7, apt);
}
function diningChair(x, z, ry, parent) {
  const g = group(x, 0, z, ry, parent);
  rbox(0.44, 0.07, 0.44, 0.03, M("#d9cfbf", { roughness: 0.9 }), 0, 0.44, 0, g);
  rbox(0.44, 0.32, 0.05, 0.02, MAT.walnut, 0, 0.55, -0.2, g);
  for (const lx of [-0.19, 0.19]) for (const lz of [-0.19, 0.19]) box(0.02, 0.44, 0.02, MAT.black, lx, 0, lz, g);
}
for (const x of [-0.15, 0.75]) {
  diningChair(x, -3.45, 0, apt);
  diningChair(x, -1.95, Math.PI, apt);
}
box(1.4, 0.04, 0.07, MAT.black, 0.3, 1.78, -2.7, apt);
box(1.32, 0.012, 0.04, MAT.led, 0.3, 1.77, -2.7, apt);
for (const x of [-0.3, 0.9]) cyl(0.003, 0.003, H - 1.82, MAT.black, x, 1.82, -2.7, apt, 4);
cyl(0.07, 0.05, 0.25, M("#e6dccb", { roughness: 0.3 }), 0.3, 0.76, -2.7, apt);
for (let i = 0; i < 3; i++) box(0.01, 0.4, 0.01, MAT.trunk, 0.3 + rr(-0.06, 0.06), 0.98, -2.7, apt).rotation.z = rr(-0.4, 0.4);

// --- kitchen: handleless sage cabinets, marble backsplash, built-ins
box(4.6, 0.1, 0.5, MAT.black, 3.3, 0, -4.75, apt); // toe kick
box(4.6, 0.8, 0.6, sage, 3.3, 0.1, -4.7, apt);
box(4.7, 0.05, 0.65, quartz, 3.3, 0.9, -4.68, apt);
boxes([1.6, 2.2, 2.8, 3.8, 4.4, 5.0].map((x) => [0.006, 0.78, 0.004, x, 0.11, -4.399]), MAT.black, apt);
box(1.8, H - 0.95, 0.02, MAT.marble, 3.3, 0.95, -4.98, apt); // full-height marble behind the cooktop
box(1.4, 1.0, 0.4, sage, 1.7, 1.9, -4.8, apt); // uppers left
box(1.4, 1.0, 0.4, sage, 4.9, 1.9, -4.8, apt); // uppers right
box(1.4, 0.95, 0.02, M("#d8d0c3", { roughness: 0.3 }), 1.7, 0.95, -4.98, apt);
box(1.4, 0.95, 0.02, M("#d8d0c3", { roughness: 0.3 }), 4.9, 0.95, -4.98, apt);
box(1.8, 0.05, 0.28, MAT.walnut, 3.3, 1.65, -4.84, apt); // floating shelf
box(1.7, 0.012, 0.02, MAT.led, 3.3, 1.64, -4.72, apt);
for (const [x, c, h] of [[2.6, "#e6dccb", 0.22], [2.85, "#c8a27a", 0.16], [3.9, "#2b2a2c", 0.2]]) cyl(0.06, 0.06, h, M(c, { roughness: 0.4 }), x, 1.7, -4.84, apt);
cyl(0.08, 0.07, 0.14, MAT.white, 3.5, 1.7, -4.84, apt);
grasses(3.5, 1.84, -4.84, 0.12, 0.12, apt);
box(0.78, 0.012, 0.52, M("#0d0d0e", { roughness: 0.08, metalness: 0.3 }), 3.3, 0.95, -4.68, apt); // induction
box(0.9, 0.12, 0.5, MAT.steel, 3.3, H - 0.12, -4.7, apt); // ceiling-flush hood
box(0.6, 0.02, 0.42, MAT.steel, 4.9, 0.94, -4.68, apt); // sink
{
  cyl(0.015, 0.015, 0.36, MAT.black, 4.9, 0.95, -4.9, apt, 8);
  const neck = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.013, 8, 16, Math.PI), MAT.black);
  neck.position.set(4.9, 1.31, -4.81);
  neck.rotation.y = Math.PI / 2;
  apt.add(neck);
}
box(0.3, 0.38, 0.32, MAT.black, 1.5, 0.95, -4.75, apt); // coffee machine
box(0.18, 0.02, 0.12, MAT.steel, 1.5, 1.02, -4.58, apt);
box(0.42, 0.02, 0.28, MAT.oak, 2.2, 0.95, -4.68, apt); // board
// tall oven column + integrated fridge
box(0.6, H, 0.62, sage, 0.7, 0, -4.69, apt);
box(0.5, 0.55, 0.01, MAT.darkGlass, 0.7, 0.85, -4.37, apt);
box(0.5, 0.38, 0.01, MAT.darkGlass, 0.7, 1.52, -4.37, apt);
box(0.08, 0.03, 0.005, glow("#ffb547", 2), 0.7, 1.43, -4.36, apt);
box(0.9, 2.3, 0.7, MAT.steel, 6.2, 0, -4.65, apt);
boxes([[0.02, 1.0, 0.03, 6.17, 0.8, -4.28], [0.02, 1.0, 0.03, 6.23, 0.8, -4.28]], MAT.black, apt);
box(0.9, 0.6, 0.7, sage, 6.2, 2.3, -4.65, apt);
// island with waterfall quartz ends, wine fridge, styled top
box(2.4, 0.9, 1, sage, 4, 0, -2.2, apt);
box(2.6, 0.06, 1.1, quartz, 4, 0.9, -2.2, apt);
for (const x of [2.73, 5.27]) box(0.06, 0.9, 1.1, quartz, x, 0, -2.2, apt);
box(0.58, 0.72, 0.01, M("#1a1110", { roughness: 0.1, metalness: 0.4, emissive: "#3a1a10", emissiveIntensity: 0.5 }), 4.85, 0.1, -2.71, apt);
sphere(0.2, M("#d8cfc0", { roughness: 0.3 }), 4.4, 0.98, -2.2, apt, 1, 0.38, 1);
for (const [dx, c] of [[-0.06, "#e3a43a"], [0.07, "#c4452f"], [0, "#9cb04d"]]) sphere(0.055, M(c, { roughness: 0.5 }), 4.4 + dx, 1.04, -2.2 + dx, apt);
cyl(0.05, 0.04, 0.2, M("#e6dccb"), 3.2, 0.96, -2.3, apt);
// modern bar stools: seat, back, foot ring, pedestal
for (const x of [3.2, 4, 4.8]) {
  cyl(0.2, 0.2, 0.06, M("#c8a27a", { roughness: 0.6 }), x, 0.72, -1.35, apt);
  box(0.36, 0.18, 0.03, M("#c8a27a", { roughness: 0.6 }), x, 0.8, -1.17, apt);
  cyl(0.025, 0.025, 0.72, MAT.black, x, 0, -1.35, apt, 6);
  cyl(0.2, 0.2, 0.02, MAT.black, x, 0, -1.35, apt, 20);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.01, 6, 24), MAT.black);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, 0.3, -1.35);
  apt.add(ring);
}
// cone pendants over the island
for (const x of [3.2, 4, 4.8]) {
  const p = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.22, 24, 1, true), M("#1f2125", { metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }));
  p.position.set(x, 2.05, -2.2);
  apt.add(p);
  sphere(0.06, glow("#ffe8c8", 3), x, 1.96, -2.2, apt);
  cyl(0.004, 0.004, 0.75, MAT.black, x, 2.15, -2.2, apt, 4);
}

// --- master bedroom
// full-width upholstered channel panel with ledge and cove light
{
  const ch = [];
  for (let x = 8.6; x <= 12.4; x += 0.2) ch.push([0.18, 1.35, 0.06, x, 0.05, -4.96]);
  boxes(ch, M("#61708a", { roughness: 0.95 }), apt);
}
box(4.1, 0.04, 0.14, MAT.walnut, 10.5, 1.42, -4.93, apt);
box(4, 0.02, 0.02, MAT.led, 10.5, 1.41, -4.86, apt);
box(2.4, 1.2, 0.04, M("#ffffff", { map: artTexture(["#ede5d8", "#b9a07c", "#61708a", "#d8c3a6"]) }), 10.5, 1.55, -4.98, apt);
// floating bed with underglow
box(1.85, 0.03, 2.05, MAT.led, 10.5, 0.04, -3.75, apt);
box(2.05, 0.25, 2.25, MAT.walnut, 10.5, 0.1, -3.75, apt);
rbox(1.92, 0.25, 2.1, 0.06, M("#f6f3ee", { roughness: 1 }), 10.5, 0.35, -3.75, apt);
rbox(1.98, 0.08, 1.5, 0.04, M("#cdbba3", { roughness: 1 }), 10.5, 0.58, -3.3, apt);
rbox(2.0, 0.05, 0.55, 0.02, M("#a65f3c", { roughness: 1 }), 10.5, 0.64, -2.85, apt); // throw
for (const x of [9.95, 11.05]) {
  rbox(0.8, 0.18, 0.4, 0.08, M("#ffffff", { roughness: 1 }), x, 0.6, -4.55, apt);
  rbox(0.55, 0.16, 0.14, 0.06, M("#8e9a86", { roughness: 1 }), x, 0.62, -4.25, apt);
}
// floating nightstands + hanging globe lights
for (const x of [8.7, 12.3]) {
  box(0.55, 0.22, 0.4, MAT.walnut, x, 0.4, -4.75, apt);
  sphere(0.11, glow("#ffe6c2", 1.6), x, 1.15, -4.65, apt);
  cyl(0.003, 0.003, H - 1.26, MAT.black, x, 1.26, -4.65, apt, 4);
}
box(0.2, 0.03, 0.14, MAT.black, 12.3, 0.62, -4.75, apt); // phone
box(4.2, 0.012, 3.2, M("#ffffff", { map: rugTex, roughness: 1 }), 10.5, 0, -2.9, apt);
rbox(1.3, 0.42, 0.42, 0.08, M("#61708a", { roughness: 0.9 }), 10.5, 0.05, -2.2, apt); // bench
for (const lx of [9.95, 11.05]) box(0.03, 0.05, 0.36, MAT.brass, lx, 0, -2.2, apt);

// walk-in wardrobe: black frame, smoked glass, lit interior with clothes
box(0.7, 2.7, 3.4, MAT.oak, 12.7, 0, 0.9, apt);
{
  const clothes = [];
  for (let z = -0.6; z <= 2.4; z += rr(0.07, 0.12)) clothes.push([0.4, rr(0.7, 1.1), 0.05, 12.55, rr(1.0, 1.25), z, 0, pick(["#f1ede6", "#2f3b4c", "#c9b8a0", "#1f2125", "#8e9a86", "#a65f3c"])]);
  boxes(clothes, M("#ffffff", { roughness: 1 }), apt);
  boxes([[0.38, 0.03, 3.2, 12.6, 0.5, 0.9], [0.38, 0.03, 3.2, 12.6, 2.3, 0.9]], MAT.walnut, apt);
}
box(0.02, 2.2, 0.02, MAT.led, 12.36, 0.25, -0.65, apt);
box(0.02, 2.7, 3.4, glass("#2a2e33", 0.35), 12.33, 0, 0.9, apt);
boxes([-0.8, 0.9, 2.6].map((z) => [0.04, 2.7, 0.04, 12.32, 0, z]).concat([[0.04, 0.04, 3.4, 12.32, 2.66, 0.9]]), MAT.black, apt);
// vanity desk with round mirror on the partition
box(0.5, 0.04, 1.3, MAT.walnut, 7.35, 0.74, -1.4, apt);
boxes([[0.02, 0.74, 0.02, 7.55, 0, -2.0], [0.02, 0.74, 0.02, 7.55, 0, -0.8]], MAT.brass, apt);
{
  const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.45, 40), M("#dfe6ea", { metalness: 1, roughness: 0.04 }));
  mirror.rotation.y = Math.PI / 2;
  mirror.position.set(7.09, 1.45, -1.4);
  apt.add(mirror);
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.015, 8, 48), MAT.brass);
  frame.rotation.y = Math.PI / 2;
  frame.position.set(7.095, 1.45, -1.4);
  apt.add(frame);
}
cyl(0.2, 0.2, 0.45, linen, 7.8, 0, -1.4, apt);
loungeChair(11.6, 3.7, -0.8 + Math.PI, linen, apt);
cyl(0.25, 0.25, 0.5, MAT.walnut, 10.8, 0, 4.1, apt, 24);
cyl(0.015, 0.015, 1.5, MAT.black, 12.6, 0, 3.0, apt, 6);
cyl(0.16, 0.2, 0.24, glow("#ffe6c2", 1), 12.6, 1.5, 3.0, apt);

// --- balcony: deck, ceiling LED, frameless glass rail, lounge seats facing the view
box(20, 0.2, 3.2, M("#ffffff", { map: deckTex, roughness: 0.8 }), 3, -0.2, 6.6, apt);
box(20, 0.25, 3.2, MAT.wall, 3, H, 6.6, apt);
box(20, 0.025, 0.025, MAT.led, 3, H - 0.02, 8.1, apt);
box(20, 1.1, 0.04, MAT.glassRail, 3, 0, 8.15, apt); // frameless glass rail keeps the view clear
box(20, 0.06, 0.08, MAT.alu, 3, 0, 8.15, apt); // base channel
for (const x of [-1.6, 7.6]) {
  const g = loungeChair(x, 7.25, Math.PI, M("#e9e1d3", { roughness: 1 }), apt);
  g.scale.set(1.1, 1, 1.15);
}
cyl(0.25, 0.25, 0.45, MAT.concrete, 3, 0, 7.6, apt, 24);
cyl(0.05, 0.04, 0.12, M("#e6dccb"), 3, 0.45, 7.6, apt);
for (const x of [0.4, 5.6]) {
  box(0.7, 0.75, 0.7, MAT.concrete, x, 0, 7.6, apt);
  oliveTree(x, 7.6, 0.45, apt);
}
box(3.2, 0.5, 0.5, MAT.concrete, -5, 0, 7.75, apt);
grasses(-5, 0.5, 7.75, 3, 0.4, apt);
// outdoor kitchen at the far end
box(0.7, 0.9, 2.4, MAT.concrete, 12.5, 0, 6.6, apt);
box(0.6, 0.03, 0.8, MAT.black, 12.5, 0.9, 6.3, apt);
rbox(2.3, 0.4, 0.9, 0.1, M("#e9e1d3", { roughness: 1 }), 9.5, 0, 6.3, apt);
rbox(2.3, 0.4, 0.22, 0.08, M("#e9e1d3", { roughness: 1 }), 9.5, 0.35, 5.9, apt);
cyl(0.4, 0.4, 0.38, MAT.walnut, 9.5, 0, 7.4, apt, 24);

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

// --- the view: park, city, beach and sea
const parkC = new THREE.Vector3(A.x + 10, 0, 95);
box(120, 0.08, 70, MAT.lawn, parkC.x, 0, parkC.z);
box(120, 0.1, 3, M("#e2d8c5"), parkC.x, 0, parkC.z - 10); // promenade
box(3, 0.1, 70, M("#e2d8c5"), parkC.x + 25, 0, parkC.z);
const pond = new THREE.Mesh(new THREE.CircleGeometry(12, 40), MAT.water);
pond.rotation.x = -Math.PI / 2;
pond.position.set(parkC.x - 20, 0.1, parkC.z + 6);
scene.add(pond);
for (let i = 0; i < 90 * Q; i++) {
  const x = parkC.x + rr(-58, 58), z = parkC.z + rr(-33, 33);
  if (Math.abs(z - (parkC.z - 10)) < 3 || Math.abs(x - parkC.x - 25) < 3) continue;
  tree(x, z, rr(1, 1.8));
}
for (let i = 0; i < 170 * Q + 20; i++) {
  const x = A.x + rr(-260, 260), z = rr(-80, 420);
  if (Math.abs(x - parkC.x) < 66 && Math.abs(z - parkC.z) < 40) continue; // park
  if (Math.abs(x - A.x - 3) < 26 && z > -40 && z < 40) continue; // our own plot
  if (Math.abs(x - A.x - 3) < (z > 150 ? 45 : 32) && z > 105) continue; // sight line to the sea
  const far = z > 200 ? 0.6 : 1;
  cityBlock(x, z, rr(12, 26), rr(12, 26), rr(8, z < 60 ? 24 : 58) * far);
}
// a cluster of glass towers on the skyline
// (kept off the centre of the view so the sea stays visible)
for (let i = 0; i < 12; i++) {
  const side = i % 2 ? 1 : -1;
  cityBlock(A.x + 3 + side * rr(70, 220), rr(180, 360), rr(18, 26), rr(18, 26), rr(55, 95), glassCityMat);
}
box(2400, 0.15, 30, M("#e6d3ad", { roughness: 1 }), A.x, 0, 437); // beach
for (let i = 0; i < 24 * Q; i++) palm(A.x + rr(-220, 220), rr(424, 432), rr(1, 1.3));
const sea = new THREE.Mesh(new THREE.PlaneGeometry(2400, 900), M("#4f7d99", { roughness: 0.12, metalness: 0.4 }));
sea.rotation.x = -Math.PI / 2;
sea.position.set(A.x, 0.2, 900);
scene.add(sea);
// our own building below the apartment so it doesn't float in the void
box(22, A.y - 0.2, 12, M("#e3ddd2", { map: facadeTex }), A.x + 3, 0, A.z - 1);

/* ================================================================ merge static meshes */
// One mesh per (material, area). Keeps culling useful: the tower site and the
// apartment district are separate buckets.

function mergeStatic() {
  scene.updateMatrixWorld(true);
  const buckets = new Map();
  const victims = [];
  const box3 = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o === ground) return;
    for (let p = o; p; p = p.parent) if (p.userData.dynamic) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.morphAttributes = {};
    box3.setFromBufferAttribute(g.attributes.position);
    const area = box3.min.x > 200 ? "apt" : "site";
    const key = o.material.uuid + area;
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [] });
    buckets.get(key).geos.push(g);
    victims.push(o);
  });
  for (const o of victims) {
    o.parent.remove(o);
    o.geometry.dispose();
  }
  for (const { mat, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.computeBoundingSphere();
    const m = new THREE.Mesh(merged, mat);
    m.matrixAutoUpdate = false;
    scene.add(m);
  }
}
mergeStatic();

/* ================================================================ camera stations */
// `s` is the scroll position measured in stages (0 = hero … 7 = balcony).
// `cut` means: don't interpolate to the next station, jump at the midpoint
// (hidden by the white elevator flash).

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const inApt = (x, y, z) => V(x, y, z).add(A);
const STATIONS = [
  { s: 0, pos: V(36, 17, 56), look: V(0, 20, 0) },
  { s: 1, pos: V(14, 4.5, 30), look: V(0, 6, 9) },
  { s: 1.55, pos: V(0, 1.7, 14.5), look: V(0, 1.7, 0) },
  { s: 2, pos: V(3.6, 1.75, 5.2), look: V(-2.4, 1.3, -4) },
  { s: 2.55, pos: V(0.4, 1.7, -2.4), look: V(0, 1.6, -9) },
  { s: 2.92, pos: V(0, 1.65, -7.6), look: V(0, 1.6, -9), cut: true },
  { s: 3.08, pos: inApt(6.2, 1.65, -3.7), look: inApt(-2, 1.2, 1.2) },
  { s: 4, pos: inApt(0.9, 1.6, -0.4), look: inApt(-4, 0.8, 0.7) },
  { s: 5, pos: inApt(1.4, 1.62, 1.9), look: inApt(4.4, 1.05, -3.2) },
  { s: 6, pos: inApt(7.9, 1.6, 4), look: inApt(10.6, 0.7, -3) },
  { s: 7, pos: inApt(3, 1.6, 6.1), look: inApt(4, -6, 70) },
];
const CUT_AT = 3;

// hotspot labels that appear around their station (`m` = also shown on phones)
const LABELS = [
  { s: 1, at: V(0, 4.2, 13.4), text: "כניסה ראשית", m: 1 },
  { s: 1, at: V(0, towerTop + 4, 9.2), text: "פנטהאוזים · קומה 12", m: 1 },
  { s: 1, at: V(4.6, towerTop + 1.4, 5.6), text: "בריכה על הגג" },
  { s: 1, at: V(-6.2, 0.8, 18.5), text: "בריכות נוי" },
  { s: 1, at: V(9.4, 22, 4), text: "חזית אלומיניום" },
  { s: 1, at: V(-4.5, T.lobbyH + 9 * T.floorH + 1.2, 11), text: "מרפסות שמש", m: 1 },
  { s: 2, at: V(-4.6, 1.5, -3.2), text: "דלפק קונסיירז׳", m: 1 },
  { s: 2, at: V(4.8, 1, -0.2), text: "פינת המתנה", m: 1 },
  { s: 2, at: V(0, 2.9, -8.4), text: "מעליות מהירות" },
  { s: 2, at: V(-6.5, 3, -8.5), text: "קיר עץ אקוסטי" },
  { s: 2, at: V(0, 3.8, 0), text: "גוף תאורה מעוצב" },
  { s: 4, at: inApt(-3.5, 1.05, -0.6), text: "סלון 38 מ״ר", m: 1 },
  { s: 4, at: inApt(-3, 2, 5), text: "חלון פנורמי" },
  { s: 4, at: inApt(0.3, 1.1, -2.7), text: "פינת אוכל", m: 1 },
  { s: 4, at: inApt(-6.85, 2.2, 0.6), text: "קיר טלוויזיה" },
  { s: 4, at: inApt(-6.2, 2.4, -4.7), text: "ספרייה" },
  { s: 5, at: inApt(4, 1.15, -2.2), text: "אי קוורץ 2.4 מ׳", m: 1 },
  { s: 5, at: inApt(6.2, 2.45, -4.6), text: "מקרר מובנה" },
  { s: 5, at: inApt(0.7, 2.0, -4.4), text: "תנור בנוי", m: 1 },
  { s: 5, at: inApt(3.3, 1.75, -4.8), text: "מדף צף + LED" },
  { s: 5, at: inApt(4.85, 0.6, -2.7), text: "מקרר יין" },
  { s: 6, at: inApt(10.5, 0.95, -3.6), text: "מיטה צפה", m: 1 },
  { s: 6, at: inApt(12.4, 2.0, 0.9), text: "חדר ארונות", m: 1 },
  { s: 6, at: inApt(7.3, 1.95, -1.4), text: "פינת איפור" },
  { s: 6, at: inApt(10.5, 1.6, -4.9), text: "קיר מרופד" },
  { s: 7, at: V(parkC.x - 20, 2, parkC.z + 6), text: "פארק עירוני", m: 1 },
  { s: 7, at: V(A.x + 4, 8, 440), text: "קו הים", m: 1 },
  { s: 7, at: inApt(3, 0.9, 7.6), text: "מרפסת 14 מ״ר" },
];
for (const l of LABELS) {
  l.el = document.createElement("div");
  l.el.className = "label";
  l.el.textContent = l.text;
  labelsEl.append(l.el);
}

/* ================================================================ scroll → s */

let anchors = [];
let portrait = false;
function measure() {
  const vh = innerHeight;
  anchors = [...journey.querySelectorAll(".stage")].map((el, i) =>
    i === 0 ? 0 : el.offsetTop + el.offsetHeight / 2 - vh / 2
  );
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  portrait = w / h < 0.8;
  if (portrait) {
    // phones: render a taller frustum and show its lower part, so the subject
    // sits in the top half of the screen, above the info card
    camera.fov = 74;
    camera.setViewOffset(w, h * 1.4, 0, h * 0.4, w, h);
  } else {
    camera.fov = 55;
    camera.clearViewOffset();
  }
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
  // touch moves are scroll gestures, not looking around
  if (e.pointerType === "mouse") mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
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
  if (journey.getBoundingClientRect().bottom < 0) return;

  const sTarget = scrollToStage(scrollY);
  sNow = reduceMotion ? sTarget : sNow + (sTarget - sNow) * (1 - Math.exp(-dt * 5));
  if (Math.abs(sTarget - sNow) < 0.0005) sNow = sTarget;

  cameraAt(sNow);
  // portrait screens are narrow: step back from the tower so it fits the frame
  if (portrait && sNow < 1.3) camPos.lerp(camLook, -0.45 * (1 - smooth(0.6, 1.3, sNow)));

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

  chandelier.rotation.y += dt * 0.08;
  logoRing.rotation.y += dt * 0.4;

  const w = innerWidth, h = innerHeight;
  const narrow = w < 760;
  for (const l of LABELS) {
    const near = Math.abs(sNow - l.s) < 0.38 && (!narrow || l.m);
    tmp.copy(l.at).project(camera);
    // on phones keep labels in the scene area above the card
    const onScreen = near && tmp.z < 1 && Math.abs(tmp.x) < 0.95 && tmp.y < 0.9 && tmp.y > (narrow ? -0.05 : -0.9);
    l.el.classList.toggle("is-on", onScreen);
    if (onScreen) {
      const half = l.el.offsetWidth / 2 + 8;
      const x = Math.min(w - half, Math.max(half, ((tmp.x + 1) / 2) * w));
      l.el.style.transform = `translate(${x}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -120%)`;
    }
  }

  renderer.render(scene, camera);
}

// ?debug exposes the renderer stats in the console (draw calls, triangles)
if (new URLSearchParams(location.search).has("debug")) window.__tour = { renderer, scene, camera, state: () => ({ sNow, anchors }) };

renderer.compile(scene, camera);
requestAnimationFrame((t) => {
  last = t;
  frame(t);
  loader.classList.add("is-done");
});
