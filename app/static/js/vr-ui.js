/**
 * vr-ui.js — WebXR VR module for the 3D model viewer.
 * Target: Meta Quest 3 (immersive-vr, 6DOF, dual controllers).
 *
 * ═══════════════════════════════════════════════════════════════
 * LOCOMOTION
 * ═══════════════════════════════════════════════════════════════
 *
 * Walk (left stick) is HEAD-relative on the horizontal plane:
 *   forward = where the headset is looking (flattened to XZ)
 *   strafe  = right vector from that yaw
 *
 * Snap/smooth turn still rotates the player rig (reference space).
 * OrbitControls must stay disabled while presenting so head pose
 * is not overwritten before we read it (see view.html render loop).
 *
 * CONTROL SCHEME
 *   Left stick X/Y  = walk relative to head look
 *   Right stick X   = snap turn (or smooth if VR_SMOOTH_TURN=1)
 *   Right stick Y   = dolly zoom (radial distance from model origin)
 *   Trigger         = click VR panel button
 *   Left X          = toggle VR panel
 *   Left Y          = play/pause animation
 *   Right A / B     = lower / raise height
 *
 * AXIS MAP (Quest 3 WebXR gamepad):
 *   axes[2] = thumbstick X  (-1=left, +1=right)
 *   axes[3] = thumbstick Y  (-1=forward push, +1=back)
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

const TEX_W          = 560;
const TEX_H          = 720;
const PANEL_WIDTH    = 0.50;                                    // metres wide
const PANEL_HEIGHT   = PANEL_WIDTH * (TEX_H / TEX_W);           // keep aspect
const PANEL_DISTANCE = 0.78;
const PANEL_Y_OFFSET = -0.02;
const RAY_LENGTH     = 8;

const PAD    = 16;
const GAP    = 8;
const BTN_H  = 40;
const FOOTER_Y = TEX_H - PAD - BTN_H;

let _panelTab = 'model';
let _blockPage = 0;
let _armDeleteRel = null;
let _lastSig = '';

/**
 * Build button rects + section y positions from current viewer state.
 * Animation row is omitted when the model has no clips so the panel
 * doesn't leave a dead gap under the title.
 */
function _viewerSig(vs) {
  const blocks = vs.blocks || [];
  const b = blocks.map((x) => `${x.rel}:${x.status}:${Math.round((x.progress || 0) * 20)}:${x.shown ? 1 : 0}`).join(',');
  const p = vs.position || {};
  const r = vs.rotation || {};
  return [
    vs.exposure, vs.modelScale, vs.graphicsQuality, vs.isPlaying, vs.hasAnimation,
    p.x, p.y, p.z, r.x, r.y, r.z,
    _panelTab, _blockPage, _armDeleteRel, b,
  ].join('|');
}

function _fmtPos(v) {
  const n = Number(v) || 0;
  return (Math.round(n * 10) / 10).toFixed(1);
}

function _buildLayout(vs) {
  const innerW = TEX_W - PAD * 2;
  const col3 = (innerW - GAP * 2) / 3;
  const col4 = (innerW - GAP * 3) / 4;
  const half = (innerW - GAP) / 2;
  const buttons = [];
  const sections = {};
  const blocks = vs.blocks || [];
  const hasBlocks = blocks.length > 0;
  if (!hasBlocks) _panelTab = 'model';

  let y = 64;

  if (hasBlocks) {
    sections.tabs = { y, h: 36 };
    buttons.push(
      { id: 'tab_model',  label: 'Model',  x: PAD,           y, w: half, h: 36, active: _panelTab === 'model' },
      { id: 'tab_blocks', label: 'Blocks', x: PAD + half + GAP, y, w: half, h: 36, active: _panelTab === 'blocks' },
    );
    y += 36 + 14;
  }

  if (_panelTab === 'blocks' && hasBlocks) {
    _layoutBlocks(vs, buttons, sections, y, innerW, half);
  } else {
    _layoutModel(vs, buttons, sections, y, innerW, col3, col4);
  }

  buttons.push(
    { id: 'close_panel', label: 'Hide panel', x: PAD, y: FOOTER_Y, w: half, h: BTN_H },
    { id: 'exit_vr', label: 'Exit VR', x: PAD + half + GAP, y: FOOTER_Y, w: half, h: BTN_H, danger: true },
  );
  sections.footerY = FOOTER_Y - 6;

  return { buttons, sections, hasBlocks };
}

