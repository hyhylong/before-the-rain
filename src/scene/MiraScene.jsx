import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ActionScheduler, characterSchema, DEFAULT_CHARACTER, EmotionMixer, mouthShape, PresenceMotion } from './animation.mjs';
import { buildMira } from './character.mjs';

const C = { wall: '#254d48', frame: '#b6b9a0', wood: '#986b52' };

function material(color, roughness = 0.72, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra });
}

function ball(parent, mat, x, y, z, sx, sy = sx, sz = sx, segments = 32) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, 24), mat);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function box(parent, mat, x, y, z, w, h, d, radius = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, radius ? 2 : 1), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, mat, x, y, z, r, h, bottom = r, count = 32) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, bottom, h, count), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function curve(parent, points, radius, mat) {
  const path = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 20, radius, 7, false), mat);
  parent.add(mesh);
  return mesh;
}

function makePhotoTexture(photoUrl = DEFAULT_CHARACTER.resources.photo) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f0e6';
  ctx.fillRect(0, 0, 512, 600);
  const sky = ctx.createLinearGradient(0, 30, 0, 470);
  sky.addColorStop(0, '#7a9eab');
  sky.addColorStop(0.6, '#e2b5a2');
  sky.addColorStop(1, '#798e8e');
  ctx.fillStyle = sky;
  ctx.fillRect(28, 28, 456, 465);
  ctx.fillStyle = '#f0cf9c';
  ctx.beginPath(); ctx.arc(335, 173, 35, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#557b83';
  ctx.fillRect(28, 320, 456, 173);
  ctx.fillStyle = '#354d4b';
  ctx.beginPath(); ctx.moveTo(28, 410); ctx.lineTo(220, 375); ctx.lineTo(320, 493);
  ctx.lineTo(28, 493); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ebe5d5';
  ctx.beginPath(); ctx.moveTo(178, 340); ctx.lineTo(191, 183); ctx.lineTo(216, 183);
  ctx.lineTo(231, 340); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#9e5a51';
  ctx.fillRect(186, 179, 36, 15); ctx.fillRect(183, 226, 40, 23);
  ctx.beginPath(); ctx.moveTo(180, 177); ctx.lineTo(204, 154); ctx.lineTo(228, 177); ctx.fill();
  ctx.fillStyle = '#f4d7a2'; ctx.fillRect(195, 182, 19, 11);
  ctx.strokeStyle = '#b5c3bd'; ctx.lineWidth = 2;
  for (let i = 0; i < 11; i++) {
    const x = 50 + (i * 79) % 420; const y = 345 + (i * 37) % 135;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 36, y - 3); ctx.stroke();
  }
  ctx.fillStyle = '#566660'; ctx.font = 'italic 24px Georgia';
  ctx.fillText('one more sunrise.', 44, 551);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const photo = new Image();
  photo.onload = () => {
    const ratio = Math.max(456 / photo.width, 465 / photo.height);
    ctx.save(); ctx.beginPath(); ctx.rect(28, 28, 456, 465); ctx.clip();
    ctx.drawImage(photo, 28 + (456 - photo.width * ratio) / 2, 28 + (465 - photo.height * ratio) / 2, photo.width * ratio, photo.height * ratio);
    ctx.restore(); texture.needsUpdate = true;
  };
  photo.src = photoUrl;
  return texture;
}

function buildPlant(parent, x, z, scale = 1) {
  const group = new THREE.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale); parent.add(group);
  const pot = material('#c38370');
  cylinder(group, pot, 0, 0.37, 0, 0.36, 0.65, 0.26);
  cylinder(group, material('#3f4237'), 0, 0.70, 0, 0.315, 0.015);
  const stem = material('#54735b');
  const leaf = material('#60836c', 0.9, { side: THREE.DoubleSide });
  for (let i = 0; i < 9; i++) {
    const a = i * 2.399; const height = 0.85 + (i % 4) * 0.24;
    const xx = Math.cos(a) * (0.27 + (i % 3) * 0.06);
    const zz = Math.sin(a) * 0.32;
    curve(group, [[0, 0.7, 0], [xx * 0.5, height * 0.8, zz * 0.5], [xx, height, zz]], 0.016, stem);
    const l = ball(group, leaf, xx, height + 0.13, zz, 0.16, 0.36, 0.05, 20);
    l.rotation.set(Math.sin(a) * 0.5, a, -Math.cos(a) * 0.5);
  }
}

