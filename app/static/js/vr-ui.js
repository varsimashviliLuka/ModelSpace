/**
 * vr-ui.js — WebXR VR module for the 3D model viewer.
 * Target: Meta Quest 3 (immersive-vr, 6DOF, dual controllers).
 *
 * ═══════════════════════════════════════════════════════════════
 * LOCOMOTION BUG — ROOT CAUSE & FIX
 * ═══════════════════════════════════════════════════════════════
 *
 * PROBLEM:
 *   The animation loop in view.html runs:
 *       controls.update()   ← OrbitControls re-orients camera to look at target (0,Y,0)
 *       vrAPI.update()      ← locomotion reads camera.getWorldDirection() ← WRONG
 *       renderer.render()   ← XR system finally sets the real head pose
 *
 *   OrbitControls.update() sets camera.matrixWorld so the camera looks at
 *   controls.target, which is near world origin (the model center).
 *   By the time camera.getWorldDirection() is called, "forward" always points
 *   toward the model center — regardless of which way the user's head is facing.
 *   This is the "center attraction": every stick direction moves toward (0,0,0).
 *
 * FIX 1 — guard controls.update() in view.html:
 *   if (!renderer.xr.isPresenting) controls.update();
 *
 * FIX 2 — derive forward/right from player.rotation.y (pure math, no camera dependency):
 *   const yaw     = player.rotation.y;
 *   const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
 *   const right   = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
 *
 *   player.rotation.y is set only by our snap/smooth turn code — it is never
 *   touched by OrbitControls or the XR runtime. Always correct. No timing issues.
 *
 * ═══════════════════════════════════════════════════════════════
 * CONTROL SCHEME
 * ═══════════════════════════════════════════════════════════════
 *   Left stick X/Y  = free walk (forward/back/strafe relative to player yaw)
 *   Right stick X   = snap turn (or smooth turn if VR_SMOOTH_TURN=1)
 *   Right stick Y   = dolly zoom (scales radial distance from model origin)
 *   Trigger         = click VR panel button
 *   Left X button   = toggle VR panel
 *   Left Y button   = toggle animation play/pause
 *   Right A button  = lower height
 *   Right B button  = raise height
 *
 * AXIS MAP (Quest 3 WebXR gamepad):
 *   axes[0..1] = touchpad/joystick (unused on Quest 3)
 *   axes[2]    = thumbstick X  (-1=left, +1=right)
 *   axes[3]    = thumbstick Y  (-1=forward/up push, +1=backward/down push)
 *
 * BUTTON MAP (Quest 3):
 *   [0]=trigger  [1]=grip  [3]=stick-click
 *   Left:  [4]=X  [5]=Y
 *   Right: [4]=A  [5]=B
 * ═══════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ─────────────────────────────────────────────────────────────────
// Config (read from window.VR_CONFIG, injected by Flask)
// ─────────────────────────────────────────────────────────────────

const _cfg            = ()  => window.VR_CONFIG || {};
const _moveSpeed      = ()  => _cfg().moveSpeed   ?? 0.03;
const _snapAngle      = ()  => _cfg().snapAngle   ?? (Math.PI / 4);
const _heightStep     = ()  => _cfg().heightStep  ?? 0.1;
const _heightMin      = ()  => _cfg().heightMin   ?? -2.0;
const _heightMax      = ()  => _cfg().heightMax   ??  2.0;
const _zoomSpeed      = ()  => _cfg().zoomSpeed   ?? 0.05;
const _smoothTurn     = ()  => _cfg().smoothTurn  ?? false;
const _turnSpeed      = ()  => _cfg().turnSpeed   ?? 1.5;   // rad/s
const _deadzone       = ()  => _cfg().deadzone    ?? 0.12;
const _zoomMin        = ()  => _cfg().zoomMin     ?? 0.3;
const _zoomMax        = ()  => _cfg().zoomMax     ?? 15.0;

function _binding(key, dc, db) {
  const b = _cfg()[key];
  return (b && typeof b.ctrl === 'number' && typeof b.btn === 'number')
    ? b : { ctrl: dc, btn: db };
}
const _menuBinding       = () => _binding('menuToggle',  0, 4);
const _animBinding       = () => _binding('animToggle',  0, 5);
const _heightDownBinding = () => _binding('heightDown',  1, 4);
const _heightUpBinding   = () => _binding('heightUp',    1, 5);

// ─────────────────────────────────────────────────────────────────
// Panel layout — canvas aspect must match the 3D plane or UV hit
// testing and text look stretched / clipped.
// ─────────────────────────────────────────────────────────────────

const TEX_W          = 512;
const TEX_H          = 640;
const PANEL_WIDTH    = 0.50;                                    // metres wide
const PANEL_HEIGHT   = PANEL_WIDTH * (TEX_H / TEX_W);           // keep aspect
const PANEL_DISTANCE = 0.70;
const PANEL_Y_OFFSET = 0.02;
const RAY_LENGTH     = 8;

const PAD    = 20;
const GAP    = 10;
const BTN_H  = 42;

/**
 * Build button rects + section y positions from current viewer state.
 * Animation row is omitted when the model has no clips so the panel
 * doesn't leave a dead gap under the title.
 */