function _layoutModel(vs, buttons, sections, y, innerW, col3, col4) {
  if (vs.hasAnimation) {
    sections.animLabelY = y;
    y += 16;
    buttons.push(
      { id: 'play',   label: '▶  Play',   x: PAD,                  y, w: col3, h: BTN_H },
      { id: 'pause',  label: '⏸  Pause',  x: PAD + col3 + GAP,     y, w: col3, h: BTN_H },
      { id: 'rewind', label: '⏮  Rewind', x: PAD + (col3 + GAP) * 2, y, w: col3, h: BTN_H },
    );
    y += BTN_H + 12;
  }

  sections.expLabelY = y;
  y += 16;
  const expBtnW = 64;
  sections.expBar = { x: PAD + expBtnW + GAP, y, w: innerW - expBtnW * 2 - GAP * 2, h: BTN_H };
  buttons.push(
    { id: 'exp_down', label: '☀ −', x: PAD, y, w: expBtnW, h: BTN_H },
    { id: 'exp_up',   label: '☀ +', x: PAD + innerW - expBtnW, y, w: expBtnW, h: BTN_H },
  );
  y += BTN_H + 12;

  sections.scaleLabelY = y;
  y += 16;
  const scBtnW = 92;
  sections.scaleBar = { x: PAD + scBtnW + GAP, y, w: innerW - scBtnW * 2 - GAP * 2, h: BTN_H };
  buttons.push(
    { id: 'scale_down', label: '⊖ Scale', x: PAD, y, w: scBtnW, h: BTN_H },
    { id: 'scale_up',   label: '⊕ Scale', x: PAD + innerW - scBtnW, y, w: scBtnW, h: BTN_H },
  );
  y += BTN_H + 12;

  sections.rotLabelY = y;
  y += 16;
  buttons.push(
    { id: 'rot_x_neg', label: 'X −90°', x: PAD,                   y, w: col4, h: BTN_H },
    { id: 'rot_x_pos', label: 'X +90°', x: PAD + col4 + GAP,      y, w: col4, h: BTN_H },
    { id: 'rot_y_neg', label: 'Y −90°', x: PAD + (col4 + GAP) * 2, y, w: col4, h: BTN_H },
    { id: 'rot_y_pos', label: 'Y +90°', x: PAD + (col4 + GAP) * 3, y, w: col4, h: BTN_H },
  );
  y += BTN_H + 12;

  const pos = vs.position || { x: 0, y: 0, z: 0 };
  sections.posLabel = `POSITION   ${_fmtPos(pos.x)}   ${_fmtPos(pos.y)}   ${_fmtPos(pos.z)}`;
  sections.posLabelY = y;
  y += 16;
  const col6 = (innerW - GAP * 5) / 6;
  const axes = [
    ['pos_x_neg', 'X −'], ['pos_x_pos', 'X +'],
    ['pos_y_neg', 'Y −'], ['pos_y_pos', 'Y +'],
    ['pos_z_neg', 'Z −'], ['pos_z_pos', 'Z +'],
  ];
  axes.forEach(([id, label], i) => {
    buttons.push({ id, label, x: PAD + i * (col6 + GAP), y, w: col6, h: BTN_H });
  });
  y += BTN_H + 8;
  buttons.push({ id: 'pos_reset', label: 'Reset position', x: PAD, y, w: innerW, h: 34 });
  y += 34 + 12;

  sections.gfxLabelY = y;
  y += 16;
  buttons.push(
    { id: 'gfx_low',  label: 'Low',  x: PAD,                   y, w: col3, h: BTN_H },
    { id: 'gfx_med',  label: 'Med',  x: PAD + col3 + GAP,      y, w: col3, h: BTN_H },
    { id: 'gfx_high', label: 'High', x: PAD + (col3 + GAP) * 2, y, w: col3, h: BTN_H },
  );
}

