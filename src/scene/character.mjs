import * as THREE from 'three';
import { DEFAULT_CHARACTER } from './animation.mjs';

const TAU = Math.PI * 2;
const skinColor = DEFAULT_CHARACTER.palette.skin;
const coatColor = '#c99443';

function surface(color, roughness = 0.65, extra = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness, ...extra });
}

function mesh(parent, geometry, material, position = [0, 0, 0]) {
  if (material.vertexColors && !geometry.hasAttribute('color')) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
  }
  const item = new THREE.Mesh(geometry, material);
  item.position.set(...position); item.castShadow = true; item.receiveShadow = true;
  parent.add(item); return item;
}

function ellipsoid(parent, material, position, scale, detail = 40) {
  const item = mesh(parent, new THREE.SphereGeometry(1, detail, 28), material, position);
  item.scale.set(...scale); return item;
}

function line(parent, points, radius, material) {
  return mesh(parent, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), 36, radius, 6, false), material);
}

function tailored(parent, profile, material, depth = 0.68) {
  const ordered = profile[0][1] > profile.at(-1)[1] ? [...profile].reverse() : profile;
  const curve = new THREE.SplineCurve(ordered.map(([r, y]) => new THREE.Vector2(r, y)));
  const item = mesh(parent, new THREE.LatheGeometry(curve.getPoints(64), 64), material);
  item.scale.z = depth; return item;
}

function roundedBox(parent, dimensions, radius, material, position) {
  const [width, height, depth] = dimensions;
  const shape = new THREE.Shape();
  const x = -width / 2; const y = -height / 2;
  shape.moveTo(x + radius, y); shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius); shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius); shape.quadraticCurveTo(x, y, x + radius, y);
  return mesh(parent, new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: radius * 0.3, bevelSize: radius * 0.3, bevelSegments: 3, curveSegments: 12 }), material, position);
}

function lapel(parent, points, material) {
  const shape = new THREE.Shape();
  shape.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) shape.lineTo(...points[i]);
  shape.closePath();
  return mesh(parent, new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3 }), material, [0, 0, 0.257]);
}

export function makePhotoTexture(url = DEFAULT_CHARACTER.resources.photo) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 600;
  const context = canvas.getContext('2d'); context.fillStyle = '#f6eee2'; context.fillRect(0, 0, 512, 600);
  context.fillStyle = '#72909d'; context.fillRect(26, 26, 460, 476);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const image = new Image();
  image.onload = () => {
    const scale = Math.max(460 / image.width, 476 / image.height);
    context.save(); context.beginPath(); context.rect(26, 26, 460, 476); context.clip();
    context.drawImage(image, 26 + (460 - image.width * scale) / 2, 26 + (476 - image.height * scale) / 2, image.width * scale, image.height * scale);
    context.restore(); texture.needsUpdate = true;
  };
  image.src = url; return texture;
}