function _buildLayout(vs) {
  const innerW = TEX_W - PAD * 2;
  const col3 = (innerW - GAP * 2) / 3;
  const col4 = (innerW - GAP * 3) / 4;
  const buttons = [];
  let y = 78; // below title + hint

  const sections = {};

  if (vs.hasAnimation) {
    sections.animLabelY = y;
    y += 16;
    const rowY = y;
    buttons.push(
      { id: 'play',   label: '▶  Play',   x: PAD,                 y: rowY, w: col3, h: BTN_H },
      { id: 'pause',  label: '⏸  Pause',  x: PAD + col3 + GAP,    y: rowY, w: col3, h: BTN_H },
      { id: 'rewind', label: '⏮  Rewind', x: PAD + (col3 + GAP)*2,y: rowY, w: col3, h: BTN_H },
    );
    y += BTN_H + 14;
  }

  // Exposure: [−] [======== value ========] [+]
  sections.expLabelY = y;
  y += 16;
  const expBtnW = 72;
  const expBarX = PAD + expBtnW + GAP;
  const expBarW = innerW - expBtnW * 2 - GAP * 2;
  sections.expBar = { x: expBarX, y, w: expBarW, h: BTN_H };
  buttons.push(
    { id: 'exp_down', label: '☀ −', x: PAD, y, w: expBtnW, h: BTN_H },
    { id: 'exp_up',   label: '☀ +', x: PAD + innerW - expBtnW, y, w: expBtnW, h: BTN_H },
  );
  y += BTN_H + 14;

  // Scale: [⊖] [======== value ========] [⊕]
  sections.scaleLabelY = y;
  y += 16;
  const scBtnW = 100;
  const scBarX = PAD + scBtnW + GAP;
  const scBarW = innerW - scBtnW * 2 - GAP * 2;
  sections.scaleBar = { x: scBarX, y, w: scBarW, h: BTN_H };
  buttons.push(
    { id: 'scale_down', label: '⊖ Scale', x: PAD, y, w: scBtnW, h: BTN_H },
    { id: 'scale_up',   label: '⊕ Scale', x: PAD + innerW - scBtnW, y, w: scBtnW, h: BTN_H },
  );
  y += BTN_H + 14;

  // Rotation 4-across
  sections.rotLabelY = y;
  y += 16;
  const rotY = y;
  buttons.push(
    { id: 'rot_x_neg', label: 'X −90°', x: PAD,                  y: rotY, w: col4, h: BTN_H },
    { id: 'rot_x_pos', label: 'X +90°', x: PAD + col4 + GAP,     y: rotY, w: col4, h: BTN_H },
    { id: 'rot_y_neg', label: 'Y −90°', x: PAD + (col4 + GAP)*2, y: rotY, w: col4, h: BTN_H },
    { id: 'rot_y_pos', label: 'Y +90°', x: PAD + (col4 + GAP)*3, y: rotY, w: col4, h: BTN_H },
  );
  y += BTN_H + 14;

  // Graphics 3-across
  sections.gfxLabelY = y;
  y += 16;
  const gfxY = y;
  buttons.push(
    { id: 'gfx_low',  label: 'Low',  x: PAD,                  y: gfxY, w: col3, h: BTN_H },
    { id: 'gfx_med',  label: 'Med',  x: PAD + col3 + GAP,     y: gfxY, w: col3, h: BTN_H },
    { id: 'gfx_high', label: 'High', x: PAD + (col3 + GAP)*2, y: gfxY, w: col3, h: BTN_H },
  );
  y += BTN_H + 16;

  // Bottom row: hide panel | exit immersive
  const half = (innerW - GAP) / 2;
  buttons.push(
    { id: 'close_panel', label: 'Hide panel', x: PAD, y, w: half, h: BTN_H },
    { id: 'exit_vr',     label: 'Exit VR', x: PAD + half + GAP, y, w: half, h: BTN_H, danger: true },
  );
  y += BTN_H + 22;
  sections.footerY = Math.min(TEX_H - 16, y);

  return { buttons, sections };
}