function buildCafe(scene) {
  const wall = material(C.wall);
  const wood = material(C.wood);
  const darkWood = material('#514a40');
  const frame = material(C.frame, 0.5);
  const brass = material('#c4a474', 0.4, { metalness: 0.35 });
  const room = new THREE.Group(); scene.add(room);
  box(room, wall, 0, 2.35, -3.25, 17, 5.8, 0.3);
  box(room, material('#687268'), 0, -0.07, 0, 22, 0.14, 17);
  box(room, material('#31534b'), 4.3, 2.3, 0, 0.2, 5.5, 7);
  const sky = material('#314d5d', 1, { emissive: '#182d3d', emissiveIntensity: 0.45 });
  box(room, sky, -1.6, 3.0, -3.02, 6.1, 4.45, 0.025);
  const outside = new THREE.Group(); outside.position.z = -2.94; room.add(outside);
  for (let i = 0; i < 9; i++) {
    const xx = -4.3 + i * 0.66;
    const height = 1.3 + (i * 17 % 10) / 10;
    const building = material(i % 2 ? '#233e47' : '#2c4952');
    box(outside, building, xx, 1.3 + height / 2, 0.015, 0.59, height, 0.025);
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 2; k++) {
        box(outside, material((i + j) % 3 ? '#8e9991' : '#d6bb88', 1, { emissive: '#b5a07a', emissiveIntensity: 0.25 }),
          xx - 0.17 + k * 0.29, 1.6 + j * 0.46, 0.04, 0.11, 0.19, 0.018);
      }
    }
  }
  box(outside, material('#82989b', 0.4), -1.5, 1.2, 0.04, 6.2, 0.15, 0.02);
  box(outside, material('#ae6964', 1, { emissive: '#ce6e66', emissiveIntensity: 0.4 }), -3.26, 2.65, 0.06, 0.09, 0.77, 0.035);
  box(room, frame, -4.72, 2.95, -2.84, 0.11, 4.5, 0.14);
  box(room, frame, 1.5, 2.95, -2.84, 0.11, 4.5, 0.14);
  for (const x of [-2.65, -0.58]) box(room, frame, x, 2.95, -2.84, 0.075, 4.5, 0.14);
  box(room, frame, -1.62, 4.85, -2.84, 6.25, 0.10, 0.14);
  box(room, frame, -1.62, 1.0, -2.84, 6.25, 0.10, 0.14);
  box(room, frame, -1.62, 3.64, -2.84, 6.25, 0.055, 0.14);
  box(room, wood, -1.6, 0.9, -2.7, 6.5, 0.16, 0.47);
  const curtain = material('#607e72');
  for (let i = 0; i < 6; i++) cylinder(room, curtain, -4.65 + i * 0.11, 2.9, -2.62, 0.095, 4.0);

  // The rear counter, ceramics and small wall print make this a place rather than a backdrop.
  box(room, material('#527266'), 3, 1.2, -2.25, 2.8, 2.1, 1.2);
  box(room, wood, 3, 2.3, -2.2, 3.0, 0.14, 1.45);
  for (const x of [2.15, 3.0, 3.75]) {
    curve(room, [[x, 0.25, -1.62], [x, 1.8, -1.62]], 0.009, material('#36584f'));
  }
  box(room, darkWood, 3.03, 3.36, -2.99, 1.3, 1.18, 0.1);
  box(room, material('#e2caa4'), 3.03, 3.36, -2.92, 1.16, 1.03, 0.025);
  const art = material('#d28274');
  ball(room, art, 3.03, 3.49, -2.88, 0.23, 0.23, 0.02);
  box(room, material('#557267'), 3.03, 3.05, -2.87, 0.5, 0.17, 0.025);
  const espresso = material('#c9cebe');
  box(room, espresso, 3.12, 2.65, -2.30, 0.76, 0.55, 0.54);
  box(room, darkWood, 3.12, 2.60, -1.99, 0.65, 0.19, 0.04);
  for (const x of [2.94, 3.24]) cylinder(room, material('#b9cec6'), x, 2.94, -2.31, 0.09, 0.11);

  const table = new THREE.Group(); table.position.set(-1.50, 0, 1.05); room.add(table);
  cylinder(table, darkWood, 0, 0.70, 0, 0.055, 1.4);
  cylinder(table, darkWood, 0, 0.05, 0, 0.44, 0.07);
  cylinder(table, material('#b58d68'), 0, 1.42, 0, 0.95, 0.11);
  cylinder(table, material('#c8a27b'), 0, 1.482, 0, 0.93, 0.015);
  const ceramic = material('#d4dfce');
  cylinder(table, ceramic, 0.15, 1.51, 0.12, 0.19, 0.027);
  cylinder(table, ceramic, 0.15, 1.64, 0.12, 0.115, 0.22, 0.088);
  cylinder(table, material('#553d2d'), 0.15, 1.754, 0.12, 0.097, 0.007);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.019, 8, 24), ceramic);
  handle.position.set(0.266, 1.65, 0.12); table.add(handle);
  box(table, material('#be7468'), -0.37, 1.51, -0.18, 0.30, 0.03, 0.40).rotation.y = -0.3;
  box(table, material('#e3dac3'), -0.37, 1.53, -0.18, 0.27, 0.015, 0.37).rotation.y = -0.3;
  cylinder(room, material('#7d8c71'), 0.52, 0.94, 0.30, 0.53, 0.12);
  for (const x of [0.17, 0.87]) for (const z of [-0.02, 0.61]) cylinder(room, darkWood, x, 0.46, z, 0.035, 0.92);
  buildPlant(room, -3.38, -1.30, 1.17);
  buildPlant(room, 3.30, -0.50, 0.9);

  const bulbs = [];
  for (const [x, y, z, size] of [[-1.8, 4.35, 0.1, 0.40], [2.2, 4.4, -0.85, 0.33]]) {
    cylinder(room, darkWood, x, y + 0.6, z, 0.013, 1.0);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(size, 0.29, 48, 1, true), brass);
    shade.position.set(x, y, z); room.add(shade);
    const bulb = ball(room, material('#ffdab0', 0.3, { emissive: '#ffd8a2', emissiveIntensity: 2 }), x, y - 0.10, z, 0.10);
    bulb.castShadow = false;
    const light = new THREE.PointLight('#ffd5a2', 9, 7, 2);
    light.position.set(x, y - 0.17, z); room.add(light); bulbs.push(light);
  }

  const rainCount = 400;
  const rainData = new Float32Array(rainCount * 6);
  for (let i = 0; i < rainCount; i++) {
    const x = -4.65 + Math.random() * 6.1;
    const y = 1.0 + Math.random() * 3.8;
    const z = -2.72 + Math.random() * 0.08;
    rainData.set([x, y, z, x - 0.024, y + 0.16, z], i * 6);
  }
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainData, 3));
  const rainMaterial = new THREE.LineBasicMaterial({ color: '#d1e1dd', transparent: true, opacity: 0.35, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeometry, rainMaterial); room.add(rain);
  return { room, sky, rain, rainData, rainGeometry, rainMaterial, bulbs };
}