function _layoutBlocks(vs, buttons, sections, y, innerW, half) {
  const blocks = vs.blocks || [];
  const finished = blocks.filter((b) => b.status === 'ready' || b.status === 'shown').length;
  const allShown = finished > 0 && blocks.filter((b) => b.status === 'ready' || b.status === 'shown').every((b) => b.shown);
  const pending = blocks.some((b) => b.status === 'idle' || b.status === 'error');
  sections.blockLabel = `BLOCKS   ${finished}/${blocks.length}`;
  sections.blockLabelY = y;
  y += 18;
  buttons.push(
    { id: 'ply:download-all', label: 'Download all', x: PAD, y, w: half, h: BTN_H, dim: !pending },
    { id: 'ply:show-all', label: allShown ? 'Hide all' : 'Show all', x: PAD + half + GAP, y, w: half, h: BTN_H, dim: finished === 0, active: allShown },
  );
  y += BTN_H + 10;

  const rowH = 48;
  const pagerH = 32;
  const listBottom = FOOTER_Y - 16;
  const room = listBottom - y - pagerH - 8;
  const perPage = Math.max(4, Math.floor(room / (rowH + 6)));
  const pages = Math.max(1, Math.ceil(blocks.length / perPage));
  if (_blockPage >= pages) _blockPage = pages - 1;
  if (_blockPage < 0) _blockPage = 0;
  const slice = blocks.slice(_blockPage * perPage, _blockPage * perPage + perPage);

  sections.rows = [];
  for (const block of slice) {
    const actionW = 78;
    const toggleW = 64;
    const toggle = {
      id: `ply:toggle:${block.rel}`,
      label: block.shown ? 'Hide' : 'Show',
      x: PAD + 6,
      y: y + 6,
      w: toggleW,
      h: rowH - 12,
      enabled: block.status === 'ready' || block.status === 'shown',
      active: !!block.shown,
    };
    const busy = block.status === 'queued' || block.status === 'loading' || block.status === 'preparing';
    const armed = _armDeleteRel === block.rel;
    let actionLabel = 'Get';
    let danger = false;
    let cmd = 'download';
    if (busy) { actionLabel = 'Stop'; danger = true; cmd = 'cancel'; }
    else if (block.status === 'ready' || block.status === 'shown') {
      actionLabel = armed ? 'Sure?' : 'Del';
      danger = true;
      cmd = 'delete';
    }
    const action = {
      id: `ply:${cmd}:${block.rel}`,
      label: actionLabel,
      x: PAD + innerW - actionW - 6,
      y: y + 6,
      w: actionW,
      h: rowH - 12,
      danger,
      custom: true,
    };
    sections.rows.push({
      x: PAD, y, w: innerW, h: rowH,
      label: block.label,
      status: block.status,
      progress: block.progress || 0,
      shown: !!block.shown,
      toggle, action,
    });
    if (toggle.enabled) buttons.push({ ...toggle, custom: true });
    buttons.push(action);
    y += rowH + 6;
  }

  sections.pagerY = listBottom - pagerH;
  if (pages > 1) {
    buttons.push(
      { id: 'ply_page_prev', label: 'Prev', x: PAD, y: sections.pagerY, w: 90, h: pagerH, dim: _blockPage === 0 },
      { id: 'ply_page_next', label: 'Next', x: PAD + innerW - 90, y: sections.pagerY, w: 90, h: pagerH, dim: _blockPage >= pages - 1 },
    );
    sections.pagerLabel = `${_blockPage + 1} / ${pages}`;
  }
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
    scaleUp, scaleDown, setModelScale, nudgeRotation, nudgePosition, resetPosition,
    setGraphicsQuality, plyCommand,
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
    nudgePosition: nudgePosition || (() => {}),
    resetPosition: resetPosition || (() => {}),
    plyCommand: plyCommand || (() => {}),
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

    // Snap/turn first, then walk — so left stick uses the updated yaw this frame
    for (const ctrl of controllers) {
      if (ctrl.gamepad && ctrl.hand === 'right') {
        _handleLocomotion(ctrl, player, camera, renderer, delta);
      }
    }
    for (const ctrl of controllers) {
      if (ctrl.gamepad && ctrl.hand === 'left') {
        _handleLocomotion(ctrl, player, camera, renderer, delta);
      }
    }

    _updateRaycasting(controllers, panelState);

    if (panelState.visible) {
      const vs = getViewerState();
      const sig = _viewerSig(vs);
      if (sig !== _lastSig) {
        _lastSig = sig;
        panelState.dirty = true;
      }
      if (panelState.dirty) _repaintPanel(panelState, vs);
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
  const gq = vs.graphicsQuality || 'medium';
  const rot = vs.rotation || { x: 0, y: 0, z: 0 };

  ctx.clearRect(0, 0, W, TEX_H);
  _rrect(ctx, 0, 0, W, TEX_H, 22, 'rgba(15,17,30,0.94)');
  _rrect(ctx, 1, 1, W - 2, TEX_H - 2, 21, null, 'rgba(80,70,180,0.45)', 1.5);

  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 20px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ModelSpace', W / 2, 32);

  ctx.fillStyle = 'rgba(124,130,160,0.7)';
  ctx.font = '11px system-ui,sans-serif';
  ctx.fillText('Trigger selects  ·  X menu  ·  sticks move', W / 2, 50);

  ctx.textAlign = 'left';
  ctx.font = '11px system-ui,sans-serif';
  ctx.fillStyle = '#7c82a0';

  if (sections.animLabelY) ctx.fillText('ANIMATION', PAD, sections.animLabelY);
  if (sections.expLabelY) ctx.fillText('EXPOSURE', PAD, sections.expLabelY);
  if (sections.scaleLabelY) ctx.fillText('SCALE', PAD, sections.scaleLabelY);
  if (sections.rotLabelY) {
    ctx.fillText(
      `ROTATION   ${Math.round(rot.x || 0)}°   ${Math.round(rot.y || 0)}°   ${Math.round(rot.z || 0)}°`,
      PAD, sections.rotLabelY,
    );
  }
  if (sections.posLabelY) ctx.fillText(sections.posLabel, PAD, sections.posLabelY);
  if (sections.gfxLabelY) {
    const gfxHint = gq === 'low' ? 'smoother' : gq === 'high' ? 'sharper' : 'balanced';
    ctx.fillText(`GRAPHICS  ·  ${gfxHint}`, PAD, sections.gfxLabelY);
  }
  if (sections.blockLabelY) ctx.fillText(sections.blockLabel, PAD, sections.blockLabelY);

  if (sections.expBar) _paintValueBar(ctx, sections.expBar, Math.min(Math.max(Number(vs.exposure) / 4, 0), 1), '#6c63ff', Number(vs.exposure).toFixed(2));
  if (sections.scaleBar) {
    const sFrac = vs.modelScale > 1 ? Math.min(Math.log10(vs.modelScale) / Math.log10(500), 1) : 0;
    const sLabel = vs.modelScale
      ? (vs.modelScale < 0.1 ? vs.modelScale.toFixed(3) : vs.modelScale.toFixed(2)) + '×'
      : '—';
    _paintValueBar(ctx, sections.scaleBar, sFrac, '#4caf81', sLabel);
  }

  for (const row of sections.rows || []) _paintBlockRow(ctx, row, hoverId);

  for (const btn of layout.buttons) {
    if (btn.custom) continue;
    _paintBtn(ctx, btn, hoverId, gq);
  }

  if (sections.pagerLabel) {
    ctx.fillStyle = '#e8eaf0';
    ctx.font = '13px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(sections.pagerLabel, W / 2, sections.pagerY + 21);
  }

  ctx.fillStyle = 'rgba(124,130,160,0.75)';
  ctx.font = '12px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(vs.isPlaying ? '▶  Playing' : '⏸  Paused', W / 2, sections.footerY);

  texture.needsUpdate = true;
  state.dirty = false;
}

function _paintValueBar(ctx, bar, frac, color, label) {
  _rrect(ctx, bar.x, bar.y, bar.w, bar.h, 10, 'rgba(46,50,72,0.9)');
  if (frac > 0) _rrect(ctx, bar.x + 3, bar.y + 3, Math.max(0, (bar.w - 6) * frac), bar.h - 6, 8, color);
  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 14px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, bar.x + bar.w / 2, bar.y + bar.h / 2 + 5);
}