// ─────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────

const _prevBtnState = {};
let   _snapCooled   = true;
let   _panelShown   = false;

// ─────────────────────────────────────────────────────────────────
// initVR — main entry point
// ─────────────────────────────────────────────────────────────────

export function initVR(opts) {
  const {
    renderer, scene, camera, controls,
    getViewerState, setExposure, playAnim, pauseAnim, rewindAnim, toggleAnim,
    scaleUp, scaleDown, setModelScale, nudgeRotation, setGraphicsQuality,
  } = opts;

  // ── XR camera rig ─────────────────────────────────────────────
  // player = the "room origin" group.
  //   Translate player.position to walk.
  //   Set player.rotation.y to turn.
  // The XR runtime sets camera's local transform (head pose relative to
  // tracking space) every frame. player.rotation.y is ONLY changed by our code.
  const player = new THREE.Group();
  player.add(camera);
  scene.add(player);

  let heightOffset = 0;

  // ── Controllers ───────────────────────────────────────────────
  const ctrlFactory = new XRControllerModelFactory();

  const controllers = [0, 1].map((i) => {
    const grip       = renderer.xr.getControllerGrip(i);
    const controller = renderer.xr.getController(i);
    grip.add(ctrlFactory.createControllerModel(grip));
    player.add(grip);
    player.add(controller);

    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -RAY_LENGTH),
      ]),
      new THREE.LineBasicMaterial({ color: 0x9988ff, transparent: true, opacity: 0.7 })
    );
    ray.visible = false;
    controller.add(ray);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    dot.visible = false;
    scene.add(dot);

    const state = {
      controller, grip, ray, dot, index: i,
      hand: null, gamepad: null, source: null,
    };
    controller.addEventListener('selectend', () => _firePanelClick(state, panelState, actions));
    return state;
  });

  // ── Panel ─────────────────────────────────────────────────────
  const panelState = {
    visible: false, mesh: null, canvas: null, ctx: null,
    texture: null, dirty: true, hoverId: null, buttons: [],
  };
  _buildPanel(panelState);
  scene.add(panelState.mesh);
  panelState.mesh.visible = false;

  const actions = {
    getViewerState, setExposure, playAnim, pauseAnim, rewindAnim,
    toggleAnim:    toggleAnim    || (() => { const vs = getViewerState(); vs.isPlaying ? pauseAnim() : playAnim(); }),
    scaleUp:       scaleUp       || (() => {}),
    scaleDown:     scaleDown     || (() => {}),
    setModelScale: setModelScale || (() => {}),
    nudgeRotation: nudgeRotation || (() => {}),
    setGraphicsQuality: setGraphicsQuality || (() => {}),
    showPanel,
    exitVR: () => {
      const session = renderer.xr.getSession?.();
      if (session) {
        session.end().catch(() => {});
      }
    },
    heightUp:   () => _adjustHeight(player,  _heightStep(), heightOffset, v => { heightOffset = v; }),
    heightDown: () => _adjustHeight(player, -_heightStep(), heightOffset, v => { heightOffset = v; }),
  };

  // ── XR session lifecycle ──────────────────────────────────────
  renderer.xr.addEventListener('sessionstart', () => {
    controls.enabled = false;
    player.position.set(0, 0, 2.5);
    player.rotation.y = 0;
    heightOffset = 0;
    _panelShown = false;
    setTimeout(() => showPanel(true), 600);
  });

  renderer.xr.addEventListener('sessionend', () => {
    controls.enabled = true;
    showPanel(false);
    Object.keys(_prevBtnState).forEach(k => delete _prevBtnState[k]);
    _snapCooled = true;
  });

  // ── Per-frame update (called from render loop) ─────────────────
  // delta: time since last frame in seconds (used for smooth turn)
  function update(delta = 1 / 72) {
    if (!renderer.xr.isPresenting) return;

    // Sync gamepad references from inputSources each frame (most reliable)
    const session = renderer.xr.getSession();
    if (session?.inputSources) {
      for (const src of session.inputSources) {
        const idx = src.handedness === 'left' ? 0 : src.handedness === 'right' ? 1 : -1;
        if (idx >= 0 && controllers[idx]) {
          controllers[idx].hand    = src.handedness;
          controllers[idx].gamepad = src.gamepad;
          controllers[idx].source  = src;
        }
      }
    }

    _pollFaceButtons(controllers, actions);

    for (const ctrl of controllers) {
      if (ctrl.gamepad) _handleLocomotion(ctrl, player, delta);
    }

    _updateRaycasting(controllers, panelState);

    if (panelState.visible && panelState.dirty) {
      _repaintPanel(panelState, getViewerState());
    }
  }

  // ── Panel visibility ──────────────────────────────────────────
  function showPanel(visible) {
    _panelShown = visible;
    panelState.visible      = visible;
    panelState.mesh.visible = visible;
    panelState.dirty        = true;

    if (visible) {
      // Spawn panel in front of the player's current facing direction.
      const yaw = player.rotation.y;
      const panelDir = new THREE.Vector3(-Math.sin(yaw), PANEL_Y_OFFSET, -Math.cos(yaw)).normalize();
      const camWorldPos = new THREE.Vector3();
      camera.getWorldPosition(camWorldPos);
      panelState.mesh.position.copy(camWorldPos.clone().addScaledVector(panelDir, PANEL_DISTANCE));
      panelState.mesh.lookAt(camWorldPos);
    }
  }

  return { update, showPanel, player, _panelState: panelState };
}

