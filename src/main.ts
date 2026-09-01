import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { movePlayer } from "./collision";
import { describeChunk, type Kit } from "./world-layout";
import { StreamedWorld } from "./streamed-world";
import { ExplorationMap } from "./exploration-map";
import { loadWorldAssets } from "./world-assets";
import { loadReferenceAssets, type ReferenceKit } from "./reference-assets";
import { LightAmbience } from "./light-ambience";
import { Footsteps } from "./footsteps";
import { CamcorderZoom } from "./camcorder-zoom";
import { LightFlicker } from "./light-flicker";
import { CameraMotion, WALK_STYLES, STAND_STYLES } from "./camera-motion";
import { DistantSteps } from "./distant-steps";
import { DistantAlarm } from "./distant-alarm";
import { Soundtrack } from "./soundtrack";
import { VhsPlayer } from "./vhs/player";
import { getVhsPreset, VHS_PRESETS } from "./vhs/presets";
import "./style.css";

type View = { name?: string; position: [number, number, number]; yaw: number; pitch: number };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>("scene");
const toolbar = element("toolbar");
const settings = element("settings");
const explore = element<HTMLButtonElement>("explore");
const enter = element<HTMLButtonElement>("enter");
const title = element("title");
const leave = element<HTMLButtonElement>("leave");
const settingsButton = element<HTMLButtonElement>("settings-button");
const loadLabel = element("load-label");
const progress = element<HTMLProgressElement>("load-progress");
const performanceLabel = element<HTMLOutputElement>("performance");
const touchControls = element("touch-controls");
const touch = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.body.classList.toggle("touch", touch);
const keys = new Set<string>();
const velocity = new THREE.Vector2();
const stickInput = new THREE.Vector2();
let active = false;
let entered = false;
let resolution = 1;
let eyeHeight = 1.65;
let frameTime = 0;
let frameCount = 0;
let averageMs = 0;
let ready = false;

element<HTMLSelectElement>("resolution").value = String(resolution);
if (touch) element("help").textContent = "Drag to look · Use the stick to walk";

function showError(message: string) {
  element("loading").hidden = true;
  element("error-message").textContent = message;
  element("error").hidden = false;
}
element("reload").addEventListener("click", () => location.reload());

