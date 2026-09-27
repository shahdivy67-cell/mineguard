/**
 * TruckScene3D.jsx — the real 3D truck and its scene (Three.js).
 *
 * Why this file exists: the team wants a whole 3D model of the truck, not a
 * 2D drawing. The truck is built procedurally from Three.js primitives
 * (cab, dump bed, six wheels, bumper, headlights, exhaust, mirrors, fuel
 * tank) with the ultrasonic sensor as a glowing cyan dot on the front bumper
 * — the one real sensor. The scene adds the ground, a haul road, the
 * fog-gated zone strips, the live beam and the rock.
 *
 * Real-data rule: the rock and the beam exist ONLY while a live echo is
 * available, and the rock's distance from the bumper is the REAL ultrasonic
 * reading (schematic scale — the labels carry the exact cm). No echo → no
 * rock, no beam, honest "No data" overlay.
 *
 * Modes:
 *   sim   — fixed 3/4 camera: the proximity simulation (truck + rock)
 *   orbit — OrbitControls: drag to rotate around the truck (true 360°),
 *           scroll to zoom, preset buttons snap the camera
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// 1 world unit = 50 cm (schematic — real distances are shown as labels).
const CM = 1 / 50;
const TRUCK_FRONT_X = 3.2; // bumper position (beam origin)
const BEAM_Y = 0.95;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35, flatShading: true, ...opts });
}

function box(w, h, d, color, x, y, z, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  return m;
}

// ---------------------------------------------------------------------------
// The truck — a mining dump truck from primitives. Nose points +X (forward).
// ---------------------------------------------------------------------------
export function buildTruck() {
  const g = new THREE.Group();

  // wheels: 1 front axle + 2 rear axles, tire + hub
  const tireGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.42, 18);
  const hubGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.44, 12);
  const tireMat = mat(0x14161c, { roughness: 0.9, metalness: 0.1 });
  const hubMat = mat(0x3d434f, { roughness: 0.4, metalness: 0.6 });
  for (const [x, z] of [
    [2.0, 1.05], [2.0, -1.05],
    [-1.3, 1.05], [-1.3, -1.05],
    [-2.3, 1.05], [-2.3, -1.05],
  ]) {
    const t = new THREE.Mesh(tireGeo, tireMat);
    t.rotation.x = Math.PI / 2;
    t.position.set(x, 0.55, z);
    const h = new THREE.Mesh(hubGeo, hubMat);
    h.rotation.x = Math.PI / 2;
    h.position.set(x, 0.55, z);
    g.add(t, h);
  }

  // chassis
  g.add(box(6.2, 0.3, 1.8, 0x2c313a, 0, 1.0, 0));
  // cab (safety yellow) + windshield
  g.add(box(1.5, 1.35, 1.9, 0xe8a13a, 2.0, 1.85, 0));
  g.add(box(0.95, 0.75, 1.7, 0x9fd2ff, 2.62, 2.05, 0, { roughness: 0.15, metalness: 0.6 }));
  // dump bed + ribs
  g.add(box(3.6, 1.15, 2.0, 0x8f9aa8, -1.1, 1.95, 0));
  for (let i = 0; i < 5; i++) g.add(box(0.08, 1.2, 2.04, 0x6d7683, -2.5 + i * 0.7, 1.95, 0));
  // front bumper + grille + headlights
  g.add(box(0.3, 0.45, 2.0, 0x3d434f, 3.05, 0.95, 0));
  g.add(box(0.12, 0.5, 1.2, 0x2c313a, 3.16, 1.4, 0));
  for (const z of [-0.7, 0.7]) {
    g.add(box(0.1, 0.18, 0.3, 0xffd76a, 3.2, 1.15, z, { emissive: 0xffd76a, emissiveIntensity: 0.7 }));
  }
  // exhaust stack, mirrors, fuel tank, mudflaps
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.3, 10), mat(0x3d434f));
  stack.position.set(1.1, 2.6, -0.8);
  g.add(stack);
  for (const z of [-1.05, 1.05]) g.add(box(0.06, 0.3, 0.2, 0x2c313a, 2.6, 2.3, z));
  g.add(box(0.9, 0.5, 0.6, 0x5f6875, 0.6, 0.85, -1.05));
  for (const z of [-1.05, 1.05]) g.add(box(0.5, 0.5, 0.08, 0x2c313a, -2.9, 0.45, z));

  // the ultrasonic sensor (TRIG D9 / ECHO D10) — cyan dot on the front bumper
  const sensor = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x40d0ff, emissive: 0x40d0ff, emissiveIntensity: 0.9 })
  );
  sensor.position.set(3.28, BEAM_Y, 0);
  g.add(sensor);
  return g;
}

// ---------------------------------------------------------------------------
// The scene — renderer, camera, lights, ground, road, zones, beam, rock, fog.
// ---------------------------------------------------------------------------
export class TruckScene {
  constructor(container, { orbit = false } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x141821);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    this.camera.position.set(orbit ? 9 : 7.5, orbit ? 5 : 5.5, orbit ? 9 : 8.5);

    // lights
    this.scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x1a1d24, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 5);
    this.scene.add(sun);

    // ground + subtle grid + haul road ahead of the truck
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), mat(0x23262e, { roughness: 0.95, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(120, 60, 0x2e3442, 0x23262e);
    grid.position.y = 0.01;
    this.scene.add(grid);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(60, 4.4), mat(0x2a2e38, { roughness: 0.9 }));
    road.rotation.x = -Math.PI / 2;
    road.position.set(TRUCK_FRONT_X + 30, 0.02, 0);
    this.scene.add(road);

    // the truck
    this.truck = buildTruck();
    this.scene.add(this.truck);

    // fog-gated zone strips on the road (red / yellow / green)
    this.zones = new THREE.Group();
    this.zoneMats = {
      bad: new THREE.MeshStandardMaterial({ color: 0xef5350, transparent: true, opacity: 0.45 }),
      warn: new THREE.MeshStandardMaterial({ color: 0xffc857, transparent: true, opacity: 0.45 }),
      ok: new THREE.MeshStandardMaterial({ color: 0x35c26a, transparent: true, opacity: 0.45 }),
    };
    this.zoneMeshes = {
      bad: new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 4.2), this.zoneMats.bad),
      warn: new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 4.2), this.zoneMats.warn),
      ok: new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 4.2), this.zoneMats.ok),
    };
    for (const k of Object.keys(this.zoneMeshes)) {
      this.zoneMeshes[k].position.y = 0.03;
      this.zones.add(this.zoneMeshes[k]);
    }
    this.scene.add(this.zones);

    // live beam (bumper -> rock) and the rock itself
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 1, 12),
      new THREE.MeshStandardMaterial({ color: 0x40d0ff, transparent: true, opacity: 0.5, emissive: 0x1b83b5, emissiveIntensity: 0.4 })
    );
    this.beam.rotation.z = -Math.PI / 2; // local Y -> world X
    this.beam.position.set(TRUCK_FRONT_X, BEAM_Y, 0);
    this.beam.visible = false;
    this.scene.add(this.beam);

    this.rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.55, 0),
      mat(0x6b625a, { roughness: 0.9, metalness: 0.05 })
    );
    this.rock.position.set(TRUCK_FRONT_X + 1, 0.55, 0);
    this.rock.visible = false;
    this.scene.add(this.rock);

    // PC fog control — white haze over the scene (only while logic is ON)
    this.fogBox = new THREE.Mesh(
      new THREE.BoxGeometry(50, 9, 12),
      new THREE.MeshStandardMaterial({ color: 0xd8dee9, transparent: true, opacity: 0, depthWrite: false })
    );
    this.fogBox.position.set(TRUCK_FRONT_X + 20, 4, 0);
    this.fogBox.visible = false;
    this.scene.add(this.fogBox);

    // camera controls
    this.controls = null;
    if (orbit) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(0, 1.2, 0);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.minDistance = 4;
      this.controls.maxDistance = 30;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.04; // never under the ground
    } else {
      this.camera.lookAt(2.5, 1, 0);
    }

    this.rockSpin = 0;
    this.raf = null;
    this._animate = this._animate.bind(this);
    this._animate();
    this.resize();
  }

  _animate() {
    this.raf = requestAnimationFrame(this._animate);
    if (this.controls) this.controls.update();
    if (this.rock.visible) this.rock.rotation.y += 0.004;
    this.renderer.render(this.scene, this.camera);
  }

  // Live ultrasonic distance (cm) — rock + beam follow the REAL echo.
  setDistance(cm) {
    const has = cm != null && isFinite(cm);
    this.rock.visible = has;
    this.beam.visible = has;
    if (!has) return;
    const L = cm * CM;
    this.rock.position.set(TRUCK_FRONT_X + L, 0.55, 0);
    this.beam.scale.set(1, L, 1);
    this.beam.position.set(TRUCK_FRONT_X + L / 2, BEAM_Y, 0);
  }

  // Fog-gated zone strips (cm) + how far the green strip reaches.
  setZones(cautionCm, dangerCm, viewMaxCm = 120) {
    const d = dangerCm * CM;
    const c = cautionCm * CM;
    const v = viewMaxCm * CM;
    this.zoneMeshes.bad.scale.x = Math.max(0.001, d);
    this.zoneMeshes.bad.position.x = TRUCK_FRONT_X + d / 2;
    this.zoneMeshes.warn.scale.x = Math.max(0.001, c - d);
    this.zoneMeshes.warn.position.x = TRUCK_FRONT_X + d + (c - d) / 2;
    this.zoneMeshes.ok.scale.x = Math.max(0.001, v - c);
    this.zoneMeshes.ok.position.x = TRUCK_FRONT_X + c + (v - c) / 2;
  }

  // PC fog control (a control value, never a sensor reading).
  setFog(active, intensity) {
    this.fogBox.visible = !!active;
    this.fogBox.material.opacity = active ? (intensity / 100) * 0.3 : 0;
  }

  // Camera presets for the 360° view.
  setCameraPreset(name) {
    if (!this.controls) return;
    const P = {
      front: [8.5, 2.2, 0],
      side: [0, 2.2, 8.5],
      rear: [-8.5, 2.2, 0],
      left: [0, 2.2, -8.5],
      top: [0.01, 11, 0.01],
    }[name];
    if (!P) return;
    this.camera.position.set(P[0], P[1], P[2]);
    this.controls.target.set(0, 1.2, 0);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.controls) this.controls.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

// ---------------------------------------------------------------------------
// React wrapper — creates the scene once, pushes real data into it.
// `controllerRef` lets parents snap the camera (360° presets).
// ---------------------------------------------------------------------------
export default function TruckScene3D({
  mode = "sim",
  controllerRef = null,
  distance = null,
  caution = 40,
  danger = 15,
  viewMax = 120,
  fogActive = false,
  fogIntensity = 0,
  className = "",
}) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);

  useEffect(() => {
    const s = new TruckScene(hostRef.current, { orbit: mode === "orbit" });
    sceneRef.current = s;
    if (controllerRef) controllerRef.current = s;
    const ro = new ResizeObserver(() => s.resize());
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      if (controllerRef) controllerRef.current = null;
      s.dispose();
      sceneRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    sceneRef.current?.setDistance(distance);
  }, [distance]);
  useEffect(() => {
    sceneRef.current?.setZones(caution, danger, viewMax);
  }, [caution, danger, viewMax]);
  useEffect(() => {
    sceneRef.current?.setFog(fogActive, fogIntensity);
  }, [fogActive, fogIntensity]);

  return <div ref={hostRef} className={className} />;
}