// ─────────────────────────────────────────────────────────────────
// Panel — build & paint
// ─────────────────────────────────────────────────────────────────

function _buildPanel(state) {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W; canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })
  );
  mesh.renderOrder = 999;
  Object.assign(state, { canvas, ctx, texture, mesh });
}

function _repaintPanel(state, vs) {
  const { ctx, texture, hoverId } = state;
  const W = TEX_W;
  const layout = _buildLayout(vs);
  state.buttons = layout.buttons;
  const { sections } = layout;

  ctx.clearRect(0, 0, W, TEX_H);
  _rrect(ctx, 0, 0, W, TEX_H, 22, 'rgba(15,17,30,0.94)');
  _rrect(ctx, 1, 1, W - 2, TEX_H - 2, 21, null, 'rgba(80,70,180,0.45)', 1.5);

  // Title
  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 20px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ModelSpace', W / 2, 36);

  // Hint
  ctx.fillStyle = 'rgba(124,130,160,0.7)';
  ctx.font = '11px system-ui,sans-serif';
  ctx.fillText('X menu · Y anim · A/B height · stick move/turn', W / 2, 56);

  const gq = vs.graphicsQuality || 'medium';
  const rot = vs.rotation || { x: 0, y: 0, z: 0 };

  // Section labels
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui,sans-serif';
  ctx.fillStyle = '#7c82a0';

  if (vs.hasAnimation) {
    ctx.fillText('ANIMATION', PAD, sections.animLabelY);
  }

  ctx.fillText('EXPOSURE', PAD, sections.expLabelY);
  ctx.fillText('SCALE', PAD, sections.scaleLabelY);
  ctx.fillText(
    `ROTATION  ${Math.round(rot.x || 0)}° / ${Math.round(rot.y || 0)}° / ${Math.round(rot.z || 0)}°`,
    PAD,
    sections.rotLabelY,
  );
  const gfxHint = gq === 'low' ? 'smoother' : gq === 'high' ? 'sharper' : 'balanced';
  ctx.fillText(`GRAPHICS  ·  ${gfxHint}`, PAD, sections.gfxLabelY);

  // Value bars (exposure / scale)
  const expFrac = Math.min(Math.max(Number(vs.exposure) / 4, 0), 1);
  const eb = sections.expBar;
  _rrect(ctx, eb.x, eb.y, eb.w, eb.h, 10, 'rgba(46,50,72,0.9)');
  if (expFrac > 0) {
    _rrect(ctx, eb.x + 3, eb.y + 3, Math.max(0, (eb.w - 6) * expFrac), eb.h - 6, 8, '#6c63ff');
  }
  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 14px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(Number(vs.exposure).toFixed(2), eb.x + eb.w / 2, eb.y + eb.h / 2 + 5);

  const sb = sections.scaleBar;
  _rrect(ctx, sb.x, sb.y, sb.w, sb.h, 10, 'rgba(46,50,72,0.9)');
  if (vs.modelScale > 1) {
    const sFrac = Math.min(Math.log10(vs.modelScale) / Math.log10(500), 1);
    _rrect(ctx, sb.x + 3, sb.y + 3, Math.max(0, (sb.w - 6) * sFrac), sb.h - 6, 8, '#4caf81');
  }
  const sLabel = vs.modelScale
    ? (vs.modelScale < 0.1 ? vs.modelScale.toFixed(3) : vs.modelScale.toFixed(2)) + '×'
    : '—';
  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 14px system-ui,sans-serif';
  ctx.fillText(sLabel, sb.x + sb.w / 2, sb.y + sb.h / 2 + 5);

  // Buttons
  for (const btn of layout.buttons) {
    const hov = btn.id === hoverId;
    const gfxActive =
      (btn.id === 'gfx_low'  && gq === 'low') ||
      (btn.id === 'gfx_med'  && gq === 'medium') ||
      (btn.id === 'gfx_high' && gq === 'high');
    const active = hov || gfxActive;
    let fill = active ? '#6c63ff' : 'rgba(36,39,54,0.95)';
    let stroke = active ? '#9088ff' : 'rgba(80,84,120,0.55)';
    if (btn.danger) {
      fill = hov ? '#c44a4a' : 'rgba(120,36,36,0.95)';
      stroke = hov ? '#ff8888' : 'rgba(180,80,80,0.65)';
    }
    _rrect(ctx, btn.x, btn.y, btn.w, btn.h, 10, fill, stroke, 1.5);
    ctx.fillStyle = '#e8eaf0';
    ctx.font = `${active || (btn.danger && hov) ? 'bold ' : ''}13px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 5);
  }

  // Footer
  ctx.fillStyle = 'rgba(124,130,160,0.7)';
  ctx.font = '12px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(vs.isPlaying ? '▶  Playing' : '⏸  Paused', W / 2, sections.footerY);

  texture.needsUpdate = true;
  state.dirty = false;
}

// ─────────────────────────────────────────────────────────────────
// Face-button polling — rising-edge detection
// ─────────────────────────────────────────────────────────────────

function _pollFaceButtons(controllers, actions) {
  for (const ctrl of controllers) {
    const gp = ctrl.gamepad;
    if (!gp?.buttons) continue;

    gp.buttons.forEach((btn, btnIdx) => {
      const key = `${ctrl.hand}:${btnIdx}`;
      const was = _prevBtnState[key] || false;
      _prevBtnState[key] = btn.pressed;
      if (!btn.pressed || was) return; // fire once on press

      const ctrlIdx = ctrl.hand === 'left' ? 0 : 1;
      const mB = _menuBinding(), aB = _animBinding(), dB = _heightDownBinding(), uB = _heightUpBinding();

      if (ctrlIdx === mB.ctrl && btnIdx === mB.btn) { _panelShown = !_panelShown; actions.showPanel(_panelShown); }
      if (ctrlIdx === aB.ctrl && btnIdx === aB.btn) { actions.toggleAnim(); }
      if (ctrlIdx === dB.ctrl && btnIdx === dB.btn) { actions.heightDown(); }
      if (ctrlIdx === uB.ctrl && btnIdx === uB.btn) { actions.heightUp(); }
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Locomotion — THE FIXED VERSION
//
// Forward/right derived from player.rotation.y ONLY.
// No camera.matrixWorld dependency → no center attraction.
//
// Axis conventions (Quest 3):
//   axes[2]: thumbstick X  -1=left   +1=right
//   axes[3]: thumbstick Y  -1=forward(up push)  +1=backward(down push)
//
// Left stick  → free walk
// Right stick X → snap/smooth turn
// Right stick Y → dolly zoom (radial distance from XZ origin)
// ─────────────────────────────────────────────────────────────────

function _handleLocomotion(ctrl, player, delta) {
  const axes = ctrl.gamepad?.axes;
  if (!axes || axes.length < 4) return;

  const dz = _deadzone();

  if (ctrl.hand === 'left') {
    const lx = axes[2]; // strafe:  +1 = right
    const ly = axes[3]; // forward: -1 = forward push (negate when moving)

    if (Math.abs(lx) <= dz && Math.abs(ly) <= dz) return;

    // ── THE FIX: derive from player.rotation.y, not from camera ──
    // player.rotation.y is only changed by our snap/smooth turn code.
    // It is never touched by OrbitControls or the XR runtime.
    // This makes locomotion immune to camera.matrixWorld timing issues.
    const yaw = player.rotation.y;
    // Camera default looks in -Z. Rotated by yaw:
    // forward = R_y(yaw) * (0,0,-1) = (-sin yaw, 0, -cos yaw)
    const fX = -Math.sin(yaw);
    const fZ = -Math.cos(yaw);
    // right = cross(forward, up) = (-sin,0,-cos) × (0,1,0) = (cos, 0, -sin)
    const rX =  Math.cos(yaw);
    const rZ = -Math.sin(yaw);

    const spd = _moveSpeed();
    // ly: -1 = forward push → negate to get positive forward movement
    player.position.x += (fX * (-ly) + rX * lx) * spd;
    player.position.z += (fZ * (-ly) + rZ * lx) * spd;

  } else {
    // ── Right stick: X = turn, Y = dolly zoom ────────────────────
    const rx = axes[2]; // turn: +1 = right
    const ry = axes[3]; // zoom: -1 = push up = zoom in (move closer)

    // Turn (snap or smooth, configurable)
    if (Math.abs(rx) > dz) {
      if (_smoothTurn()) {
        // Smooth: rotate continuously at turnSpeed rad/s
        player.rotation.y -= rx * _turnSpeed() * delta;
      } else {
        // Snap: single jump when stick crosses threshold, cooldown until released
        if (Math.abs(rx) > 0.7 && _snapCooled) {
          player.rotation.y += (rx > 0 ? -1 : 1) * _snapAngle();
          _snapCooled = false;
        } else if (Math.abs(rx) < 0.3) {
          _snapCooled = true;
        }
      }
    } else {
      if (!_smoothTurn()) _snapCooled = true; // reset snap when stick centered
    }

    // Dolly zoom: scale the player's XZ distance from model origin.
    // ry = -1 (push up) → zoom in → reduce distance (closer to model)
    // ry = +1 (push down) → zoom out → increase distance
    if (Math.abs(ry) > dz) {
      const pX = player.position.x;
      const pZ = player.position.z;
      const dist = Math.sqrt(pX * pX + pZ * pZ);

      const newDist = Math.max(_zoomMin(), Math.min(_zoomMax(), dist + ry * _zoomSpeed()));

      if (dist > 0.001) {
        const scale = newDist / dist;
        player.position.x = pX * scale;
        player.position.z = pZ * scale;
      } else {
        // If already at center, move backward in player-facing direction on zoom out
        const yaw = player.rotation.y;
        player.position.x -= Math.sin(yaw) * ry * _zoomSpeed();
        player.position.z -= Math.cos(yaw) * ry * _zoomSpeed();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Height adjustment
// ─────────────────────────────────────────────────────────────────

function _adjustHeight(player, delta, current, setOffset) {
  const next = Math.max(_heightMin(), Math.min(_heightMax(), current + delta));
  player.position.y += next - current;
  setOffset(next);
}

// ─────────────────────────────────────────────────────────────────
// Raycasting — controller pointer against VR panel
// ─────────────────────────────────────────────────────────────────

const _raycaster  = new THREE.Raycaster();
const _tempMatrix = new THREE.Matrix4();

function _updateRaycasting(controllers, panelState) {
  for (const ctrl of controllers) {
    const { controller, ray, dot } = ctrl;

    if (!panelState.visible) {
      ray.visible = false;
      dot.visible = false;
      continue;
    }

    _tempMatrix.identity().extractRotation(controller.matrixWorld);
    _raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    _raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_tempMatrix);

    const hits = _raycaster.intersectObject(panelState.mesh);

    if (hits.length > 0) {
      const { uv, point } = hits[0];
      const px = uv.x * TEX_W;
      const py = (1 - uv.y) * TEX_H;

      const prev = panelState.hoverId;
      panelState.hoverId = null;
      const btns = panelState.buttons || [];
      for (const btn of btns) {
        if (px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h) {
          panelState.hoverId = btn.id;
          break;
        }
      }
      if (panelState.hoverId !== prev) panelState.dirty = true;

      ray.visible = true;
      dot.visible = true;
      dot.position.copy(point);
      const hitDist = controller.worldToLocal(point.clone()).length();
      ray.geometry.setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -hitDist),
      ]);
    } else {
      if (panelState.hoverId !== null) { panelState.hoverId = null; panelState.dirty = true; }
      ray.visible = true;
      dot.visible = false;
      ray.geometry.setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -RAY_LENGTH),
      ]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Panel click dispatch
// ─────────────────────────────────────────────────────────────────

function _firePanelClick(ctrl, panelState, actions) {
  if (!panelState.visible || !panelState.hoverId) return;
  const id = panelState.hoverId;
  const vs = actions.getViewerState();

  switch (id) {
    case 'play':        actions.playAnim();                                     break;
    case 'pause':       actions.pauseAnim();                                    break;
    case 'rewind':      actions.rewindAnim();                                   break;
    case 'exp_down':    actions.setExposure(Math.max(0,  vs.exposure - 0.25)); break;
    case 'exp_up':      actions.setExposure(Math.min(4,  vs.exposure + 0.25)); break;
    case 'scale_down':  actions.scaleDown();                                    break;
    case 'scale_up':    actions.scaleUp();                                      break;
    case 'rot_x_neg':   actions.nudgeRotation('x', -90);                        break;
    case 'rot_x_pos':   actions.nudgeRotation('x',  90);                        break;
    case 'rot_y_neg':   actions.nudgeRotation('y', -90);                        break;
    case 'rot_y_pos':   actions.nudgeRotation('y',  90);                        break;
    case 'gfx_low':     actions.setGraphicsQuality('low');                      break;
    case 'gfx_med':     actions.setGraphicsQuality('medium');                   break;
    case 'gfx_high':    actions.setGraphicsQuality('high');                     break;
    case 'close_panel': actions.showPanel(false);                               break;
    case 'exit_vr':     actions.exitVR();                                       break;
  }
  panelState.dirty = true;
  _haptic(ctrl);
}

// ─────────────────────────────────────────────────────────────────
// Haptics (best-effort)
// ─────────────────────────────────────────────────────────────────

function _haptic(ctrl, ms = 40, intensity = 0.4) {
  try { ctrl.gamepad?.hapticActuators?.[0]?.pulse(intensity, ms); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
// Canvas rounded-rect utility
// ─────────────────────────────────────────────────────────────────

function _rrect(ctx, x, y, w, h, r, fill, stroke, lw) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
  if (fill)   { ctx.fillStyle = fill;    ctx.fill();   }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
}

// Legacy no-op kept for any external callers
export function setPanelRefs() {}