function _paintBtn(ctx, btn, hoverId, gq) {
  const hov = btn.id === hoverId;
  const gfxActive =
    (btn.id === 'gfx_low' && gq === 'low') ||
    (btn.id === 'gfx_med' && gq === 'medium') ||
    (btn.id === 'gfx_high' && gq === 'high');
  const active = hov || gfxActive || !!btn.active;
  let fill = active ? '#6c63ff' : 'rgba(36,39,54,0.95)';
  let stroke = active ? '#9088ff' : 'rgba(80,84,120,0.55)';
  if (btn.danger) {
    fill = hov ? '#c44a4a' : 'rgba(120,36,36,0.95)';
    stroke = hov ? '#ff8888' : 'rgba(180,80,80,0.65)';
  }
  if (btn.dim && !hov) {
    fill = 'rgba(28,30,42,0.7)';
    stroke = 'rgba(70,74,100,0.35)';
  }
  _rrect(ctx, btn.x, btn.y, btn.w, btn.h, 10, fill, stroke, 1.5);
  ctx.fillStyle = btn.dim && !hov ? 'rgba(232,234,240,0.45)' : '#e8eaf0';
  ctx.font = `${active || (btn.danger && hov) ? 'bold ' : ''}13px system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 5);
}

function _blockStatusText(row) {
  if (row.status === 'queued') return 'Waiting';
  if (row.status === 'loading') return `${Math.round((row.progress || 0) * 100)}%`;
  if (row.status === 'preparing') return 'Preparing';
  if (row.status === 'shown') return 'Visible';
  if (row.status === 'ready') return 'Ready';
  if (row.status === 'error') return 'Failed';
  return 'Not downloaded';
}

function _paintBlockRow(ctx, row, hoverId) {
  const stroke = row.shown ? 'rgba(108,99,255,0.75)' : 'rgba(80,84,120,0.45)';
  const fill = row.shown ? 'rgba(108,99,255,0.14)' : 'rgba(20,22,34,0.85)';
  _rrect(ctx, row.x, row.y, row.w, row.h, 10, fill, stroke, 1.5);

  const nameX = row.toggle.x + row.toggle.w + 8;
  const nameW = row.action.x - nameX - 8;
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px system-ui,sans-serif';
  ctx.fillStyle = '#e8eaf0';
  ctx.fillText(_fitText(ctx, row.label, nameW), nameX, row.y + 20);

  ctx.font = '11px system-ui,sans-serif';
  const confirming = row.action.label === 'Sure?';
  ctx.fillStyle = confirming || row.status === 'error' ? '#e05c5c' : row.status === 'ready' ? '#4caf81' : '#7c82a0';
  ctx.fillText(
    confirming ? _fitText(ctx, 'Confirm delete — must redownload', nameW) : _blockStatusText(row),
    nameX,
    row.y + 36,
  );

  if (!row.toggle.enabled) {
    _rrect(ctx, row.toggle.x, row.toggle.y, row.toggle.w, row.toggle.h, 8, 'rgba(20,22,32,0.6)', 'rgba(70,74,100,0.35)', 1);
    ctx.fillStyle = 'rgba(232,234,240,0.35)';
    ctx.font = '12px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Show', row.toggle.x + row.toggle.w / 2, row.toggle.y + row.toggle.h / 2 + 4);
  }
  _paintBtn(ctx, row.action, hoverId, '');
  if (row.toggle.enabled) _paintBtn(ctx, row.toggle, hoverId, '');
}

function _fitText(ctx, text, maxW) {
  const raw = String(text || '');
  if (ctx.measureText(raw).width <= maxW) return raw;
  let t = raw;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
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
// Locomotion — head-relative walk + snap turn (Quest-style)
//
// IMPORTANT (Three.js WebXR):
//   renderer.xr.getCamera() (cameraXR) has parent=null. Its matrix is the
//   headset pose in the XR reference space. During render(), Three.js does
//   matrixWorld = player.matrixWorld * xr.matrix so SNAP on `player` turns
//   the view — but getWorldDirection(cameraXR) ignores `player` entirely.
//
//   Walk must apply player.quaternion (snap/smooth turn) on top of the
//   headset forward, or stick directions feel rotated after every snap.
// ─────────────────────────────────────────────────────────────────

const _headForward = new THREE.Vector3();
const _headRight   = new THREE.Vector3();
const _worldUp     = new THREE.Vector3(0, 1, 0);

function _getWalkAxes(renderer, camera, player) {
  const xrCam = renderer.xr.getCamera?.() || camera;

  // Headset look in XR reference space (rotation only)
  _headForward.set(0, 0, -1).transformDirection(xrCam.matrix);
  _headForward.y = 0;
  if (_headForward.lengthSq() < 1e-8) {
    _headForward.set(0, 0, -1);
  } else {
    _headForward.normalize();
  }

  // Apply rig / snap-turn yaw (player is the dolly)
  player.updateMatrixWorld(true);
  _headForward.applyQuaternion(player.quaternion);
  _headForward.y = 0;
  if (_headForward.lengthSq() < 1e-8) {
    const yaw = player.rotation.y;
    _headForward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  } else {
    _headForward.normalize();
  }

  // right-handed Y-up: right = forward × up
  _headRight.crossVectors(_headForward, _worldUp).normalize();
  return { forward: _headForward, right: _headRight };
}

function _handleLocomotion(ctrl, player, camera, renderer, delta) {
  const axes = ctrl.gamepad?.axes;
  if (!axes || axes.length < 4) return;

  const dz = _deadzone();
  const frameScale = Math.min(Math.max(delta * 72, 0.25), 2.5);

  if (ctrl.hand === 'left') {
    const lx = axes[2]; // -1 left, +1 right
    const ly = axes[3]; // -1 forward push, +1 back

    if (Math.abs(lx) <= dz && Math.abs(ly) <= dz) return;

    const { forward, right } = _getWalkAxes(renderer, camera, player);
    const spd = _moveSpeed() * frameScale;
    player.position.x += (forward.x * (-ly) + right.x * lx) * spd;
    player.position.z += (forward.z * (-ly) + right.z * lx) * spd;

  } else {
    const rx = axes[2];
    const ry = axes[3];

    if (Math.abs(rx) > dz) {
      if (_smoothTurn()) {
        player.rotation.y -= rx * _turnSpeed() * delta;
      } else if (Math.abs(rx) > 0.7 && _snapCooled) {
        player.rotation.y -= Math.sign(rx) * _snapAngle();
        _snapCooled = false;
      } else if (Math.abs(rx) < 0.3) {
        _snapCooled = true;
      }
    } else if (!_smoothTurn()) {
      _snapCooled = true;
    }

    if (Math.abs(ry) > dz) {
      const pX = player.position.x;
      const pZ = player.position.z;
      const dist = Math.sqrt(pX * pX + pZ * pZ);
      const zoomStep = ry * _zoomSpeed() * frameScale;
      const newDist = Math.max(_zoomMin(), Math.min(_zoomMax(), dist + zoomStep));

      if (dist > 0.001) {
        const scale = newDist / dist;
        player.position.x = pX * scale;
        player.position.z = pZ * scale;
      } else {
        const { forward } = _getWalkAxes(renderer, camera, player);
        player.position.x -= forward.x * zoomStep;
        player.position.z -= forward.z * zoomStep;
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

  if (id === 'tab_model' || id === 'tab_blocks') {
    _panelTab = id === 'tab_blocks' ? 'blocks' : 'model';
    _armDeleteRel = null;
  } else if (id === 'ply_page_prev') {
    _blockPage = Math.max(0, _blockPage - 1);
    _armDeleteRel = null;
  } else if (id === 'ply_page_next') {
    _blockPage += 1;
    _armDeleteRel = null;
  } else if (id.startsWith('ply:')) {
    const parts = id.split(':');
    const cmd = parts[1];
    const rel = parts.slice(2).join(':');
    if (cmd === 'delete' && _armDeleteRel !== rel) {
      _armDeleteRel = rel;
    } else {
      if (cmd === 'delete') _armDeleteRel = null;
      else _armDeleteRel = null;
      actions.plyCommand(cmd, rel);
    }
  } else {
    _armDeleteRel = null;
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
      case 'pos_x_neg':   actions.nudgePosition('x', -0.5);                       break;
      case 'pos_x_pos':   actions.nudgePosition('x',  0.5);                       break;
      case 'pos_y_neg':   actions.nudgePosition('y', -0.5);                       break;
      case 'pos_y_pos':   actions.nudgePosition('y',  0.5);                       break;
      case 'pos_z_neg':   actions.nudgePosition('z', -0.5);                       break;
      case 'pos_z_pos':   actions.nudgePosition('z',  0.5);                       break;
      case 'pos_reset':   actions.resetPosition();                                break;
      case 'gfx_low':     actions.setGraphicsQuality('low');                      break;
      case 'gfx_med':     actions.setGraphicsQuality('medium');                   break;
      case 'gfx_high':    actions.setGraphicsQuality('high');                     break;
      case 'close_panel': actions.showPanel(false);                               break;
      case 'exit_vr':     actions.exitVR();                                       break;
      default: break;
    }
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