function sculptedFace(parent, skin) {
  const geometry = new THREE.SphereGeometry(1, 80, 64);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const base = new THREE.Color(skinColor); const cheek = new THREE.Color('#df9d91');
  const shadow = new THREE.Color('#d8ab9d'); const color = new THREE.Color();
  const gaussian = (x, y, xx, yy, sx, sy) => Math.exp(-(((x - xx) / sx) ** 2 + ((y - yy) / sy) ** 2));
  for (let i = 0; i < positions.count; i++) {
    const xx = positions.getX(i); const yy = positions.getY(i); const zz = positions.getZ(i);
    const jaw = yy < -0.13 ? 1 - Math.pow((-yy - 0.13) / 0.87, 1.15) * 0.19 : 1;
    const x = xx * 0.36 * jaw; const y = yy * 0.485 + 0.225;
    const front = THREE.MathUtils.smoothstep(zz, 0.05, 0.78);
    // The nose, cheekbones and eye sockets share one surface, without separate joint-like shapes.
    const bridge = gaussian(x, y, 0, 0.245, 0.042, 0.125) * 0.025;
    const tip = gaussian(x, y, 0, 0.145, 0.045, 0.057) * 0.043;
    const cheeks = (gaussian(x, y, -0.19, 0.13, 0.1, 0.10) + gaussian(x, y, 0.19, 0.13, 0.1, 0.10)) * 0.012;
    const sockets = (gaussian(x, y, -0.145, 0.285, 0.10, 0.056) + gaussian(x, y, 0.145, 0.285, 0.10, 0.056)) * 0.009;
    positions.setXYZ(i, x, y, zz * 0.305 + 0.025 + front * (bridge + tip + cheeks - sockets));
    const blush = (gaussian(x, y, -0.205, 0.10, 0.105, 0.08) + gaussian(x, y, 0.205, 0.10, 0.105, 0.08)) * front * 0.48;
    color.copy(base).lerp(cheek, blush).lerp(shadow, Math.max(0, -yy - 0.4) * 0.12);
    colors.set([color.r / base.r, color.g / base.g, color.b / base.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.computeVertexNormals();
  const face = mesh(parent, geometry, skin); face.receiveShadow = false;
  return face;
}

function almondGeometry() {
  const vertices = []; const indices = []; const rings = 10; const sides = 64;
  for (let r = 0; r <= rings; r++) {
    const radius = r / rings;
    for (let i = 0; i <= sides; i++) {
      const angle = i / sides * TAU;
      const x = Math.cos(angle) * 0.098 * radius;
      const y = Math.sin(angle) * 0.039 * (0.68 + Math.abs(Math.sin(angle)) * 0.32) * radius;
      vertices.push(x, y, 0.014 * (1 - radius * radius));
      if (r < rings && i < sides) {
        const a = r * (sides + 1) + i; const b = a + sides + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function irisTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(128, 128, 30, 128, 128, 126);
  gradient.addColorStop(0, '#b5a16d'); gradient.addColorStop(0.46, '#777a53'); gradient.addColorStop(0.84, '#424b38'); gradient.addColorStop(1, '#28372e');
  context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 96; i++) {
    const angle = i / 96 * TAU;
    context.strokeStyle = i % 3 ? '#c4b78635' : '#263b3550'; context.lineWidth = 1.2;
    context.beginPath(); context.moveTo(128 + Math.cos(angle) * 35, 128 + Math.sin(angle) * 35);
    context.lineTo(128 + Math.cos(angle + 0.02) * 113, 128 + Math.sin(angle + 0.02) * 113); context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

function lipSurface(parent, upper, material) {
  const vertices = []; const indices = []; const smiling = [];
  const columns = 40; const rows = 6;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const x = i / columns * 2 - 1; const round = 1 - x * x;
      const seam = 0.008 * x * x;
      const outline = upper
        ? seam + round * (0.016 + 0.008 * Math.exp(-(((Math.abs(x) - 0.30) / 0.22) ** 2)))
        : seam - round * 0.020;
      const y = THREE.MathUtils.lerp(seam, outline, j / rows);
      const z = 0.005 + Math.sin(j / rows * Math.PI) * round * 0.005;
      vertices.push(x * 0.088, y, z);
      smiling.push(x * 0.088, y + x * x * 0.012, z);
      if (j < rows && i < columns) {
        const a = j * (columns + 1) + i; const b = a + columns + 1;
        if (upper) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(smiling, 3)];
  return mesh(parent, geometry, material);
}

function hairCap(parent, material) {
  const vertices = []; const indices = []; const columns = 100; const rows = 44;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const angle = i / columns * TAU;
      const front = THREE.MathUtils.smoothstep(Math.sin(angle), 0.55, 0.98);
      const maxTheta = THREE.MathUtils.lerp(2.58, 1.02 + Math.cos(angle) * 0.13, front);
      const theta = j / rows * maxTheta;
      const lower = Math.max(0, theta - Math.PI / 2);
      const radius = theta < Math.PI / 2 ? Math.sin(theta) : 1 - lower * 0.085;
      const y = theta < Math.PI / 2 ? 0.25 + Math.cos(theta) * 0.55 : 0.25 - lower * 0.50;
      vertices.push(Math.cos(angle) * radius * 0.432, y, Math.sin(angle) * radius * 0.368 - 0.018);
      if (j < rows && i < columns) {
        const a = j * (columns + 1) + i; const b = a + columns + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return mesh(parent, geometry, material);
}

function hairLock(parent, points, width, material, highlight) {
  const group = new THREE.Group(); group.position.set(...points[0]); parent.add(group);
  const local = points.map((point) => new THREE.Vector3(...point).sub(group.position));
  const path = new THREE.CatmullRomCurve3(local);
  const vertices = []; const indices = []; const steps = 48; const sides = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; const p = path.getPoint(t); const tangent = path.getTangent(t);
    const cross = new THREE.Vector3(tangent.y, -tangent.x, 0).normalize();
    const normal = new THREE.Vector3().crossVectors(tangent, cross).normalize();
    const taper = Math.pow(Math.sin(Math.PI * (0.06 + t * 0.92)), 0.64) * (1 - t * 0.33);
    for (let k = 0; k <= sides; k++) {
      const angle = k / sides * TAU;
      const vertex = p.clone().addScaledVector(cross, Math.cos(angle) * width * taper).addScaledVector(normal, Math.sin(angle) * width * 0.25 * taper);
      vertices.push(vertex.x, vertex.y, vertex.z);
      if (i < steps && k < sides) { const a = i * (sides + 1) + k; const b = a + sides + 1; indices.push(a, a + 1, b, a + 1, b + 1, b); }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); mesh(group, geometry, material);
  for (const offset of [-0.25, 0.3]) {
    const strand = [];
    for (let i = 2; i < 38; i++) {
      const t = i / 42; const p = path.getPoint(t); const tangent = path.getTangent(t);
      p.x += tangent.y * width * offset; p.y -= tangent.x * width * offset; p.z += width * 0.25;
      strand.push(p.toArray());
    }
    line(group, strand, 0.0015, highlight);
  }
  return group;
}

export function buildMira(scene) {
  const root = new THREE.Group(); root.position.set(0.52, 0, 0.3); scene.add(root);
  const body = new THREE.Group(); root.add(body);
  const skin = surface(skinColor, 0.70, { clearcoat: 0.07, clearcoatRoughness: 0.8, vertexColors: true });
  const hair = surface('#302b2b', 0.56, { clearcoat: 0.10, clearcoatRoughness: 0.65, side: THREE.DoubleSide });
  const coat = surface(coatColor, 0.76, { sheen: 0.4, sheenColor: new THREE.Color('#c9a16c'), sheenRoughness: 0.85 });
  const collar = surface('#e4b667', 0.78, { sheen: 0.3 });
  const seams = surface('#a67a38', 0.90); const shirt = surface('#c3b59d', 0.92);
  const leather = surface('#344641', 0.62); const silver = surface('#d9e4df', 0.26, { metalness: 0.72 });
  const dark = surface('#283633', 0.58); const lips = surface('#bd7f7b', 0.67);

  tailored(body, [[0.35, 1.32], [0.45, 1.38], [0.47, 1.64], [0.40, 2.05], [0.405, 2.39], [0.45, 2.61], [0.38, 2.74], [0.21, 2.80]], coat, 0.72);
  ellipsoid(body, shirt, [0, 2.66, 0.02], [0.20, 0.21, 0.21]);
  const neckGeometry = new THREE.CylinderGeometry(0.108, 0.14, 0.27, 40);
  const neckTint = new Float32Array(neckGeometry.attributes.position.count * 3);
  for (let i = 0; i < neckGeometry.attributes.position.count; i++) {
    const shade = THREE.MathUtils.lerp(0.70, 0.88, (neckGeometry.attributes.position.getY(i) + 0.135) / 0.27);
    neckTint.set([shade, shade, shade], i * 3);
  }
  neckGeometry.setAttribute('color', new THREE.BufferAttribute(neckTint, 3));
  mesh(body, neckGeometry, skin, [0, 2.89, 0.025]);
  lapel(body, [[-0.39, 2.68], [-0.23, 2.83], [-0.035, 2.55], [-0.12, 2.31], [-0.31, 2.53]], collar);
  lapel(body, [[0.39, 2.68], [0.23, 2.83], [0.035, 2.55], [0.12, 2.31], [0.31, 2.53]], collar);
  line(body, [[0.0, 2.48, 0.31], [0.012, 2.05, 0.303], [0.01, 1.41, 0.338]], 0.007, seams);
  for (const side of [-1, 1]) {
    line(body, [[side * 0.18, 1.83, 0.306], [side * 0.34, 1.79, 0.27]], 0.006, seams);
    line(body, [[side * 0.24, 2.70, 0.27], [side * 0.29, 2.34, 0.33], [side * 0.20, 1.98, 0.46]], 0.021, leather);
    ellipsoid(body, silver, [side * 0.25, 2.64, 0.306], [0.014, 0.014, 0.006], 16);
    for (let i = 0; i < 3; i++) ellipsoid(body, seams, [0.05, 2.20 - i * 0.24, 0.322], [0.012, 0.012, 0.006], 12);
  }

  const camera = new THREE.Group(); camera.position.set(0.02, 1.96, 0.40); camera.rotation.z = -0.055; body.add(camera);
  roundedBox(camera, [0.43, 0.28, 0.18], 0.035, leather, [0, 0, -0.07]);
  roundedBox(camera, [0.40, 0.04, 0.19], 0.012, silver, [0, 0.135, -0.074]);
  roundedBox(camera, [0.14, 0.055, 0.13], 0.012, dark, [0.07, 0.17, -0.05]);
  const barrel = mesh(camera, new THREE.CylinderGeometry(0.106, 0.112, 0.12, 48), dark, [0, 0, 0.145]); barrel.rotation.x = Math.PI / 2;
  const rim = mesh(camera, new THREE.TorusGeometry(0.089, 0.008, 12, 48), silver, [0, 0, 0.211]);
  const lens = mesh(camera, new THREE.CircleGeometry(0.081, 48), surface('#193b43', 0.13, { metalness: 0.25, clearcoat: 1 }), [0, 0, 0.213]);
  ellipsoid(lens, surface('#a7d4d2', 0.2), [-0.021, 0.025, 0.003], [0.012, 0.015, 0.002], 12);

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group(); arm.position.set(side * 0.415, 2.66, 0.005); body.add(arm);
    tailored(arm, [[0.065, 0.04], [0.126, -0.02], [0.153, -0.15], [0.137, -0.33], [0.123, -0.57], [0.112, -0.65]], coat, 0.92);
    const elbow = new THREE.Group(); elbow.position.set(0, -0.55, 0); arm.add(elbow);
    tailored(elbow, [[0.112, 0.065], [0.124, -0.015], [0.120, -0.18], [0.106, -0.38], [0.096, -0.49]], coat, 0.94);
    tailored(elbow, [[0.095, -0.40], [0.106, -0.43], [0.105, -0.49], [0.095, -0.51]], collar, 0.94);
    line(elbow, [[-0.09, -0.13, 0.067], [0.0, -0.15, 0.113], [0.09, -0.13, 0.067]], 0.003, seams);
    const hand = new THREE.Group(); hand.position.set(0, -0.565, 0.015); hand.rotation.y = side * -0.18; elbow.add(hand);
    ellipsoid(hand, skin, [0, -0.012, 0], [0.076, 0.118, 0.052]);
    ellipsoid(hand, skin, [side * 0.063, 0.005, 0.025], [0.033, 0.071, 0.038]).rotation.z = side * -0.35;
    for (let i = 0; i < 4; i++) {
      const finger = ellipsoid(hand, skin, [(i - 1.5) * 0.032, -0.108 - (i === 1 || i === 2 ? 0.015 : 0), 0.004], [0.019, 0.058 - Math.abs(i - 1.4) * 0.008, 0.023], 24);
      finger.rotation.z = (i - 1.5) * -0.025;
    }
    arms.push({ arm, elbow, hand, side });
  }
  const photo = mesh(arms[1].hand, new THREE.PlaneGeometry(0.39, 0.46), surface('#ffffff', 0.85, { map: makePhotoTexture(), side: THREE.DoubleSide }), [0.035, -0.025, 0.07]);
  photo.rotation.z = -0.10; photo.visible = false;
  const pants = surface('#3b4a47', 0.93);
  for (const side of [-1, 1]) {
    ellipsoid(body, pants, [side * 0.215, 1.10, 0.06], [0.20, 0.45, 0.24]);
    const leg = mesh(body, new THREE.CylinderGeometry(0.145, 0.12, 0.82, 40), pants, [side * 0.22, 0.50, 0.075]); leg.rotation.z = side * -0.025;
    ellipsoid(body, leather, [side * 0.22, 0.13, 0.19], [0.15, 0.135, 0.26]);
  }

  const head = new THREE.Group(); head.position.set(0, 3.17, 0.025); root.add(head);
  const face = sculptedFace(head, skin);
  for (const side of [-1, 1]) {
    ellipsoid(head, skin, [side * 0.35, 0.17, 0.015], [0.045, 0.083, 0.047]);
    const hoop = mesh(head, new THREE.TorusGeometry(0.023, 0.0055, 8, 28), silver, [side * 0.37, 0.080, 0.054]); hoop.rotation.y = side * 0.2;
  }
  const whites = surface('#f0e7dd', 0.42, { clearcoat: 0.12, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 1, stencilZPass: THREE.ReplaceStencilOp });
  const lash = surface('#57403a', 0.90); const browMaterial = surface('#584138', 0.90);
  const irisMask = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc };
  const eyeTexture = irisTexture(); const eyes = []; const brows = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group(); eye.position.set(side * 0.145, 0.285, 0.312); eye.rotation.y = side * 0.28; eye.rotation.z = side * 0.045; head.add(eye);
    const white = mesh(eye, almondGeometry(), whites); white.receiveShadow = false; white.renderOrder = 1;
    // The stencil follows the eyelid, keeping a larger iris inside the almond silhouette during gaze and blinks.
    const iris = new THREE.Group(); iris.position.set(0.003 * -side, 0.006, 0.027); eye.add(iris);
    mesh(iris, new THREE.CircleGeometry(0.043, 48), surface('#3c4131', 0.45, irisMask), [0, 0, -0.001]);
    mesh(iris, new THREE.CircleGeometry(0.040, 48), surface('#ffffff', 0.4, { map: eyeTexture, ...irisMask }), [0, 0, 0]);
    mesh(iris, new THREE.CircleGeometry(0.0185, 40), surface('#1c2827', 0.32, irisMask), [0, 0, 0.001]);
    ellipsoid(iris, surface('#ffffff', 0.2, { emissive: '#ffffff', emissiveIntensity: 0.16, ...irisMask }), [-0.011, 0.014, 0.004], [0.008, 0.008, 0.003], 16);
    ellipsoid(iris, surface('#efe6d5', 0.3, irisMask), [0.013, -0.014, 0.003], [0.003, 0.003, 0.002], 12);
    iris.children.forEach((item) => { item.renderOrder = 2; item.castShadow = false; item.receiveShadow = false; });
    const upper = line(eye, [[-0.098, 0, 0.008], [-0.049, 0.034, 0.014], [0.032, 0.037, 0.014], [0.098, 0.003, 0.008]], 0.0045, lash);
    line(eye, [[-0.096, -0.002, 0.008], [-0.030, -0.036, 0.012], [0.035, -0.034, 0.012], [0.097, 0.003, 0.008]], 0.0016, lips);
    line(eye, [[side * 0.081, 0.022, 0.008], [side * 0.106, 0.017, 0.009], [side * 0.114, 0.025, 0.009]], 0.0024, lash);
    eye.children.filter((item) => item !== iris && item !== white).forEach((item) => { item.renderOrder = 3; item.castShadow = false; });
    const brow = line(head, [[side * 0.066, 0.389, 0.304], [side * 0.15, 0.408, 0.294], [side * 0.250, 0.392, 0.252]], 0.006, browMaterial);
    eyes.push({ eye, iris, upper }); brows.push(brow);
  }
  const mouth = new THREE.Group(); mouth.position.set(0, -0.018, 0.308); head.add(mouth);
  const mouthInside = ellipsoid(mouth, surface('#703d3e', 0.9), [0, 0, -0.001], [0.085, 0.003, 0.004]);
  const lowerLip = lipSurface(mouth, false, lips);
  const upperLip = lipSurface(mouth, true, surface('#ab706f', 0.74));

  hairCap(head, hair);
  const shine = surface('#695240', 0.7, { transparent: true, opacity: 0.23, depthWrite: false });
  const hairLocks = [
    hairLock(head, [[0.12, 0.77, 0.10], [-0.035, 0.70, 0.286], [-0.20, 0.58, 0.330], [-0.31, 0.39, 0.285], [-0.34, 0.23, 0.205]], 0.115, hair, shine),
    hairLock(head, [[0.13, 0.77, 0.09], [0.27, 0.68, 0.25], [0.35, 0.48, 0.255], [0.38, 0.23, 0.185], [0.36, -0.13, 0.145]], 0.077, hair, shine),
    hairLock(head, [[-0.29, 0.56, 0.18], [-0.39, 0.33, 0.20], [-0.405, 0.05, 0.16], [-0.39, -0.23, 0.12], [-0.33, -0.29, 0.13]], 0.077, hair, shine),
    hairLock(head, [[0.37, 0.50, 0.10], [0.425, 0.25, 0.105], [0.425, -0.02, 0.08], [0.39, -0.25, 0.055], [0.33, -0.29, 0.07]], 0.061, hair, shine),
  ];
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i / 10 * TAU; const radius = i % 2 ? 0.037 : 0.080; const p = [Math.cos(a) * radius, Math.sin(a) * radius]; if (i) starShape.lineTo(...p); else starShape.moveTo(...p); }
  starShape.closePath();
  const star = mesh(head, new THREE.ExtrudeGeometry(starShape, { depth: 0.010, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005, bevelSegments: 3 }), silver, [0.369, 0.424, 0.253]); star.rotation.z = -0.19; star.rotation.y = 0.30;
  return { root, body, head, face, eyes, brows, mouth, mouthInside, lowerLip, upperLip, arms, photo, camera, hairLocks, materials: { skin, hair, coat, collar } };
}
