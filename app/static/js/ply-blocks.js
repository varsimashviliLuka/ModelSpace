/**
 * Textured binary PLY blocks (photogrammetry style).
 *
 * Expected layout (binary little-endian):
 *   comment TextureFile <name>
 *   element vertex N
 *     property float x/y/z
 *   element face M
 *     property list uchar uint vertex_indices   (3)
 *     property list uchar float texcoord        (6 = u,v per corner)
 *     property int texnumber
 *
 * Each file becomes one or more meshes (one material per texture index).
 */

const _PROP_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function _headerEnd(bytes) {
  const marker = 'end_header\n';
  const limit = Math.min(bytes.length, 65536);
  let text = '';
  for (let i = 0; i < limit; i++) {
    text += String.fromCharCode(bytes[i]);
    if (text.endsWith(marker)) return { text, offset: i + 1 };
    if (text.endsWith('end_header\r\n')) return { text, offset: i + 1 };
  }
  throw new Error('PLY header not found');
}

function _parseHeader(headerText) {
  if (!/format\s+binary_little_endian/i.test(headerText)) {
    throw new Error('Only binary little-endian PLY is supported');
  }
  const textures = [];
  const elements = [];
  let current = null;
  for (const raw of headerText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'ply' || line.startsWith('format') || line === 'end_header') continue;
    if (line.toLowerCase().startsWith('comment texturefile')) {
      const name = line.split(/\s+/).slice(2).join(' ').trim();
      if (name) textures.push(name.replace(/\\/g, '/').split('/').pop());
      continue;
    }
    if (line.startsWith('comment') || line.startsWith('obj_info')) continue;
    const el = line.match(/^element\s+(\w+)\s+(\d+)/i);
    if (el) {
      current = { name: el[1], count: Number(el[2]), props: [] };
      elements.push(current);
      continue;
    }
    const list = line.match(/^property\s+list\s+(\w+)\s+(\w+)\s+(\w+)/i);
    if (list && current) {
      current.props.push({
        list: true,
        countType: list[1].toLowerCase(),
        itemType: list[2].toLowerCase(),
        name: list[3],
      });
      continue;
    }
    const prop = line.match(/^property\s+(\w+)\s+(\w+)/i);
    if (prop && current) {
      current.props.push({ list: false, type: prop[1].toLowerCase(), name: prop[2] });
    }
  }
  const vertex = elements.find((e) => e.name === 'vertex');
  const face = elements.find((e) => e.name === 'face');
  if (!vertex || !face) throw new Error('PLY is missing vertex or face data');
  return { textures, vertex, face };
}

function _vertexStride(vertex) {
  let stride = 0;
  for (const p of vertex.props) {
    if (p.list) throw new Error('List properties on vertices are not supported');
    const sz = _PROP_SIZE[p.type];
    if (!sz) throw new Error(`Unsupported vertex property type: ${p.type}`);
    stride += sz;
  }
  return stride;
}

function _xyzOffset(vertex) {
  let off = 0;
  const found = {};
  for (const p of vertex.props) {
    if (p.name === 'x' || p.name === 'y' || p.name === 'z') found[p.name] = off;
    off += _PROP_SIZE[p.type];
  }
  if (found.x == null || found.y == null || found.z == null) {
    throw new Error('PLY vertices need x/y/z');
  }
  return found;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ textures: string[], groups: Map<number, { positions: Float32Array, uvs: Float32Array }> }}
 */
export function parseTexturedPly(buffer) {
  const bytes = new Uint8Array(buffer);
  const { text, offset } = _headerEnd(bytes);
  const { textures, vertex, face } = _parseHeader(text);
  const stride = _vertexStride(vertex);
  const xyz = _xyzOffset(vertex);
  const view = new DataView(buffer);

  const indexProp = face.props.find((p) => p.list && /vertex_ind/i.test(p.name));
  const uvProp = face.props.find((p) => p.list && /texcoord/i.test(p.name));
  const texProp = face.props.find((p) => !p.list && /texnumber/i.test(p.name));
  if (!indexProp || !uvProp || !texProp) {
    throw new Error('PLY faces need vertex_indices, texcoord, and texnumber');
  }

  let o = offset + vertex.count * stride;
  const counts = new Map();

  // Pass 1 — count corners per texture so we can allocate once.
  let cursor = o;
  for (let f = 0; f < face.count; f++) {
    const nIdx = bytes[cursor];
    cursor += 1 + nIdx * 4;
    const nUv = bytes[cursor];
    cursor += 1 + nUv * 4;
    const tex = view.getInt32(cursor, true);
    cursor += 4;
    counts.set(tex, (counts.get(tex) || 0) + nIdx);
  }

  const buckets = new Map();
  for (const [tex, n] of counts) {
    buckets.set(tex, {
      positions: new Float32Array(n * 3),
      uvs: new Float32Array(n * 2),
      write: 0,
    });
  }

  // Pass 2 — expand corners (UVs are per-corner, so vertices are not shared).
  for (let f = 0; f < face.count; f++) {
    const nIdx = bytes[o++];
    const idx = new Array(nIdx);
    for (let i = 0; i < nIdx; i++) {
      idx[i] = view.getUint32(o, true);
      o += 4;
    }
    const nUv = bytes[o++];
    const uv = new Array(nUv);
    for (let i = 0; i < nUv; i++) {
      uv[i] = view.getFloat32(o, true);
      o += 4;
    }
    const tex = view.getInt32(o, true);
    o += 4;
    const bucket = buckets.get(tex);
    let w = bucket.write;
    for (let i = 0; i < nIdx; i++) {
      const base = offset + idx[i] * stride;
      bucket.positions[w * 3]     = view.getFloat32(base + xyz.x, true);
      bucket.positions[w * 3 + 1] = view.getFloat32(base + xyz.y, true);
      bucket.positions[w * 3 + 2] = view.getFloat32(base + xyz.z, true);
      bucket.uvs[w * 2]     = uv[i * 2] ?? 0;
      bucket.uvs[w * 2 + 1] = uv[i * 2 + 1] ?? 0;
      w += 1;
    }
    bucket.write = w;
  }

  return { textures, groups: buckets };
}

/**
 * Build a THREE.Group of textured meshes from one PLY block.
 * @param {typeof import('three')} THREE
 * @param {ArrayBuffer} buffer
 * @param {(fileName: string) => string} urlForTexture basename → absolute URL
 */
export function buildPlyBlock(THREE, buffer, urlForTexture) {
  const { textures, groups } = parseTexturedPly(buffer);
  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();
  const cache = new Map();

  function textureFor(index) {
    const name = textures[index];
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    const tex = loader.load(urlForTexture(name));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    cache.set(name, tex);
    return tex;
  }

  for (const [texIndex, bucket] of groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(bucket.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(bucket.uvs, 2));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: textureFor(texIndex),
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}