async function boot() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  if (!renderer.extensions.has("EXT_color_buffer_float") && !renderer.extensions.has("EXT_color_buffer_half_float")) {
    renderer.dispose();
    throw new Error("This graphics device cannot render the HDR lighting. Try a browser with hardware acceleration enabled.");
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x302a15);
  scene.fog = new THREE.Fog(scene.background, 42, 59);
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 60);
  camera.rotation.order = "YXZ";
  const motion = new CameraMotion(camera, reducedMotion);
  for (const [kind, styles] of [["walking", WALK_STYLES], ["standing", STAND_STYLES]] as const) {
    const select = element<HTMLSelectElement>(`${kind}-motion`);
    for (const [id, style] of Object.entries(styles)) select.add(new Option(style.label, id));
    select.value = motion[kind];
    select.addEventListener("change", () => motion.select(kind, select.value));
  }
  const controls = new PointerLockControls(camera, canvas);
  controls.pointerSpeed = 0.72;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI - 0.15;
  const audioButton = element<HTMLButtonElement>("audio-toggle");
  function updateAudioButton() {
    audioButton.textContent = ambience.error ? "Retry sound" : !ambience.started ? "Enable sound" : ambience.enabled ? "Sound on" : "Sound off";
    audioButton.setAttribute("aria-pressed", String(ambience.started && ambience.enabled && !ambience.error));
    audioButton.title = ambience.error ?? music.error ?? footsteps.error ?? zoom.error ?? distant.error ?? alarm.error ?? flicker?.error ?? "Soundtrack and scene sound";
  }
  const ambience = new LightAmbience(updateAudioButton);
  const music = new Soundtrack(() => ambience.ensureBus());
  music.startIntro();
  const footsteps = new Footsteps(() => ambience.bus, updateAudioButton);
  const zoom = new CamcorderZoom(camera, () => ambience.bus, updateAudioButton);
  const distant = new DistantSteps(camera, () => ambience.bus, updateAudioButton);
  const alarm = new DistantAlarm(camera, () => ambience.bus, updateAudioButton, () => world, scene);
  const alarmHint = element("alarm-hint");
  alarmHint.textContent = touch ? "Tap the alarm to silence" : "Click or F to silence";
  let flicker: LightFlicker | null = null;
  audioButton.addEventListener("click", () => { ambience.toggle(); if (ambience.enabled) music.resume(); void footsteps.prepare(); void zoom.prepare(); void distant.prepare(); void alarm.prepare(); void flicker?.prepare(); });
  title.addEventListener("pointerdown", () => music.resume());

  // MSAA must be on the offscreen target, not only the canvas, when using a composer.
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: touch ? 2 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.018, 0.12, 2.0);
  composer.addPass(bloom);
  // The LUT includes Blender's view, contrast look, and sRGB transfer exactly once.
  const output = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, viewLut: { value: null }, exposure: { value: 1 } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp sampler3D;
      uniform sampler2D tDiffuse; uniform sampler3D viewLut; uniform float exposure; varying vec2 vUv;
      void main() {
        vec3 linear = max(texture2D(tDiffuse, vUv).rgb * exposure, vec3(exp2(-12.0)));
        vec3 logCoord = clamp((log2(linear) + 12.0) / 22.0, 0.0, 1.0);
        vec3 lutCoord = (logCoord * 63.0 + 0.5) / 64.0;
        gl_FragColor = vec4(texture(viewLut, lutCoord).rgb, 1.0);
      }`,
  });
  composer.addPass(output);
  const grain = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, time: { value: 0 } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float time; varying vec2 vUv;
      void main() {
        vec3 color = texture2D(tDiffuse, vUv).rgb;
        float noise = fract(sin(dot(gl_FragCoord.xy + mod(floor(time * 24.0), 1000.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        color += noise * 0.023 * (1.0 - 0.65 * dot(color, vec3(0.2126, 0.7152, 0.0722)));
        gl_FragColor = vec4(color, 1.0);
      }`,
  });
  grain.enabled = false;
  composer.addPass(grain);

  const presetSelect = element<HTMLSelectElement>("vhs-preset");
  for (const preset of VHS_PRESETS) presetSelect.add(new Option(preset.label, preset.id));
  let renderSize = "";
  const vhs = new VhsPlayer(canvas, element<HTMLCanvasElement>("vhs-view"), () => {
    presetSelect.value = vhs.preset.id;
    element("clean-options").hidden = vhs.enabled;
    grain.enabled = !vhs.enabled && element<HTMLInputElement>("grain").checked;
    element("vhs-status").textContent = vhs.error
      ? `VHS unavailable. Clean view restored. ${vhs.error}`
      : vhs.enabled ? (vhs.diagnostics.ready ? "ntsc-rs · 480-line tape processing" : "Starting ntsc-rs...")
        : "Original scene, without tape processing";
    resize();
  });
  presetSelect.addEventListener("change", () => {
    vhs.setPreset(presetSelect.value);
    try { localStorage.setItem("backrooms.vhs-preset.v1", presetSelect.value); } catch { /* Storage is optional. */ }
  });

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const nativeRatio = Math.min(devicePixelRatio, touch ? 1.5 : 2);
    const ratio = vhs.enabled ? Math.min(nativeRatio, vhs.preset.height / height) : nativeRatio * resolution;
    const size = `${width}:${height}:${ratio}`;
    if (size === renderSize) return;
    renderSize = size;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(ratio);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    vhs.invalidate();
  }
  window.addEventListener("resize", resize);
  let savedPreset: string | null = null;
  try { savedPreset = localStorage.getItem("backrooms.vhs-preset.v1"); } catch { /* Use the default. */ }
  vhs.setPreset(getVhsPreset(savedPreset ?? (reducedMotion ? "fresh" : "camcorder")).id);
  element("vhs-controls").hidden = false;
  resize();

  const params = new URLSearchParams(location.search);
  const seed = params.get("seed") ?? "47";
  const roomPreview = params.get("look") === "room-preview";
  const continuousLook = params.get("look") !== "original" && !roomPreview;
  const referenceLook = continuousLook || roomPreview;
  const kitPath = continuousLook ? "/continuous/" : referenceLook ? "/reference/" : "/modules/";
  if (seed.length > 128) throw new Error("World seeds must be 128 characters or fewer.");
  const response = await fetch(`${kitPath}modules.json`);
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
    throw new Error("The architectural module kit could not be loaded.");
  }
  const manifest = await response.text();
  if (manifest.trimStart().startsWith("<")) throw new Error("The architectural module kit is unavailable.");
  const kit = JSON.parse(manifest) as Kit;
  const validLayout = kit.version === 1 ? kit.cellSize === 32 : kit.version === 2 && kit.layout === "continuous" && kit.cellSize === 36;
  if (!validLayout || (continuousLook && kit.version !== 2) || !Array.isArray(kit.templates) || !kit.templates.length) {
    throw new Error("The architectural module manifest is invalid.");
  }
  for (const template of kit.templates) {
    if (!template.spawn || !Array.isArray(template.colliders) || !Array.isArray(template.anchors)
      || !Array.isArray(template.rooms) || !Array.isArray(template.lights) || !template.radiance?.length) throw new Error(`Incomplete room module: ${template.id}`);
    const vectors = [template.spawn.position, ...template.colliders.flatMap((box) => [box.min, box.max]),
      ...template.rooms.flatMap((room) => [room.bounds.min, room.bounds.max]),
      ...template.anchors.flatMap((anchor) => [anchor.position, anchor.clearance]), ...template.lights.map((light) => light.position)];
    if (vectors.some((value) => !Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))) {
      throw new Error(`Invalid geometry coordinates in module ${template.id}`);
    }
  }
  const referenceExposure = Math.pow(2, kit.bake.camera?.exposureStops ?? 0);
  renderer.toneMappingExposure = referenceExposure;
  output.uniforms.exposure.value = referenceExposure;
  camera.fov = kit.bake.camera?.verticalFovDegrees ?? 65;
  camera.updateProjectionMatrix();

  const manager = new THREE.LoadingManager();
  manager.onProgress = (_, loaded, total) => {
    progress.max = total;
    progress.value = loaded;
    loadLabel.textContent = `Loading baked lighting · ${loaded} / ${total}`;
  };
  const [colorBuffer, details] = await Promise.all([
    fetch("/color/agx-medium-high.bin").then((res) => {
      if (!res.ok) throw new Error("The Blender color transform could not be loaded.");
      return res.arrayBuffer();
    }),
    referenceLook ? Promise.resolve(null) : Promise.all([
      new THREE.TextureLoader(manager).loadAsync("/textures/wallpaper-detail.png"),
      new THREE.TextureLoader(manager).loadAsync("/textures/carpet-detail.png"),
    ]),
  ]);
  for (const detail of details ?? []) {
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
    detail.colorSpace = THREE.NoColorSpace;
    detail.anisotropy = renderer.capabilities.getMaxAnisotropy();
    detail.needsUpdate = true;
  }
  if (colorBuffer.byteLength !== 64 ** 3 * 8) throw new Error("The Blender color transform is incomplete.");
  const viewLut = new THREE.Data3DTexture(new Uint16Array(colorBuffer), 64, 64, 64);
  viewLut.type = THREE.HalfFloatType;
  viewLut.format = THREE.RGBAFormat;
  viewLut.minFilter = THREE.LinearFilter;
  viewLut.magFilter = THREE.LinearFilter;
  viewLut.needsUpdate = true;
  output.uniforms.viewLut.value = viewLut;
  const assets = referenceLook
    ? await loadReferenceAssets(kit as ReferenceKit, manager, renderer, kitPath)
    : await loadWorldAssets(kit, manager, renderer, details![0], details![1]);
  const worldSeed = continuousLook ? `continuous:${seed}` : referenceLook ? `reference:${seed}` : seed;
  const world = new StreamedWorld(kit, worldSeed, assets.prototypes);
  const explorationMap = new ExplorationMap(element<HTMLCanvasElement>("exploration-map"), world);
  scene.add(world.root);
  if (continuousLook) flicker = new LightFlicker(camera, world, () => ambience.bus, updateAudioButton, reducedMotion, assets.prototypes.values());

  function setView(view: View) {
    explorationMap.resetTrail();
    motion.reset();
    distant.reset();
    alarm.reset(true);
    camera.position.fromArray(view.position);
    camera.rotation.set(view.pitch, view.yaw, 0, "YXZ");
    eyeHeight = view.position[1];
    velocity.set(0, 0);
    footsteps.reset();
    zoom.reset();
    flicker?.reset();
    vhs.invalidate();
    ambience.update(camera.position, world.lights, world.colliders);
  }
  setView(world.spawnAt(0, 0));
  const viewpoints = [
    { name: "Starting point", x: 0, z: 0 },
    { name: "Nearby area east", x: 1, z: 0 },
    { name: "Nearby area north", x: 0, z: -1 },
    { name: "Distant district", x: 24, z: -16 },
  ];
  const viewSelect = element<HTMLSelectElement>("viewpoint");
  viewpoints.forEach((view, index) => viewSelect.add(new Option(view.name ?? `View ${index + 1}`, String(index))));
  viewSelect.addEventListener("change", () => {
    const view = viewpoints[Number(viewSelect.value)];
    setView(world.spawnAt(view.x, view.z));
  });
  element("reset-view").addEventListener("click", () => { setView(world.spawnAt(0, 0)); viewSelect.value = "0"; });

  function openSettings(open: boolean) {
    settings.hidden = !open;
    settingsButton.setAttribute("aria-expanded", String(open));
    if (open) element("close-settings").focus();
  }
  function closeSettingsAndResume() {
    openSettings(false);
    enterWorld();
  }
  settingsButton.addEventListener("click", () => openSettings(settings.hidden));
  element("close-settings").addEventListener("click", closeSettingsAndResume);
  element<HTMLInputElement>("exposure").addEventListener("input", (event) => {
    const ev = Number((event.target as HTMLInputElement).value);
    renderer.toneMappingExposure = referenceExposure * Math.pow(2, ev);
    output.uniforms.exposure.value = renderer.toneMappingExposure;
    element("exposure-output").textContent = `${ev > 0 ? "+" : ""}${ev.toFixed(1)} EV`;
  });
  element<HTMLSelectElement>("resolution").addEventListener("change", (event) => { resolution = Number((event.target as HTMLSelectElement).value); resize(); });
  element<HTMLInputElement>("bloom").addEventListener("change", (event) => { bloom.enabled = (event.target as HTMLInputElement).checked; });
  element<HTMLInputElement>("grain").addEventListener("change", (event) => { grain.enabled = !vhs.enabled && (event.target as HTMLInputElement).checked; });

  function setActive(value: boolean, dragMode = touch) {
    if (!entered) value = false;
    active = value;
    document.body.classList.toggle("walking", value);
    toolbar.hidden = !entered || value;
    element("walk-actions").hidden = !entered || (value && !touch);
    leave.hidden = !value;
    touchControls.hidden = !value || !dragMode;
    element("stick").hidden = !touch;
    element("touch-hint").textContent = touch ? "Drag the scene to look" : "Drag to look · WASD to walk";
    if (value) openSettings(false);
    else {
      keys.clear(); velocity.set(0, 0); stickInput.set(0, 0);
      footsteps.reset();
      zoom.stop();
      flicker?.reset();
      motion.reset();
      distant.reset();
      alarm.reset();
      camera.position.y = eyeHeight;
      explore.textContent = "Resume";
    }
  }
  controls.addEventListener("lock", () => setActive(true));
  controls.addEventListener("unlock", () => setActive(false));
  function enterWorld() {
    if (!ready) return;
    const firstEntry = !entered;
    entered = true;
    title.hidden = true;
    void ambience.start();
    if (firstEntry) music.enter(); else music.resume();
    void footsteps.prepare();
    void zoom.prepare();
    void distant.prepare();
    void alarm.prepare();
    void flicker?.prepare();
    if (touch) setActive(true);
    else {
      try {
        if (typeof canvas.requestPointerLock !== "function") setActive(true, true);
        else void canvas.requestPointerLock()?.catch(() => setActive(true, true));
      } catch { setActive(true, true); }
    }
  }
  enter.addEventListener("click", enterWorld);
  explore.addEventListener("click", enterWorld);
  leave.addEventListener("click", () => { if (controls.isLocked) controls.unlock(); else setActive(false); });
  document.addEventListener("pointerlockerror", () => {
    if (entered) setActive(true, true);
  });
  window.addEventListener("keydown", (event) => {
    if (!entered && !event.repeat) music.resume();
    if (event.code === "Escape" && !settings.hidden) { closeSettingsAndResume(); return; }
    if (!active) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === "KeyM") { event.preventDefault(); if (event.repeat) return; ambience.toggle(); if (ambience.enabled) music.resume(); void footsteps.prepare(); void zoom.prepare(); void distant.prepare(); void alarm.prepare(); void flicker?.prepare(); return; }
    if (event.code === "KeyF" && !event.repeat) { event.preventDefault(); if (alarm.interact(0, 0)) alarmHint.hidden = true; return; }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) {
      event.preventDefault(); keys.add(event.code);
    }
    if (event.code === "Escape" && !controls.isLocked) setActive(false);
  });
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => { keys.clear(); velocity.set(0, 0); stickInput.set(0, 0); footsteps.reset(); zoom.stop(); flicker?.reset(); motion.reset(); distant.reset(); alarm.reset(); });
  window.addEventListener("pagehide", () => alarm.reset());

  let dragId: number | null = null;
  let dragX = 0;
  let dragY = 0;
  let clickX = 0;
  let clickY = 0;
  let dragged = false;
  canvas.addEventListener("pointerdown", (event) => {
    if (!active || event.button !== 0 || !event.isPrimary || dragId !== null) return;
    clickX = event.clientX; clickY = event.clientY; dragged = false;
    if (controls.isLocked) return;
    dragId = event.pointerId; dragX = event.clientX; dragY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== dragId) return;
    if (Math.hypot(event.clientX - clickX, event.clientY - clickY) > 8) dragged = true;
    const sensitivity = 0.003 / Math.sqrt(camera.zoom);
    camera.rotation.y -= (event.clientX - dragX) * sensitivity;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - (event.clientY - dragY) * sensitivity, -1.4, 1.4);
    dragX = event.clientX; dragY = event.clientY;
  });
  canvas.addEventListener("lostpointercapture", () => { dragId = null; });
  canvas.addEventListener("pointerup", () => { dragId = null; });
  canvas.addEventListener("pointercancel", () => { dragId = null; dragged = true; });
  canvas.addEventListener("click", (event) => {
    if (!active || dragged || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = controls.isLocked ? 0 : (event.clientX - rect.left) / rect.width * 2 - 1;
    const y = controls.isLocked ? 0 : 1 - (event.clientY - rect.top) / rect.height * 2;
    if (alarm.interact(x, y)) alarmHint.hidden = true;
  });

  const stick = element("stick");
  const knob = stick.querySelector("span")!;
  let stickId: number | null = null;
  function updateStick(event: PointerEvent) {
    const rect = stick.getBoundingClientRect();
    stickInput.set((event.clientX - rect.left - rect.width / 2) / 38, (event.clientY - rect.top - rect.height / 2) / 38);
    if (stickInput.length() > 1) stickInput.normalize();
    knob.style.transform = `translate(${stickInput.x * 30}px, ${stickInput.y * 30}px)`;
  }
  stick.addEventListener("pointerdown", (event) => {
    if (stickId !== null) return;
    stickId = event.pointerId; stick.setPointerCapture(event.pointerId); updateStick(event);
  });
  stick.addEventListener("pointermove", (event) => { if (event.pointerId === stickId) updateStick(event); });
  const stopStick = () => { stickId = null; stickInput.set(0, 0); knob.style.transform = ""; };
  stick.addEventListener("lostpointercapture", stopStick);
  stick.addEventListener("pointerup", stopStick);
  stick.addEventListener("pointercancel", stopStick);

  loadLabel.textContent = "Preparing the first frame";
  renderer.setRenderTarget(composer.readBuffer);
  await renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(null);
  composer.render();
  ready = true;
  element("loading").hidden = true;
  enter.disabled = false;

  let previous = performance.now();
  let accumulator = 0;
  let audioElapsed = 0;
  let motionSpeed = 0;
  function frame(time: number) {
    const elapsed = (time - previous) / 1000;
    previous = time;
    accumulator = active ? accumulator + Math.min(elapsed, 0.25) : 0;
    const delta = 1 / 120;
    let moved = 0;
    let simulated = 0;
    while (accumulator >= delta) {
      accumulator -= delta;
      let side = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft")) + stickInput.x;
      let forward = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown")) - stickInput.y;
      const length = Math.hypot(side, forward);
      if (length > 1) { side /= length; forward /= length; }
      const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
      const speed = running ? 3.3 : 2.15;
      const damping = 1 - Math.exp(-14 * delta);
      velocity.x += (side * speed - velocity.x) * damping;
      velocity.y += (forward * speed - velocity.y) * damping;
      const yaw = camera.rotation.y;
      const dx = (velocity.x * Math.cos(yaw) - velocity.y * Math.sin(yaw)) * delta;
      const dz = (-velocity.x * Math.sin(yaw) - velocity.y * Math.cos(yaw)) * delta;
      const next = movePlayer({ x: camera.position.x, z: camera.position.z }, dx, dz, world.colliders);
      const distance = Math.hypot(next.x - camera.position.x, next.z - camera.position.z);
      camera.position.x = next.x; camera.position.z = next.z;
      const shift = world.update(camera.position);
      if (shift) alarm.shiftOrigin(shift);
      footsteps.advance(distance, delta, running, ambience.enabled);
      moved += distance;
      simulated += delta;
    }
    zoom.update(elapsed, active ? Number(keys.has("KeyQ")) - Number(keys.has("KeyE")) : 0, ambience.enabled);
    controls.pointerSpeed = 0.72 / Math.sqrt(camera.zoom);
    if (simulated) motionSpeed = moved / simulated;
    else if (!active) motionSpeed = 0;
    flicker?.update(elapsed, active && document.hasFocus(), ambience.enabled);
    alarm.update(elapsed, active && document.hasFocus(), ambience.enabled);
    distant.update(elapsed, active && document.hasFocus(), ambience.enabled, Math.max(flicker?.threat ?? 0, alarm.threat));
    music.update(elapsed, distant.tension, active, ambience.enabled);
    motion.update(elapsed, motionSpeed, footsteps.cadence.phase, footsteps.cadence.steps,
      document.hasFocus() && (active || !settings.hidden), distant.tension);
    motion.apply(world.colliders);
    alarmHint.hidden = !active || !alarm.updateView();
    explorationMap.update(time, camera, active);
    ambience.updateListener(camera);
    grain.uniforms.time.value = time / 1000;
    audioElapsed += elapsed;
    if (audioElapsed >= 0.1) {
      ambience.update(camera.position, world.lights, world.colliders, flicker?.lightState);
      audioElapsed = 0;
    }
    renderer.info.reset();
    composer.render(elapsed);
    vhs.capture(time);
    motion.restore();
    frameTime += elapsed;
    frameCount++;
    if (frameTime >= 1) {
      averageMs = frameTime * 1000 / frameCount;
      performanceLabel.textContent = vhs.enabled
        ? `${vhs.diagnostics.tapeFps > 0 ? `${Math.round(vhs.diagnostics.tapeFps)} fps tape · ` : ""}${Math.round(vhs.diagnostics.latencyMs)} ms processing`
        : `${Math.round(1000 / averageMs)} fps · ${Math.round(canvas.width)} × ${Math.round(canvas.height)}`;
      frameTime = 0; frameCount = 0;
    }
  }
  document.addEventListener("visibilitychange", () => {
    vhs.setVisible(!document.hidden);
    footsteps.reset();
    zoom.stop();
    flicker?.reset();
    ambience.visibilityChanged();
    music.visibilityChanged(document.hidden);
    motion.reset();
    distant.reset();
    keys.clear(); velocity.set(0, 0); stickInput.set(0, 0);
    alarm.reset();
    previous = performance.now();
    accumulator = 0;
    renderer.setAnimationLoop(document.hidden ? null : frame);
  });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault(); renderer.setAnimationLoop(null);
    vhs.dispose();
    alarm.reset(true);
    music.visibilityChanged(true);
    showError("The graphics context was interrupted. Reload to restore the scene.");
  });

  Object.defineProperty(window, "backrooms", { value: {
    get ready() { return ready; },
    get state() { return {
      position: camera.position.toArray(), rotation: camera.rotation.toArray(), active, entered,
      look: continuousLook ? "continuous" : referenceLook ? "reference" : "original",
      bakedMeshes: assets.meshCount, atlases: assets.atlasCount, bake: kit.bake,
      world: world.stats,
      explorationMap: explorationMap.diagnostics,
      frameMs: averageMs, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries,
      exposure: renderer.toneMappingExposure, resolution: [canvas.width, canvas.height],
      audio: ambience.diagnostics,
      footsteps: footsteps.diagnostics,
      zoom: zoom.diagnostics,
      motion: motion.diagnostics,
      distant: distant.diagnostics,
      alarm: alarm.diagnostics,
      music: music.diagnostics,
      flicker: flicker?.diagnostics,
      vhs: vhs.diagnostics,
    }; },
    ...(import.meta.env.DEV ? {
      demoFireAlarm: () => {
        if (!active || !document.hasFocus() || !ambience.enabled) throw new Error("Enter the scene with sound enabled first.");
        if (!alarm.preview()) throw new Error("The alarm is loading, already active, or has no reachable wall nearby.");
        return alarm.diagnostics;
      },
      getArchitecture: () => world.current,
      inspectChunk: (x: number, z: number) => describeChunk(worldSeed, x, z, kit),
      warpToChunk: (x: number, z: number) => { setView(world.spawnAt(x, z)); return world.stats; },
    } : {}),
  } });
  renderer.setAnimationLoop(frame);
}

boot().catch((error: unknown) => {
  console.error(error);
  showError(error instanceof Error ? error.message : "The scene could not be loaded.");
});