export default function MiraScene({
  status = 'idle', emotion = 'curious', gesture = 'idle', weather = 'rain',
  effect = null, speakingLevel = 0, viseme = null, reducedMotion = false, onReady, onError,
}) {
  const container = useRef(null);
  const latest = useRef({ status, emotion, gesture, weather, effect, speakingLevel, viseme, reducedMotion });
  const callbacks = useRef({ onReady, onError });
  const [failed, setFailed] = useState(false);
  latest.current = { status, emotion, gesture, weather, effect, speakingLevel, viseme, reducedMotion };
  callbacks.current = { onReady, onError };

  useEffect(() => {
    const node = container.current;
    if (!node) return undefined;
    let renderer;
    let frame;
    let disposed = false;
    let resizeObserver;
    let scene;
    let onPointer;
    const configController = new AbortController();
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute('data-testid', 'scene-canvas');
      renderer.domElement.setAttribute('aria-label', 'Mira, a travel photographer in an amber raincoat, in a rainy night cafe');
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
      node.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#364e4c');
      scene.fog = new THREE.Fog('#354e49', 13, 26);
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 45);
      camera.position.set(0.1, 3.0, 8.0);
      camera.lookAt(0.1, 2.52, 0);
      scene.add(new THREE.HemisphereLight('#dce8ed', '#686858', 1.75));
      const key = new THREE.DirectionalLight('#fff0de', 2.7);
      key.position.set(-3.8, 5.8, 6.5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -5; key.shadow.camera.right = 5;
      key.shadow.camera.top = 6; key.shadow.camera.bottom = -1;
      key.shadow.normalBias = 0.025;
      key.shadow.bias = -0.0002;
      key.shadow.radius = 6;
      scene.add(key);
      const fill = new THREE.DirectionalLight('#e8e4e0', 1.25);
      fill.position.set(3.5, 3.7, 6.5); scene.add(fill);
      const windowLight = new THREE.DirectionalLight('#9cbdd6', 1.6);
      windowLight.position.set(-3, 4, -1.8); scene.add(windowLight);
      const rim = new THREE.DirectionalLight('#ffe0b7', 1.4);
      rim.position.set(3.2, 4, -1.6); scene.add(rim);
      const flash = new THREE.PointLight('#ffffff', 0, 20, 0.5);
      flash.position.set(0.5, 3.4, 4); scene.add(flash);
      const cafe = buildCafe(scene);
      const mira = buildMira(scene);
      let character = DEFAULT_CHARACTER;
      const scheduler = new ActionScheduler(character);
      const emotions = new EmotionMixer();
      const presence = new PresenceMotion();
      const rest = {
        body: mira.body.position.clone(), head: mira.head.position.clone(),
        photo: mira.photo.position.clone(),
        irises: mira.eyes.map(({ iris }) => iris.position.clone()),
        brows: mira.brows.map((brow) => ({ y: brow.position.y, z: brow.rotation.z })),
        hair: (mira.hairLocks || []).map((lock) => ({ lock, rotation: lock.rotation.clone() })),
      };
      let captureOverride = {};
      renderer.domElement.__capture = () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); };
      renderer.domElement.__direct = (overrides = {}) => { captureOverride = overrides; };
      renderer.domElement.__inspect = () => ({
        action: scheduler.current,
        photoVisible: mira.photo.visible,
        mouth: { width: mira.mouthInside.scale.x, height: mira.mouthInside.scale.y },
        pose: { bodyYaw: mira.body.rotation.y, headYaw: mira.head.rotation.y, headRoll: mira.head.rotation.z, leftElbow: mira.arms[0]?.elbow.rotation.x, rightElbow: mira.arms[1]?.elbow.rotation.x },
        palette: { coat: `#${mira.materials.coat.color.getHexString()}` },
      });
      fetch('/character.json', { signal: configController.signal }).then((response) => {
        if (!response.ok) throw new Error('character-config');
        return response.json();
      }).then((value) => {
        if (disposed) return;
        character = characterSchema.parse(value);
        scheduler.configure(character);
        for (const [name, color] of Object.entries(character.palette)) mira.materials[name]?.color.set(color);
        const old = mira.photo.material.map;
        mira.photo.material.map = makePhotoTexture(character.resources.photo);
        mira.photo.material.needsUpdate = true;
        old.dispose();
      }).catch((error) => { if (error.name !== 'AbortError') renderer.domElement.dataset.config = 'fallback'; });
      const pointer = { x: 0, y: 0 };
      onPointer = (event) => {
        const rect = node.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      };
      node.addEventListener('pointermove', onPointer, { passive: true });
      const resize = () => {
        const width = node.clientWidth || 1;
        const height = node.clientHeight || 1;
        const aspect = width / height;
        camera.aspect = aspect;
        camera.fov = aspect < 0.75 ? 37 : 35;
        camera.position.set(aspect < 0.8 ? 0.50 : 0.10, 3.02, aspect < 0.7 ? 8.5 : 8.0);
        camera.lookAt(aspect < 0.8 ? 0.50 : 0.10, 2.49, 0);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(node); resize();
      const clock = new THREE.Clock();
      let previous = 0;
      let clearMix = 0;
      let lastEffect = null;
      let flashAmount = 0;
      let ready = false;
      const rainColor = new THREE.Color('#314d5d');
      const clearColor = new THREE.Color('#c4b99e');
      const clearEmissive = new THREE.Color('#7d8a83');
      const rainEmissive = new THREE.Color('#182d3d');
      const photoParentRotation = new THREE.Quaternion();
      const photoGripOffset = new THREE.Vector3();
      const animate = () => {
        if (disposed) return;
        frame = requestAnimationFrame(animate);
        const elapsed = clock.getElapsedTime();
        const dt = Math.min(elapsed - previous, 0.10); previous = elapsed;
        const props = { ...latest.current, ...captureOverride };
        const motion = props.reducedMotion ? 0.1 : 1;
        const smooth = 1 - Math.exp(-dt * 5);
        const isSpeaking = props.status === 'speaking';
        const isListening = props.status === 'listening';
        const isThinking = props.status === 'thinking';
        const action = scheduler.update(props, elapsed);
        const pose = action.pose;
        const blend = 1 - Math.exp(-dt / action.blendSeconds);
        const show = pose.photo;
        const wave = action.name === 'wave';
        const feelings = emotions.step(props.emotion, dt);
        const warm = feelings.warm;
        const sad = feelings.melancholy;
        const guarded = feelings.guarded;
        const level = isSpeaking ? Math.max(0, Math.min(1, Number(props.speakingLevel) || 0)) : 0;
        const alive = presence.step(elapsed, dt, { action: action.name, level, listening: isListening, blinkSeconds: character.idle.blinkSeconds });
        clearMix = THREE.MathUtils.lerp(clearMix, props.weather === 'clearing' ? 1 : 0, dt * 0.75);
        cafe.sky.color.copy(rainColor).lerp(clearColor, clearMix);
        cafe.sky.emissive.copy(rainEmissive).lerp(clearEmissive, clearMix);
        windowLight.color.set(clearMix > 0.5 ? '#e4dcc0' : '#9cbdd6');
        cafe.rainMaterial.opacity = 0.35 * (1 - clearMix);
        cafe.rain.visible = clearMix < 0.99;
        if (!props.reducedMotion && clearMix < 0.99) {
          const positions = cafe.rainData;
          for (let i = 0; i < positions.length; i += 6) {
            const step = dt * (2.1 + (i % 7) * 0.13);
            positions[i + 1] -= step; positions[i + 4] -= step;
            if (positions[i + 1] < 1.0) { positions[i + 1] += 3.8; positions[i + 4] += 3.8; }
          }
          cafe.rainGeometry.attributes.position.needsUpdate = true;
        }
        if (props.effect !== lastEffect) {
          if (props.effect === 'shutter') flashAmount = 8;
          if (props.effect === 'lightning') flashAmount = 15;
          lastEffect = props.effect;
        }
        flashAmount *= Math.exp(-dt * 8);
        flash.intensity = props.reducedMotion ? 0 : flashAmount;
        const breath = alive.breath * character.idle.breath * motion;
        mira.body.position.y = rest.body.y + breath * 0.32;
        mira.body.position.x = rest.body.x + alive.shift * 0.032 * motion;
        mira.body.rotation.y = THREE.MathUtils.lerp(mira.body.rotation.y, -0.105 + alive.shift * 0.035 * motion, smooth * 0.45);
        mira.body.rotation.z = THREE.MathUtils.lerp(mira.body.rotation.z, -0.012 + alive.shift * 0.018 * motion + alive.audio * 0.006, smooth * 0.55);
        mira.body.rotation.x = THREE.MathUtils.lerp(mira.body.rotation.x, isListening ? -0.018 : 0.004 + alive.audio * 0.009 * motion, smooth);
        mira.head.position.y = rest.head.y + breath * 0.7;
        mira.head.position.x = rest.head.x + alive.shift * 0.043 * motion;
        mira.head.position.z = THREE.MathUtils.lerp(mira.head.position.z, rest.head.z + (isListening ? 0.025 : 0), smooth);
        const lookAway = action.name === 'lookAway' || action.name === 'thinking';
        const idleGaze = alive.headYaw * character.idle.gaze * motion;
        const yaw = pose.headYaw + pointer.x * 0.035 * motion + (lookAway ? 0 : idleGaze);
        const nod = action.name === 'nod' ? alive.nod * motion : 0;
        const pitch = sad * 0.055 + pose.headPitch + nod + pointer.y * 0.012 * motion - alive.headPitch * 0.025 * motion + alive.audio * 0.011 * motion;
        mira.head.rotation.y = THREE.MathUtils.lerp(mira.head.rotation.y, yaw, blend);
        mira.head.rotation.x = THREE.MathUtils.lerp(mira.head.rotation.x, pitch, blend);
        mira.head.rotation.z = THREE.MathUtils.lerp(mira.head.rotation.z, pose.headRoll - warm * 0.022 + alive.shift * 0.025 * motion, blend);
        mira.eyes.forEach(({ eye, iris }, index) => {
          const blink = props.reducedMotion ? 1 : index === 0 ? alive.blinkLeft : alive.blinkRight;
          eye.scale.y = (1 - warm * 0.08 - guarded * 0.10 + (isListening ? 0.045 : 0)) * blink;
          iris.position.x = THREE.MathUtils.lerp(iris.position.x, rest.irises[index].x + (lookAway ? -0.012 : pointer.x * 0.007 + alive.gazeX * 0.009) * motion, smooth * 1.5);
          iris.position.y = THREE.MathUtils.lerp(iris.position.y, rest.irises[index].y - (pointer.y * 0.004 + alive.gazeY * 0.007) * motion, smooth * 1.5);
        });
        mira.brows.forEach((brow, index) => {
          brow.position.y = THREE.MathUtils.lerp(brow.position.y, rest.brows[index].y + sad * 0.016 - guarded * 0.014 + (isListening ? 0.015 : 0) + (index ? 0 : alive.audio * 0.006), smooth);
          brow.rotation.z = THREE.MathUtils.lerp(brow.rotation.z, rest.brows[index].z + (index ? -1 : 1) * (sad * 0.07 - guarded * 0.04), smooth);
        });
        const shape = mouthShape(props.viseme, level);
        const mouthOpen = isSpeaking ? Math.min(0.029, 0.003 + Math.max(0, shape.height - 0.006) * 0.36) : 0.003;
        mira.mouthInside.scale.y = THREE.MathUtils.lerp(mira.mouthInside.scale.y, mouthOpen, smooth * 1.6);
        mira.mouthInside.scale.x = THREE.MathUtils.lerp(mira.mouthInside.scale.x, shape.width + warm * 0.005 - guarded * 0.004, smooth);
        mira.lowerLip.position.y = -mouthOpen * 0.5;
        mira.upperLip.position.y = mouthOpen * 0.45;
        mira.upperLip.scale.x = THREE.MathUtils.lerp(mira.upperLip.scale.x, shape.width / 0.088, smooth);
        mira.lowerLip.scale.x = mira.upperLip.scale.x;
        mira.upperLip.morphTargetInfluences[0] = warm * 0.8 + feelings.curious * 0.25;
        mira.lowerLip.morphTargetInfluences[0] = mira.upperLip.morphTargetInfluences[0];
        mira.mouth.rotation.z = sad * 0.02;
        mira.mouth.scale.x = THREE.MathUtils.lerp(mira.mouth.scale.x, 1 + warm * 0.08 - guarded * 0.07, smooth);
        mira.photo.visible = show && alive.age > 0.28;
        for (const { arm, elbow, hand, side } of mira.arms) {
          const right = side === 1;
          const idlePose = character.actions.idle.pose;
          const waveAmount = wave && !right ? alive.wave : 1;
          const baseX = right ? idlePose.rightArmX : idlePose.leftArmX;
          const baseZ = right ? idlePose.rightArmZ : idlePose.leftArmZ;
          const targetX = THREE.MathUtils.lerp(baseX, right ? pose.rightArmX : pose.leftArmX, waveAmount) + (show && right ? 0 : (right ? -0.016 : 0.025) + breath * side * 0.5 + alive.audio * (right ? 0.012 : -0.018));
          const targetZ = THREE.MathUtils.lerp(baseZ, right ? pose.rightArmZ : pose.leftArmZ, waveAmount) + (show && right ? 0 : side * alive.shift * 0.014 * motion);
          arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, targetX, blend);
          arm.rotation.z = THREE.MathUtils.lerp(arm.rotation.z, targetZ, blend);
          elbow.rotation.x = THREE.MathUtils.lerp(elbow.rotation.x, show && right ? pose.elbowX : (right ? -0.58 : -0.185) - alive.audio * 0.025, blend * 0.8);
          elbow.rotation.z = THREE.MathUtils.lerp(elbow.rotation.z, wave && !right ? -1.75 * alive.wave : 0, Math.min(1, blend * 1.15));
          hand.rotation.z = THREE.MathUtils.lerp(hand.rotation.z, wave && !right ? Math.sin(alive.age * 8.5) * 0.18 * alive.wave * motion : show && right ? 0.1 : side * 0.055 + alive.shift * 0.035 * motion, smooth);
          hand.rotation.x = THREE.MathUtils.lerp(hand.rotation.x, show && right ? 0.02 : 0.075 + side * 0.025, smooth);
        }
        if (mira.photo.visible) {
          mira.photo.parent.getWorldQuaternion(photoParentRotation);
          mira.photo.quaternion.copy(photoParentRotation).invert().multiply(camera.quaternion);
          mira.photo.rotateY(-0.12); mira.photo.rotateZ(-0.10);
          photoGripOffset.set(0, 0.16, 0.05).applyQuaternion(mira.photo.quaternion);
          mira.photo.position.copy(rest.photo).add(photoGripOffset);
        }
        rest.hair.forEach(({ lock, rotation }, index) => {
          const lag = Math.sin(elapsed * 1.25 - index * 0.65) * 0.004 * motion;
          lock.rotation.z = THREE.MathUtils.lerp(lock.rotation.z, rotation.z + lag - mira.head.rotation.z * 0.10, smooth * 0.55);
          lock.rotation.x = THREE.MathUtils.lerp(lock.rotation.x, rotation.x - mira.head.rotation.x * 0.07 + alive.audio * 0.006, smooth * 0.45);
        });
        renderer.render(scene, camera);
        if (!ready) { ready = true; callbacks.current.onReady?.(); }
      };
      animate();
    } catch (error) {
      setFailed(true);
      callbacks.current.onError?.(error);
    }
    return () => {
      disposed = true;
      configController.abort();
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      if (onPointer) node.removeEventListener('pointermove', onPointer);
      const geometries = new Set(); const materials = new Set(); const textures = new Set();
      scene?.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        list.forEach((mat) => { materials.add(mat); for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value); });
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, []);

  return (
    <div ref={container} className="mira-canvas" style={{ width: '100%', height: '100%', position: 'relative' }}>
      {failed && (
        <div role="img" aria-label="Mira is waiting in the cafe" style={{
          position: 'absolute', inset: 0, display: 'grid', placeContent: 'center',
          background: '#385a52', color: '#e6e4d6', textAlign: 'center', padding: 40,
        }}>
          <div style={{ fontSize: 80, lineHeight: 1.5, fontFamily: 'Georgia, serif' }}>Mira</div>
          <div>咖啡还温着，雨还没停。</div>
        </div>
      )}
    </div>
  );
}
