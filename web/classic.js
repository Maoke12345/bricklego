/**
 * "Classic" renderer: plain hemisphere + key light, clean colours, a hairline seam between parts, and a
 * layer-by-layer replay of the build. Part parsing reuses BrickAgent's own viewer (MIT).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { readMPD, geometry } from './vendor/viewer.js';
import { LDrawLoader } from './vendor/LDrawLoader.js';

const SEAM = 0.992;          // shrink each part about its centre so neighbours show a joint
const LAYER = 24;            // one brick height in LDU: one replay step

export function createClassic(container, { onStep = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x40505a, 0.75 * Math.PI));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85 * Math.PI);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.3 * Math.PI);
  scene.add(sun, fill);

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let root = new THREE.Group();
  root.rotation.x = Math.PI;                       // LDraw is -Y up
  scene.add(root);

  let dirty = true;
  controls.addEventListener('change', () => { dirty = true; });
  (function loop() {
    if (controls.update() || dirty) { renderer.render(scene, camera); dirty = false; }
    requestAnimationFrame(loop);
  })();
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let bounds = new THREE.Box3();
  let batches = [];            // { mesh, base, layers: Int32Array sorted ascending }
  let maxStep = 0, step = 0, highlight = true;
  const dim = new THREE.Color();

  /** Drop the current model, keeping the renderer, lights and controls. */
  function clear() {
    root.traverse(node => { if (node.isInstancedMesh) { node.geometry.dispose(); node.material.dispose(); } });
    scene.remove(root);
    root = new THREE.Group();
    root.rotation.x = Math.PI;
    scene.add(root);
    bounds = new THREE.Box3();
    batches = [];
    maxStep = step = 0;
    dirty = true;
  }

  async function load(text, palette) {
    clear();
    const { files, placements } = readMPD(text);
    const parts = await geometry(files, new Set(placements.map(p => p.name)), palette, new LDrawLoader());
    const colors = new Map(palette.map(p => [p.code, p]));
    const flip = new THREE.Matrix4().makeRotationX(Math.PI);

    // world box of every placement -> its replay layer (bottom face, counted up from the lowest part)
    const boxes = new Map([...parts].map(([n, pieces]) => [n, pieces.reduce((b, p) => b.union(p.geometry.boundingBox), new THREE.Box3())]));
    const world = placements.map(p => boxes.get(p.name).clone().applyMatrix4(p.matrix).applyMatrix4(flip));
    world.forEach(b => bounds.union(b));
    const floor = bounds.min.y;
    const layerOf = world.map(b => Math.max(0, Math.floor((b.min.y - floor + 2) / LAYER)));
    maxStep = Math.max(...layerOf);

    const groups = new Map();
    placements.forEach((p, i) => {
      const k = p.name + '|' + p.color;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const opaque = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0 });
    const glass = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, transparent: true, opacity: 0.75, depthWrite: false });
    const m = new THREE.Matrix4(), local = new THREE.Matrix4(), s = new THREE.Matrix4(), a = new THREE.Matrix4(), b = new THREE.Matrix4();
    for (const idx of groups.values()) {
      idx.sort((x, y) => layerOf[x] - layerOf[y]);
      const first = placements[idx[0]];
      for (const piece of parts.get(first.name)) {
        const code = piece.code === 16 ? first.color : piece.code;
        const c = colors.get(code);
        const alpha = (c?.alpha ?? 255) / 255;
        const base = new THREE.Color(code >= 0x2000000 ? code & 0xffffff : c?.hex || '#9ba19d');
        const mesh = new THREE.InstancedMesh(piece.geometry, alpha < 1 ? glass : opaque, idx.length);
        const ctr = piece.geometry.boundingBox.getCenter(new THREE.Vector3());
        local.multiplyMatrices(a.makeTranslation(ctr.x, ctr.y, ctr.z), s.makeScale(SEAM, SEAM, SEAM)).multiply(b.makeTranslation(-ctr.x, -ctr.y, -ctr.z));
        idx.forEach((pi, k) => {
          m.multiplyMatrices(placements[pi].matrix, local);
          mesh.setMatrixAt(k, m);
          mesh.setColorAt(k, base);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        root.add(mesh);
        batches.push({ mesh, base, layers: Int32Array.from(idx.map(i => layerOf[i])) });
      }
    }

    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    const r = size.length() / 2;
    sun.position.copy(center).add(new THREE.Vector3(0.4, 0.8, 0.5).multiplyScalar(r * 2));
    sun.target.position.copy(center); scene.add(sun.target);
    fill.position.copy(center).add(new THREE.Vector3(-0.5, 0.2, -0.4).multiplyScalar(r * 2));
    setStep(maxStep);
    return { parts: placements.length, steps: maxStep + 1 };
  }

  function setStep(k) {
    step = Math.max(0, Math.min(maxStep, k));
    for (const { mesh, base, layers } of batches) {
      let count = 0;
      for (let i = 0; i < layers.length; i++) {
        if (layers[i] <= step) count = i + 1;
        const old = highlight && step < maxStep && layers[i] < step;
        mesh.setColorAt(i, old ? dim.copy(base).multiplyScalar(0.45) : base);
      }
      mesh.count = count;
      mesh.instanceColor.needsUpdate = true;
    }
    dirty = true;
    onStep(step, maxStep);
  }

  function frame(az = 35, el = 22) {
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size.length()) || size.length() === 0) return;
    // fit both ways: a tall bottle overflows vertically, a wide scene horizontally
    const fovV = THREE.MathUtils.degToRad(camera.fov);
    const wide = Math.hypot(size.x, size.z);        // widest face you can turn towards the camera
    const dist = Math.max(size.y / 2 / Math.tan(fovV / 2),
                          wide / 2 / Math.tan(Math.atan(Math.tan(fovV / 2) * camera.aspect))) * 1.25;
    center.y -= size.y * 0.04;            // a tall model's top is less interesting: aim slightly low
    const A = THREE.MathUtils.degToRad(az), E = THREE.MathUtils.degToRad(el);
    camera.position.set(center.x + dist * Math.cos(E) * Math.sin(A), center.y + dist * Math.sin(E), center.z + dist * Math.cos(E) * Math.cos(A));
    camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix();
    controls.target.copy(center); controls.update(); dirty = true;
  }

  return {
    load, frame, setStep, clear,
    get step() { return step; }, get maxStep() { return maxStep; },
    setHighlight(on) { highlight = on; setStep(step); },
  };
}
